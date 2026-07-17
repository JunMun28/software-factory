"""The structured human 'no' at merge/deploy gates (self-harness analysis 2026-07-16).

reject-gate records typed evidence (audit + gate_event), escalates for the
normal recovery actions, and stages pending_feedback so the human's reason
reaches the next agent attempt exactly like deterministic gate feedback does.
The deploy twin is shielded: after a reject, a Retry re-raises the gate —
never a silent deploy, never a slug-scoped teardown of a live app."""
import json
import typing

from fake_kube import FakeKubeClient, honest_build, pass_verdict, stage_ok
from helpers import approved_request
from sqlalchemy import select
from test_deploy_runner import _enable_deploy, _northwind_request, _tick_until

from app import api_helpers, settings, transitions
from app.db import SessionLocal
from app.kube_runner import KubeJobRunner
from app.models import AuditEvent, ProgressEvent, Request, StageJob
from app.schemas import RejectGateIn


def _at_merge_gate(client, title):
    d = approved_request(
        client, title=title,
        description="Add a monthly_export function that returns the export format name.",
    )
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        res = transitions.apply_committed(db, req, "raise_merge_gate", actor=transitions.FACTORY)
        assert isinstance(res, transitions.Win), res
    return client.get(f"/api/requests/{d['id']}").json()


def _reject(client, rid, code="quality", reason="The export drops the header row"):
    return client.post(
        f"/api/requests/{rid}/reject-gate",
        json={"operator_id": 1, "reason_code": code, "reason": reason},
    )


def test_reason_codes_match_the_transitions_vocabulary():
    literal = RejectGateIn.model_fields["reason_code"].annotation
    assert typing.get_args(literal) == transitions.GATE_REJECT_CODES


def test_reject_merge_gate_records_typed_evidence_and_stages_feedback(client):
    d = _at_merge_gate(client, "Reject evidence")
    assert d["gate"] == "approve_merge"

    out = _reject(client, d["id"]).json()
    assert out["gate"] is None and out["needs_human"]
    assert out["needs_human_reason"].startswith("Merge gate rejected (quality)")

    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        assert "A human rejected the merge gate (category: quality)" in req.pending_feedback
        assert "The export drops the header row" in req.pending_feedback
        audit = db.scalar(
            select(AuditEvent).where(AuditEvent.request_id == req.id,
                                     AuditEvent.action == "rejected_merge"))
        assert audit is not None and audit.operator_id == 1
        assert audit.note == "(quality) The export drops the header row"
        ev = db.scalar(
            select(ProgressEvent).where(ProgressEvent.request_id == req.id,
                                        ProgressEvent.kind == "gate_event")
            .order_by(ProgressEvent.id.desc()))
        payload = ev.payload if isinstance(ev.payload, dict) else json.loads(ev.payload)
        assert payload["reason_code"] == "quality"
        assert payload["gate"] == "approve_merge"


def test_reject_is_idempotent_for_its_operator_and_blocks_a_racing_approve(client):
    d = _at_merge_gate(client, "Reject conflicts")
    assert _reject(client, d["id"]).status_code == 200

    replay = _reject(client, d["id"])
    assert replay.status_code == 200  # ADR 0006: the winner's own replay is a 200

    approve = client.post(f"/api/requests/{d['id']}/approve", json={"operator_id": 1})
    assert approve.status_code == 409  # the reject consumed the gate


def test_reject_without_a_live_gate_conflicts(client):
    d = approved_request(client, title="Reject no gate")
    assert _reject(client, d["id"]).status_code == 409


def test_reject_requires_a_known_reason_code(client):
    d = _at_merge_gate(client, "Reject bad code")
    resp = client.post(
        f"/api/requests/{d['id']}/reject-gate",
        json={"operator_id": 1, "reason_code": "vibes", "reason": "nope"},
    )
    assert resp.status_code == 422


