"""Scoped recovery actions for escalated runner stages."""

from datetime import datetime

from sqlalchemy import select

from helpers import approved_request

from app.db import SessionLocal
from app.models import AuditEvent, Request


def _operator(client, name: str, email: str) -> dict:
    return client.post(
        "/api/operators",
        json={"name": name, "initials": "SR", "hue": "#6E5A8A", "email": email},
    ).json()


def _escalate(request_id: int, *, stage: str, sim_step: int = 2) -> datetime:
    with SessionLocal() as db:
        row = db.get(Request, request_id)
        row.stage = stage
        row.sim_step = sim_step
        row.needs_human = True
        row.needs_human_reason = "Runner stopped"
        before = row.stage_entered_at
        db.commit()
        return before


def _audit_count(request_id: int, action: str) -> int:
    with SessionLocal() as db:
        return len(list(db.scalars(select(AuditEvent).where(
            AuditEvent.request_id == request_id,
            AuditEvent.action == action,
        ))))


def _assert_conflict(response, *, actor: str, state: str) -> None:
    assert response.status_code == 409, response.text
    assert response.json()["acted_by"] == actor
    assert response.json()["acted_at"]
    assert response.json()["resulting_state"] == state


def test_take_over_wins_stops_tick_and_remains_visible_on_floor(client):
    operator = _operator(client, "Riley Human", "riley.human@example.com")
    request = approved_request(client, title="Finish this by hand")
    _escalate(request["id"], stage="build", sim_step=3)

    response = client.post(
        f"/api/requests/{request['id']}/take-over",
        json={"operator_id": operator["id"], "note": "I will finish the PR"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "human_owned"
    assert response.json()["needs_human"] is False
    client.post("/api/simulator/tick")
    unchanged = client.get(f"/api/requests/{request['id']}").json()
    assert unchanged["stage"] == "build"
    assert unchanged["status"] == "human_owned"
    assert unchanged["run"] is None
    mission = client.get("/api/mission").json()
    owned = next(item for item in mission["human_owned"] if item["request"]["id"] == request["id"])
    assert owned["taken_over_by"] == "Riley Human"
    events = client.get("/api/events", params={"request_id": request["id"]}).json()
    assert any(
        event["kind"] == "recovery_action"
        and event["title"] == "Taken over by Riley Human — finishing by hand"
        for event in events
    )


def test_take_over_has_one_winner_conflict_and_self_replay(client):
    winner = _operator(client, "Riley Takeover", "riley.takeover@example.com")
    loser = _operator(client, "Morgan Takeover", "morgan.takeover@example.com")
    request = approved_request(client, title="Take-over race")
    _escalate(request["id"], stage="review")

    first = client.post(
        f"/api/requests/{request['id']}/take-over", json={"operator_id": winner["id"]}
    )
    assert first.status_code == 200
    _assert_conflict(
        client.post(
            f"/api/requests/{request['id']}/take-over", json={"operator_id": loser["id"]}
        ),
        actor="Riley Takeover",
        state="human_owned",
    )
    replay = client.post(
        f"/api/requests/{request['id']}/take-over", json={"operator_id": winner["id"]}
    )
    assert replay.status_code == 200
    assert _audit_count(request["id"], "taken_over") == 1


def test_send_back_to_stage_restarts_earlier_stage_with_reason_and_fresh_clock(client):
    operator = _operator(client, "Riley Rewind", "riley.rewind@example.com")
    request = approved_request(client, title="Redo the plan")
    before = _escalate(request["id"], stage="review", sim_step=2)

    response = client.post(
        f"/api/requests/{request['id']}/send-back-to-stage",
        json={
            "operator_id": operator["id"],
            "stage": "architecture",
            "reason": "The data boundary changed",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["stage"] == "architecture"
    assert body["status"] == "approved"
    assert body["needs_human"] is False
    assert datetime.fromisoformat(body["stage_entered_at"]) > before.replace(tzinfo=None)
    events = client.get("/api/events", params={"request_id": request["id"]}).json()
    recovery = next(event for event in events if event["kind"] == "recovery_action")
    assert "Architecture" in recovery["title"]
    assert recovery["body"] == "The data boundary changed"
    with SessionLocal() as db:
        row = db.get(Request, request["id"])
        assert row.sim_step == 0
        audit = db.scalar(select(AuditEvent).where(
            AuditEvent.request_id == request["id"],
            AuditEvent.action == "sent_back_to_stage",
        ))
        assert audit.note == "The data boundary changed"
        assert audit.operator_id == operator["id"]


def test_send_back_to_stage_rejects_invalid_same_and_forward_targets(client):
    for target in ("spec", "deploy", "review"):
        request = approved_request(client, title=f"Invalid rewind {target}")
        _escalate(request["id"], stage="review")
        response = client.post(
            f"/api/requests/{request['id']}/send-back-to-stage",
            json={"operator_id": 1, "stage": target, "reason": "Try it"},
        )
        assert response.status_code == 400, (target, response.text)

    request = approved_request(client, title="Forward rewind")
    _escalate(request["id"], stage="build")
    response = client.post(
        f"/api/requests/{request['id']}/send-back-to-stage",
        json={"operator_id": 1, "stage": "review", "reason": "Skip ahead"},
    )
    assert response.status_code == 400, response.text


def test_send_back_to_stage_has_one_winner_conflict_and_self_replay(client):
    winner = _operator(client, "Riley Stage", "riley.stage@example.com")
    loser = _operator(client, "Morgan Stage", "morgan.stage@example.com")
    request = approved_request(client, title="Stage rewind race")
    _escalate(request["id"], stage="review")
    body = {"operator_id": winner["id"], "stage": "build", "reason": "Redo tests"}

    first = client.post(f"/api/requests/{request['id']}/send-back-to-stage", json=body)
    assert first.status_code == 200
    _assert_conflict(
        client.post(
            f"/api/requests/{request['id']}/send-back-to-stage",
            json={"operator_id": loser["id"], "stage": "architecture", "reason": "Redo plan"},
        ),
        actor="Riley Stage",
        state="approved",
    )
    replay = client.post(f"/api/requests/{request['id']}/send-back-to-stage", json=body)
    assert replay.status_code == 200
    assert _audit_count(request["id"], "sent_back_to_stage") == 1
