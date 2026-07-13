"""Slice 7: subscriptions, narrow email triggers, and no-event freshness."""

import logging

from helpers import new_request

from app.agent_runner import AgentRunner
from app.db import SessionLocal
from app.models import Request


def _cursor(client):
    response = client.get("/api/events/cursor")
    assert response.status_code == 200
    return response.json()


class CapturedSmtp:
    messages = []

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def login(self, *args):
        pass

    def send_message(self, message):
        self.messages.append(message)


def _capture_mail(monkeypatch):
    import smtplib

    CapturedSmtp.messages = []
    monkeypatch.setenv("SMTP_HOST", "mail.example.test")
    monkeypatch.setenv("SMTP_PORT", "2525")
    monkeypatch.setenv("SMTP_FROM", "factory@example.test")
    monkeypatch.setenv("CONSOLE_BASE_URL", "https://console.example.test")
    monkeypatch.setattr(smtplib, "SMTP", CapturedSmtp)
    return CapturedSmtp.messages


def _notification_fixture(client):
    suffix = len(client.get("/api/apps").json()) + 1
    app = client.post("/api/apps", json={
        "name": f"Notification Target {suffix}",
        "owner": "factory",
        "repo": f"factory/notify-{suffix}",
        "provisioning": "Manual",
        "muted": False,
    }).json()
    operators = client.get("/api/operators").json()
    muted = operators[0]
    response = client.put(
        f"/api/operators/{muted['id']}/subscriptions/{app['id']}",
        json={"subscribed": False},
    )
    assert response.status_code == 200
    expected = {operator["email"] for operator in operators[1:] if operator["email"].strip()}
    return app, expected


def test_subscriptions_default_to_all_and_changes_bump_revision(client):
    operator = client.get("/api/operators").json()[0]
    apps = client.get("/api/apps").json()

    before = _cursor(client)
    assert "revision" in before
    subscriptions = client.get(f"/api/operators/{operator['id']}/subscriptions")
    assert subscriptions.status_code == 200
    assert subscriptions.json() == [
        {
            "app_id": app["id"],
            "key": app["key"],
            "name": app["name"],
            "subscribed": True,
        }
        for app in apps
    ]

    muted = client.put(
        f"/api/operators/{operator['id']}/subscriptions/{apps[0]['id']}",
        json={"subscribed": False},
    )
    assert muted.status_code == 200
    assert muted.json()["subscribed"] is False
    after_mute = _cursor(client)
    assert after_mute["cursor"] == before["cursor"]
    assert after_mute["revision"] > before["revision"]

    # Repeating the same preference is a healthy no-op, not a new revision.
    repeated = client.put(
        f"/api/operators/{operator['id']}/subscriptions/{apps[0]['id']}",
        json={"subscribed": False},
    )
    assert repeated.status_code == 200
    assert _cursor(client)["revision"] == after_mute["revision"]


def test_registry_edit_and_operator_create_bump_revision_without_events(client):
    app = client.get("/api/apps").json()[1]
    before = _cursor(client)

    edited = client.patch(
        f"/api/apps/{app['id']}",
        json={
            "name": app["name"],
            "owner": app["owner"] + "-fresh",
            "repo": app["repo"],
            "provisioning": app["provisioning"],
            "muted": app["muted"],
        },
    )
    assert edited.status_code == 200
    after_edit = _cursor(client)
    assert after_edit["cursor"] == before["cursor"]
    assert after_edit["revision"] > before["revision"]

    # An identical registry write does not claim a state change.
    repeated = client.patch(f"/api/apps/{app['id']}", json={
        "name": edited.json()["name"],
        "owner": edited.json()["owner"],
        "repo": edited.json()["repo"],
        "provisioning": edited.json()["provisioning"],
        "muted": edited.json()["muted"],
    })
    assert repeated.status_code == 200
    assert _cursor(client)["revision"] == after_edit["revision"]

    created = client.post("/api/operators", json={
        "name": "Fresh Ness",
        "initials": "FN",
        "hue": "#2563EB",
        "email": "freshness@example.com",
    })
    assert created.status_code == 201
    after_operator = _cursor(client)
    assert after_operator["cursor"] == before["cursor"]
    assert after_operator["revision"] > after_edit["revision"]