def test_approve_note_is_preserved_on_the_merge_audit(client):
    d = _at_merge_gate(client, "Approve note kept")
    resp = client.post(
        f"/api/requests/{d['id']}/approve",
        json={"operator_id": 1, "note": "Checked the export by hand — ship it"},
    )
    assert resp.status_code == 200
    with SessionLocal() as db:
        audit = db.scalar(
            select(AuditEvent).where(AuditEvent.request_id == d["id"],
                                     AuditEvent.action == "approved_merge"))
        assert audit is not None
        assert audit.note == "Checked the export by hand — ship it"


# ---------- the kube path: feedback reaches the pod, lineage is stamped ----------

def _scripted(fake, decide):
    def run(name, job):
        if job.phase != "running":
            return
        job.phase = "succeeded"
        job.termination_message = json.dumps(decide(name))
    fake.on_observe = run


def test_kube_reject_feedback_reaches_the_next_attempt_with_lineage(client):
    from app import harness

    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    _scripted(fake, lambda name: pass_verdict() if name.endswith("-gate") else stage_ok())

    d = approved_request(
        client, title="Kube reject feedback",
        description="Add a monthly_export function that returns the export format name.",
    )
    out = _tick_until(client, runner, d["id"], lambda o: o["gate"] == "approve_merge")
    ref = out["ref"].lower()

    # every spawned agent Job carries the harness lineage stamp, and gate rows
    # inherit it — a verdict judges the stage's work, so typed gate causes are
    # attributable to a harness version in the pressure report
    with SessionLocal() as db:
        stamped = db.scalars(
            select(StageJob).where(StageJob.request_id == d["id"],
                                   StageJob.role.in_(("stage", "gate")))
        ).all()
        assert stamped and all(r.harness_version == harness.HARNESS_VERSION for r in stamped)
    first = next(m for m in fake.creations if m["metadata"]["name"] == f"sf-{ref}-architecture-1")
    env = {e["name"]: e.get("value") for e in
           first["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["SF_HARNESS_VERSION"] == harness.HARNESS_VERSION

    assert _reject(client, d["id"], code="wrong_behavior",
                   reason="Export must be XLSX, not CSV").status_code == 200
    sent = client.post(
        f"/api/requests/{d['id']}/send-back-to-stage",
        json={"operator_id": 1, "stage": "build",
              "reason": "Redo the export as XLSX with a header row"},
    )
    assert sent.status_code == 200, sent.text

    _tick_until(client, runner, d["id"], lambda o: o["gate"] == "approve_merge")
    respawn = [m for m in fake.creations
               if m["metadata"]["name"].startswith(f"sf-{ref}-red-")
               and not m["metadata"]["name"].endswith("-gate")][-1]
    assert respawn["metadata"]["name"] == f"sf-{ref}-red-2"  # the post-send-back attempt
    env = {e["name"]: e.get("value") for e in
           respawn["spec"]["template"]["spec"]["containers"][0]["env"]}
    # the human's reason rode into the pod like gate feedback does...
    assert "Redo the export as XLSX with a header row" in env["SF_GATE_FEEDBACK"]
    # ...and was consumed by exactly that attempt
    with SessionLocal() as db:
        assert db.get(Request, d["id"]).pending_feedback is None


def test_feedback_survives_a_job_create_failure(client):
    """The human reason is consumed only after the Job that carries it exists:
    a create failure must keep it staged so the re-spawn still delivers it."""
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    _scripted(fake, lambda name: pass_verdict() if name.endswith("-gate") else stage_ok())

    d = approved_request(
        client, title="Feedback survives create failure",
        description="Add a monthly_export function that returns the export format name.",
    )
    out = _tick_until(client, runner, d["id"], lambda o: o["gate"] == "approve_merge")
    ref = out["ref"].lower()
    assert _reject(client, d["id"], code="quality", reason="Keep the header row").status_code == 200
    sent = client.post(
        f"/api/requests/{d['id']}/send-back-to-stage",
        json={"operator_id": 1, "stage": "build", "reason": "Keep the header row in the export"},
    )
    assert sent.status_code == 200, sent.text

    real_create, failed = fake.create_job, []

    def failing_create(manifest):
        if manifest["metadata"]["name"] == f"sf-{ref}-red-2" and not failed:
            failed.append(manifest["metadata"]["name"])
            raise RuntimeError("api server hiccup")
        return real_create(manifest)

    fake.create_job = failing_create
    with SessionLocal() as db:
        runner.tick(db)  # spawn of red-2 fails at create → escalates
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        assert failed and req.needs_human
        assert req.pending_feedback is not None  # NOT lost with the failed create

    retried = client.post(f"/api/requests/{d['id']}/retry", json={"operator_id": 1})
    assert retried.status_code == 200
    _tick_until(client, runner, d["id"], lambda o: o["gate"] == "approve_merge")
    delivered = [m for m in fake.creations
                 if m["metadata"]["name"] == f"sf-{ref}-red-2"][-1]
    env = {e["name"]: e.get("value") for e in
           delivered["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert "Keep the header row in the export" in env["SF_GATE_FEEDBACK"]
    with SessionLocal() as db:
        assert db.get(Request, d["id"]).pending_feedback is None  # consumed on delivery


# ---------- the deploy twin: reject never deploys, never tears down ----------

def test_deploy_reject_shields_retry_and_never_tears_down(client, monkeypatch, tmp_path):
    with SessionLocal() as db:
        for old in db.scalars(select(Request).where(Request.stage == "deploy")).all():
            old.stage = "done"
        db.commit()
    _enable_deploy(monkeypatch, tmp_path)
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    honest_build(fake, settings.WORKSPACES)
    request = _northwind_request(client, "Deploy reject shield")
    _tick_until(client, runner, request["id"], lambda o: o["gate"] == "approve_merge")
    monkeypatch.setenv("FACTORY_RUNNER", "kube")
    monkeypatch.setattr(api_helpers, "_pipeline", runner)

    first = client.post(f"/api/requests/{request['id']}/approve", json={"operator_id": 1})
    assert first.status_code == 200 and first.json()["gate"] == "approve_deploy"

    rejected = _reject(client, request["id"], code="security", reason="Do not ship this build")
    assert rejected.status_code == 200
    body = rejected.json()
    assert body["gate"] is None and body["needs_human"]
    with SessionLocal() as db:
        # a deploy reject stages NO agent feedback: the work is already merged,
        # so no attempt could ever consume it — evidence lives in audit/events
        assert db.get(Request, request["id"]).pending_feedback is None

    # escalated-after-reject must NOT hit the slug-scoped teardown (OPERATE-02)
    # and must not build
    with SessionLocal() as db:
        runner.tick(db)
    assert fake.label_deletions == []
    with SessionLocal() as db:
        assert db.scalar(select(StageJob).where(StageJob.request_id == request["id"],
                                                StageJob.role == "build")) is None

    # Retry recovers the request — the gate comes BACK instead of a silent deploy
    retried = client.post(f"/api/requests/{request['id']}/retry", json={"operator_id": 1})
    assert retried.status_code == 200 and not retried.json()["needs_human"]
    out = _tick_until(client, runner, request["id"], lambda o: o["gate"] == "approve_deploy")
    assert out["stage"] == "deploy"
    with SessionLocal() as db:
        assert db.scalar(select(StageJob).where(StageJob.request_id == request["id"],
                                                StageJob.role == "build")) is None

    # an explicit approval still releases the deploy afterwards
    second = client.post(f"/api/requests/{request['id']}/approve", json={"operator_id": 1})
    assert second.status_code == 200 and second.json()["gate"] is None
    with SessionLocal() as db:
        runner.tick(db)
    with SessionLocal() as db:
        assert db.scalar(select(StageJob).where(StageJob.request_id == request["id"],
                                                StageJob.role == "build")) is not None
