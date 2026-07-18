"""E2E-3: the optional architecture review gate and refine loop."""

import pytest
from fake_kube import FakeKubeClient, pass_verdict, stage_ok
from helpers import approved_request, new_request
from sqlalchemy import select

from app import notifications, settings, transitions
from app.db import SessionLocal
from app.kube_runner import KubeJobRunner
from app.models import AuditEvent, Operator, ProgressEvent, Request


@pytest.fixture(autouse=True)
def _isolated_capacity(monkeypatch):
    monkeypatch.setattr(settings, "KUBE_JOB_CAP", 10_000)
    monkeypatch.setattr(settings, "PER_APP_CAP", 10_000)


def _finish_architecture_round(runner, fake, request, *, attempt=1):
    ref = request["ref"].lower()
    stage_name = f"sf-{ref}-architecture-{attempt}"
    gate_name = f"{stage_name}-gate"

    with SessionLocal() as db:
        runner.tick(db)
    assert stage_name in fake.jobs
    fake.finish(stage_name, stage_ok())

    with SessionLocal() as db:
        runner.tick(db)
    assert gate_name in fake.jobs
    fake.finish(gate_name, pass_verdict())

    with SessionLocal() as db:
        runner.tick(db)
    return stage_name, gate_name


def _viewer_id():
    with SessionLocal() as db:
        viewer = db.scalar(select(Operator).where(Operator.email == "viewer@test.local"))
        if viewer is None:
            viewer = Operator(
                name="Vic Viewer",
                initials="VV",
                hue="#888888",
                email="viewer@test.local",
                role="viewer",
            )
            db.add(viewer)
            db.commit()
        return viewer.id


def _gate_events(request_id):
    with SessionLocal() as db:
        return list(
            db.scalars(
                select(ProgressEvent)
                .where(
                    ProgressEvent.request_id == request_id,
                    ProgressEvent.kind == "gate_event",
                )
                .order_by(ProgressEvent.id)
            )
        )


def test_arch_gate_settings_are_per_call_and_default_safe(monkeypatch):
    monkeypatch.delenv("FACTORY_ARCH_GATE", raising=False)
    monkeypatch.delenv("FACTORY_SPEC_GATE", raising=False)
    assert settings.arch_gate_enabled() is False
    assert settings.spec_gate_mode() == "manual"

    monkeypatch.setenv("FACTORY_ARCH_GATE", "yes")
    monkeypatch.setenv("FACTORY_SPEC_GATE", "AUTO")
    assert settings.arch_gate_enabled() is True
    assert settings.spec_gate_mode() == "auto"


def test_arch_gate_off_preserves_direct_red_spawn(client, monkeypatch):
    monkeypatch.delenv("FACTORY_ARCH_GATE", raising=False)
    request = approved_request(client, title="Architecture gate remains opt-in")
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))

    _finish_architecture_round(runner, fake, request)

    ref = request["ref"].lower()
    assert f"sf-{ref}-red-1" in fake.jobs
    current = client.get(f"/api/requests/{request['id']}").json()
    assert current["gate"] is None
    assert current["stage"] == "build"


def test_arch_gate_on_raises_once_with_plan_evidence_and_notification(
    client, monkeypatch
):
    request = approved_request(client, title="Review architecture once")
    monkeypatch.setenv("FACTORY_ARCH_GATE", "true")
    notified = []
    monkeypatch.setattr(
        notifications,
        "notify_gate_raised",
        lambda _db, req: notified.append((req.id, req.gate)),
    )
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))

    _finish_architecture_round(runner, fake, request)
    with SessionLocal() as db:
        runner.tick(db)

    ref = request["ref"].lower()
    current = client.get(f"/api/requests/{request['id']}").json()
    assert current["gate"] == "approve_architecture"
    assert current["stage"] == "architecture"
    assert f"sf-{ref}-red-1" not in fake.jobs
    assert notified == [(request["id"], "approve_architecture")]

    with SessionLocal() as db:
        plan = db.scalar(
            select(ProgressEvent)
            .where(
                ProgressEvent.request_id == request["id"],
                ProgressEvent.kind == "architecture_plan",
            )
            .order_by(ProgressEvent.id.desc())
        )
        raised = db.scalar(
            select(ProgressEvent)
            .where(
                ProgressEvent.request_id == request["id"],
                ProgressEvent.kind == "gate_event",
                ProgressEvent.title.contains("architecture"),
            )
            .order_by(ProgressEvent.id.desc())
        )
        assert raised.payload["plan_event_id"] == plan.id
        assert raised.payload["plan_excerpt"] == plan.payload["plan_excerpt"]
        assert raised.payload["plan_digest"] == plan.payload["plan_digest"]


def test_admin_approves_architecture_then_red_spawns(client, monkeypatch):
    request = approved_request(client, title="Approve architecture")
    monkeypatch.setenv("FACTORY_ARCH_GATE", "1")
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    _finish_architecture_round(runner, fake, request)

    approved = client.post(
        f"/api/requests/{request['id']}/approve",
        json={"operator_id": 1, "note": "The plan is appropriately bounded"},
    )
    assert approved.status_code == 200
    assert approved.json()["gate"] is None
    replay = client.post(
        f"/api/requests/{request['id']}/approve",
        json={"operator_id": 1, "note": "The plan is appropriately bounded"},
    )
    assert replay.status_code == 200

    with SessionLocal() as db:
        runner.tick(db)
        audits = list(
            db.scalars(
                select(AuditEvent).where(
                    AuditEvent.request_id == request["id"],
                    AuditEvent.action == "approved_architecture",
                )
            )
        )
    assert len(audits) == 1
    assert audits[0].note == "The plan is appropriately bounded"
    assert f"sf-{request['ref'].lower()}-red-1" in fake.jobs


