"""Compare-and-set behavior for every state-changing console action."""

from helpers import approved_request, submitted_request
from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditEvent, Request


def _operator(client, name: str, email: str) -> dict:
    return client.post(
        "/api/operators",
        json={"name": name, "initials": "RO", "hue": "#8A641D", "email": email},
    ).json()


def _audits(request_id: int, action: str) -> list[AuditEvent]:
    with SessionLocal() as db:
        return list(
            db.scalars(
                select(AuditEvent).where(
                    AuditEvent.request_id == request_id, AuditEvent.action == action
                )
            )
        )


def _assert_conflict(response, winner: str, resulting_state: str) -> None:
    assert response.status_code == 409, response.text
    assert response.json() | {"detail": response.json()["detail"]} == response.json()
    assert response.json()["acted_by"] == winner
    assert response.json()["acted_at"]
    assert response.json()["resulting_state"] == resulting_state


def test_spec_approve_has_one_winner_conflict_and_self_replay(client):
    winner = _operator(client, "Riley Spec", "riley.spec@example.com")
    # Display names are not identity: a different operator row with the same
    # name must still lose with 409 rather than being mistaken for a self-replay.
    loser = _operator(client, "Riley Spec", "morgan.spec@example.com")
    request = submitted_request(client, title="Spec approval race")

    first = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": winner["id"]}
    )
    assert first.status_code == 200
    assert first.json()["status"] == "approved"
    _assert_conflict(
        client.post(
            f"/api/requests/{request['id']}/approve", json={"operator_id": loser["id"]}
        ),
        "Riley Spec",
        "approved",
    )
    replay = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": winner["id"]}
    )
    assert replay.status_code == 200
    assert len(_audits(request["id"], "approved")) == 1


def test_merge_approve_has_one_winner_conflict_and_self_replay(client):
    winner = _operator(client, "Riley Merge", "riley.merge@example.com")
    loser = _operator(client, "Morgan Merge", "morgan.merge@example.com")
    request = approved_request(client, title="Merge approval race")
    with SessionLocal() as db:
        row = db.get(Request, request["id"])
        row.stage, row.gate = "review", "approve_merge"
        db.commit()

    first = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": winner["id"]}
    )
    assert first.status_code == 200
    assert first.json()["status"] == "done"
    _assert_conflict(
        client.post(
            f"/api/requests/{request['id']}/approve", json={"operator_id": loser["id"]}
        ),
        "Riley Merge",
        "done",
    )
    assert client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": winner["id"]}
    ).status_code == 200
    assert len(_audits(request["id"], "approved_merge")) == 1
    events = client.get("/api/events", params={"request_id": request["id"]}).json()
    assert len([event for event in events if event["title"].startswith("Deployed")]) == 1


def test_send_back_has_one_winner_conflict_and_self_replay(client):
    winner = _operator(client, "Riley Return", "riley.return@example.com")
    loser = _operator(client, "Morgan Return", "morgan.return@example.com")
    request = submitted_request(client, title="Send-back race")
    body = {"note": "Clarify the scope", "operator_id": winner["id"]}

    first = client.post(f"/api/requests/{request['id']}/send-back", json=body)
    assert first.status_code == 200
    assert first.json()["status"] == "sent_back"
    _assert_conflict(
        client.post(
            f"/api/requests/{request['id']}/send-back",
            json={"note": "Different question", "operator_id": loser["id"]},
        ),
        "Riley Return",
        "sent_back",
    )
    assert client.post(f"/api/requests/{request['id']}/send-back", json=body).status_code == 200
    assert len(_audits(request["id"], "sent_back")) == 1


def test_retry_has_one_winner_conflict_and_self_replay(client):
    winner = _operator(client, "Riley Retry", "riley.retry@example.com")
    loser = _operator(client, "Morgan Retry", "morgan.retry@example.com")
    request = approved_request(client, title="Retry race")
    with SessionLocal() as db:
        row = db.get(Request, request["id"])
        row.stage, row.needs_human, row.needs_human_reason = "build", True, "GREEN failed"
        db.commit()

    first = client.post(
        f"/api/requests/{request['id']}/retry", json={"operator_id": winner["id"]}
    )
    assert first.status_code == 200
    assert first.json()["needs_human"] is False
    _assert_conflict(
        client.post(
            f"/api/requests/{request['id']}/retry", json={"operator_id": loser["id"]}
        ),
        "Riley Retry",
        "approved",
    )
    assert client.post(
        f"/api/requests/{request['id']}/retry", json={"operator_id": winner["id"]}
    ).status_code == 200
    assert len(_audits(request["id"], "retried")) == 1


def test_cancel_has_one_winner_conflict_and_self_replay(client):
    winner = _operator(client, "Riley Cancel", "riley.cancel@example.com")
    loser = _operator(client, "Morgan Cancel", "morgan.cancel@example.com")
    request = submitted_request(client, title="Cancel race")

    first = client.post(
        f"/api/requests/{request['id']}/cancel", json={"operator_id": winner["id"]}
    )
    assert first.status_code == 200
    assert first.json()["status"] == "cancelled"
    _assert_conflict(
        client.post(
            f"/api/requests/{request['id']}/cancel", json={"operator_id": loser["id"]}
        ),
        "Riley Cancel",
        "cancelled",
    )
    assert client.post(
        f"/api/requests/{request['id']}/cancel", json={"operator_id": winner["id"]}
    ).status_code == 200
    assert len(_audits(request["id"], "cancelled")) == 1
