from helpers import submitted_request


def test_operator_list_and_create(client):
    seeded = client.get("/api/operators")
    assert seeded.status_code == 200
    assert any(operator["name"] == "Kim Park" for operator in seeded.json())

    created = client.post("/api/operators", json={
        "name": "Jun Mun Wong",
        "initials": "JMW",
        "hue": "#4F46E5",
        "email": "jun@example.com",
    })
    assert created.status_code == 201
    assert created.json() | {"id": created.json()["id"], "created_at": created.json()["created_at"]} == created.json()
    assert created.json()["name"] == "Jun Mun Wong"


def test_approve_resolves_operator_and_projects_decided_by(client):
    operator = client.post("/api/operators", json={
        "name": "Avery Stone", "initials": "AS", "hue": "#0F766E", "email": "avery@example.com",
    }).json()
    request = submitted_request(client, title="Signed approval")

    approved = client.post(
        f"/api/requests/{request['id']}/approve",
        json={"operator_id": operator["id"], "actor": "Forged Name"},
    )
    assert approved.status_code == 200
    events = client.get("/api/events", params={"request_id": request["id"]}).json()
    assert any(event["actor"] == "Avery Stone" for event in events if event["kind"] == "gate_event")

    recent = client.get("/api/mission").json()["recent"]
    row = next(item for item in recent if item["request"]["id"] == request["id"])
    assert row["outcome"] == "approved"
    assert row["decided_by"] == "Avery Stone"
    assert row["decided_at"]


def test_console_mutations_reject_missing_and_unknown_operator(client):
    cases = (
        ("approve", {}),
        ("send-back", {"note": "More detail"}),
        ("retry", {}),
        ("take-over", {}),
        ("send-back-to-stage", {"stage": "architecture", "reason": "Redo it"}),
        ("cancel", {}),
        ("steer", {"note": "Keep it small"}),
        ("comments", {"body": "Looks good"}),
    )
    for verb, body in cases:
        request = submitted_request(client, title=f"Missing identity: {verb}")
        missing = client.post(f"/api/requests/{request['id']}/{verb}", json=body)
        assert missing.status_code == 422, verb
        assert "operator_id" in missing.text

    for verb, body in cases:
        request = submitted_request(client, title=f"Unknown identity: {verb}")
        if verb in ("retry", "take-over", "send-back-to-stage"):
            from app.db import SessionLocal
            from app.models import Request
            with SessionLocal() as db:
                row = db.get(Request, request["id"])
                row.stage, row.needs_human = "build", True
                db.commit()
        unknown = client.post(
            f"/api/requests/{request['id']}/{verb}", json={**body, "operator_id": 999999}
        )
        assert unknown.status_code == 404, verb
        assert unknown.json()["detail"] == "Unknown operator id 999999"


def test_intake_submit_does_not_require_operator(client):
    draft = client.post(
        "/api/requests",
        json={
            "type": "enh",
            "title": "Intake stays open",
            "description": "Let submitters file a request without operator credentials.",
        },
    ).json()
    submitted = client.post(f"/api/requests/{draft['id']}/submit", json={})
    assert submitted.status_code == 200