def test_admin_rejects_architecture_and_refine_loop_re_raises_gate(
    client, monkeypatch
):
    request = approved_request(client, title="Refine architecture")
    monkeypatch.setenv("FACTORY_ARCH_GATE", "true")
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    _finish_architecture_round(runner, fake, request)

    reason = "Split the reporting adapter from the request lifecycle service"
    rejected = client.post(
        f"/api/requests/{request['id']}/reject-gate",
        json={"operator_id": 1, "reason_code": "quality", "reason": reason},
    )
    assert rejected.status_code == 200
    assert rejected.json()["gate"] is None
    assert rejected.json()["stage"] == "architecture"
    replay = client.post(
        f"/api/requests/{request['id']}/reject-gate",
        json={"operator_id": 1, "reason_code": "quality", "reason": reason},
    )
    assert replay.status_code == 200

    with SessionLocal() as db:
        runner.tick(db)
    ref = request["ref"].lower()
    attempt_two = fake.jobs[f"sf-{ref}-architecture-2"].manifest
    env = {
        item["name"]: item.get("value")
        for item in attempt_two["spec"]["template"]["spec"]["containers"][0]["env"]
    }
    assert reason in env["SF_GATE_FEEDBACK"]
    assert "An admin reviewed the architecture and asked for changes" in env[
        "SF_GATE_FEEDBACK"
    ]
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        assert req.pending_feedback is None
        audits = list(
            db.scalars(
                select(AuditEvent).where(
                    AuditEvent.request_id == request["id"],
                    AuditEvent.action == "rejected_architecture",
                )
            )
        )
        assert len(audits) == 1
        assert audits[0].note == reason

    fake.finish(f"sf-{ref}-architecture-2", stage_ok())
    with SessionLocal() as db:
        runner.tick(db)
    fake.finish(f"sf-{ref}-architecture-2-gate", pass_verdict())
    with SessionLocal() as db:
        runner.tick(db)

    current = client.get(f"/api/requests/{request['id']}").json()
    assert current["gate"] == "approve_architecture"
    assert f"sf-{ref}-red-1" not in fake.jobs
    architecture_gates = [
        event
        for event in _gate_events(request["id"])
        if event.payload.get("gate") == "approve_architecture"
        and event.title.startswith("Waiting at the architecture gate")
    ]
    assert len(architecture_gates) == 2


def test_viewer_cannot_approve_or_reject_architecture(client, monkeypatch):
    request = approved_request(client, title="Viewer cannot decide architecture")
    monkeypatch.setenv("FACTORY_ARCH_GATE", "true")
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    _finish_architecture_round(runner, fake, request)
    viewer_id = _viewer_id()

    approved = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": viewer_id}
    )
    rejected = client.post(
        f"/api/requests/{request['id']}/reject-gate",
        json={"operator_id": viewer_id, "reason_code": "other", "reason": "No"},
    )

    assert approved.status_code == 403
    assert rejected.status_code == 403
    assert client.get(f"/api/requests/{request['id']}").json()["gate"] == (
        "approve_architecture"
    )


def test_spec_gate_auto_records_raise_and_factory_approval(client, monkeypatch):
    monkeypatch.setenv("FACTORY_SPEC_GATE", "auto")
    draft = new_request(
        client,
        title="Auto approve the draft spec",
        description="Move the one human review point to the architecture plan.",
    )

    submitted = client.post(f"/api/requests/{draft['id']}/submit", json={})

    assert submitted.status_code == 200
    body = submitted.json()
    assert body["status"] == "approved"
    assert body["stage"] == "architecture"
    assert body["gate"] is None
    with SessionLocal() as db:
        events = list(
            db.scalars(
                select(ProgressEvent)
                .where(
                    ProgressEvent.request_id == draft["id"],
                    ProgressEvent.kind == "gate_event",
                )
                .order_by(ProgressEvent.id)
            )
        )
        audit = db.scalar(
            select(AuditEvent).where(
                AuditEvent.request_id == draft["id"],
                AuditEvent.action == "approved",
            )
        )
        assert [event.payload["gate"] for event in events] == [
            "approve_spec",
            "approve_spec",
        ]
        assert audit.actor == "Factory"
        assert audit.note == "auto-approved (FACTORY_SPEC_GATE=auto)"

    monkeypatch.delenv("FACTORY_SPEC_GATE")
    manual = new_request(
        client,
        title="Keep manual spec approval by default",
        description="Prove the existing manual gate remains the default behavior.",
    )
    manual_submit = client.post(f"/api/requests/{manual['id']}/submit", json={})
    assert manual_submit.status_code == 200
    assert manual_submit.json()["status"] == "pending_approval"
    assert manual_submit.json()["gate"] == "approve_spec"


def test_architecture_decisions_are_decisive_and_replay_safe():
    assert "approved_architecture" in transitions.DECISIVE_ACTIONS
    assert "rejected_architecture" in transitions.DECISIVE_ACTIONS
    assert transitions.TABLE["approve_architecture"].replay_actions == (
        "approved_architecture",
    )
    assert transitions.TABLE["reject_architecture_gate"].replay_actions == (
        "rejected_architecture",
    )