def test_spec_gate_emails_exactly_subscribed_operators_with_dossier_link(client, monkeypatch):
    messages = _capture_mail(monkeypatch)
    app, expected = _notification_fixture(client)
    request = new_request(client, title="Spec email probe", app_id=app["id"])

    submitted = client.post(f"/api/requests/{request['id']}/submit", json={})

    assert submitted.status_code == 200
    assert {message["To"] for message in messages} == expected
    assert all("spec gate" in message["Subject"].lower() for message in messages)
    assert all(
        f"https://console.example.test/requests/{request['id']}" in message.get_content()
        for message in messages
    )


def test_merge_gate_emails_subscribers_but_done_and_healthy_steps_do_not(client, monkeypatch):
    messages = _capture_mail(monkeypatch)
    app, expected = _notification_fixture(client)
    request = new_request(client, title="Merge email probe", app_id=app["id"])
    client.post(f"/api/requests/{request['id']}/submit", json={})
    client.post(f"/api/requests/{request['id']}/approve", json={"operator_id": 1})
    messages.clear()

    client.post("/api/simulator/tick")
    assert messages == [], "a healthy step summary must never email"
    for _ in range(15):
        client.post("/api/simulator/tick")

    target_messages = [
        message for message in messages
        if f"/requests/{request['id']}" in message.get_content()
    ]
    assert {message["To"] for message in target_messages} == expected
    assert all("merge gate" in message["Subject"].lower() for message in target_messages)
    messages.clear()

    merged = client.post(
        f"/api/requests/{request['id']}/approve",
        json={"operator_id": 1},
    )
    assert merged.status_code == 200 and merged.json()["status"] == "done"
    assert messages == [], "done/Deployed must never email"


def test_escalation_emails_subscribers(client, monkeypatch):
    messages = _capture_mail(monkeypatch)
    app, expected = _notification_fixture(client)
    request = new_request(client, title="Escalation email probe", app_id=app["id"])
    client.post(f"/api/requests/{request['id']}/submit", json={})
    messages.clear()

    with SessionLocal() as db:
        row = db.get(Request, request["id"])
        AgentRunner()._escalate(db, row, "Runner stopped reporting")

    assert {message["To"] for message in messages} == expected
    assert all("needs a human" in message["Subject"].lower() for message in messages)
    assert all(f"/requests/{request['id']}" in message.get_content() for message in messages)


def test_simulator_failure_escalates_and_emails_subscribers(client, monkeypatch):
    from app import simulator

    messages = _capture_mail(monkeypatch)
    app, expected = _notification_fixture(client)
    request = new_request(client, title="Simulator stall probe", app_id=app["id"])
    client.post(f"/api/requests/{request['id']}/submit", json={})
    client.post(f"/api/requests/{request['id']}/approve", json={"operator_id": 1})
    messages.clear()
    real_pending = simulator.pending_steer_notes

    def fail_target(db, req):
        if req.id == request["id"]:
            raise RuntimeError("simulated worker stopped")
        return real_pending(db, req)

    monkeypatch.setattr(simulator, "pending_steer_notes", fail_target)
    with SessionLocal() as db:
        simulator.tick(db)

    stalled = client.get(f"/api/requests/{request['id']}").json()
    assert stalled["needs_human"] is True
    assert "simulated worker stopped" in stalled["needs_human_reason"]
    target_messages = [
        message for message in messages
        if f"/requests/{request['id']}" in message.get_content()
    ]
    assert {message["To"] for message in target_messages} == expected


def test_unset_smtp_logs_email_and_health_reports_log_only(client, monkeypatch, caplog):
    monkeypatch.delenv("SMTP_HOST", raising=False)
    monkeypatch.delenv("SMTP_FROM", raising=False)
    app, _ = _notification_fixture(client)
    request = new_request(client, title="Log-only email probe", app_id=app["id"])

    with caplog.at_level(logging.INFO, logger="factory.notifications"):
        submitted = client.post(f"/api/requests/{request['id']}/submit", json={})

    assert submitted.status_code == 200
    assert client.get("/api/health").json()["smtp"] == "log-only"
    assert f"/requests/{request['id']}" in caplog.text
