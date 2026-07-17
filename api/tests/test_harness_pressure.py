"""The harness pressure report: a read-time projection over rows the factory
already keeps (StageJob + audits) — no new table, no LLM. The classifier is
pinned against every reason literal the three emitting sites produce
(docker/sf-agent/gate.sh, kube_runner, agent_runner)."""
from datetime import timedelta

import pytest
from helpers import approved_request

from app import harness, transitions
from app.db import SessionLocal
from app.models import Request, StageJob, utcnow

# (emitting site, literal, expected bucket) — extend WITH the emitters.
EMITTED_REASONS = [
    # docker/sf-agent/gate.sh
    ("gate.sh", "architecture produced no PLAN.md", "no_plan"),
    ("gate.sh", "RED gate: new tests did not fail — nothing pins the new behavior", "red_not_failing"),
    ("gate.sh", "RED gate: tests broke instead of failing (pytest rc=2)", "red_broken"),
    ("gate.sh", "GREEN gate: suite still failing (rc=1): 1 failed, 3 passed", "green_suite_failing"),
    ("gate.sh", "review gate: suite not green at the pinned SHA (rc=1)", "review_not_green"),
    ("gate.sh", "graded SHA abc not found in the clone", "clone_infra"),
    ("gate.sh", "unknown gate stage deploy", "gate_broken"),
    # kube_runner (orchestrator-injected verdicts)
    ("kube_runner", "Test-isolation gate: the frozen test surface changed after RED — change rejected",
     "test_isolation_violation"),
    ("kube_runner", "Verification could not be built — the review gate reported no test/diff evidence",
     "verification_unbuildable"),
    ("kube_runner", "red gate produced no verdict after 3 consecutive infra outcomes (last phase: failed)",
     "gate_no_verdict"),
    ("kube_runner", "Stage output could not be captured for sf-req-1-red-1 — envelope missing",
     "capture_miss"),
    ("kube_runner", "Workspace preparation failed before sf-req-1-red-1: boom", "workspace_infra"),
    ("kube_runner", "red gate rejected invalid stage SHA — expected 40 lowercase hex characters",
     "clone_infra"),
    # agent_runner (in-process gates)
    ("agent_runner", "Architecture stage produced no PLAN.md", "no_plan"),
    ("agent_runner", "RED gate cannot run: pytest missing", "gate_broken"),
    ("agent_runner", "RED gate: new tests did not fail — nothing pins the new behavior", "red_not_failing"),
    ("agent_runner", "GREEN gate: suite still failing\n2 failed", "green_suite_failing"),
    ("agent_runner", "Test-isolation gate: the implementer modified the frozen test surface — change rejected",
     "test_isolation_violation"),
    ("agent_runner", "Reviewer stage produced no usable REVIEW.md", "review_no_artifact"),
    ("agent_runner", "Verification could not be built — the suite did not run or the diff was empty at review",
     "verification_unbuildable"),
    ("agent_runner", "Workspace setup failed: disk full", "workspace_infra"),
]


@pytest.mark.parametrize("site,literal,bucket", EMITTED_REASONS)
def test_every_emitted_reason_maps_to_a_typed_cause(site, literal, bucket):
    assert harness.classify_reason(literal) == bucket, f"{site}: {literal!r}"


def test_unknown_and_empty_reasons_degrade_to_other():
    assert harness.classify_reason("something entirely new") == "other"
    assert harness.classify_reason("") == "other"
    assert harness.classify_reason(None) == "other"


def test_governing_prompt_names_the_editable_file():
    assert harness.governing_prompt("green") == "docker/sf-agent/prompts/green.md"
    assert harness.governing_prompt("build") is None


def _stage_job(request_id, *, stage, status, reason=None, version="aaaabbbbcccc", attempt=1):
    # gate rows carry a harness_version in production too: _spawn_gate inherits
    # the graded stage row's stamp (kube_runner), so version attribution works
    # for typed gate causes — test_reject_gate pins the production stamping
    return StageJob(
        request_id=request_id,
        stage=stage,
        attempt=attempt,
        role="gate" if reason else "stage",
        job_name=f"sf-test-{stage}-{attempt}",
        status=status,
        envelope={"outcome": "fail", "reason": reason} if reason else None,
        harness_version=version,
        deadline_at=utcnow() + timedelta(minutes=30),
    )


def test_pressure_report_groups_machine_and_human_feedback(client):
    d = approved_request(client, title="Pressure report subject")
    with SessionLocal() as db:
        db.add(_stage_job(d["id"], stage="green", status="failed",
                          reason="GREEN gate: suite still failing (rc=1): 1 failed"))
        db.add(_stage_job(d["id"], stage="green", status="failed", attempt=2,
                          reason="GREEN gate: suite still failing (rc=1): 1 failed"))
        db.add(_stage_job(d["id"], stage="red", status="timed_out"))
        db.commit()
        req = db.get(Request, d["id"])
        res = transitions.apply_committed(db, req, "raise_merge_gate", actor=transitions.FACTORY)
        assert isinstance(res, transitions.Win)
    rejected = client.post(
        f"/api/requests/{d['id']}/reject-gate",
        json={"operator_id": 1, "reason_code": "quality", "reason": "Header row missing"},
    )
    assert rejected.status_code == 200

    out = client.get("/api/harness/pressure", params={"days": 7}).json()
    assert out["harness_version"] == harness.HARNESS_VERSION
    assert out["window_days"] == 7

    green = next(b for b in out["machine"]
                 if b["stage"] == "green" and b["cause"] == "green_suite_failing")
    assert green["count"] >= 2
    assert green["prompt_file"] == "docker/sf-agent/prompts/green.md"
    assert green["harness_versions"].get("aaaabbbbcccc", 0) >= 2
    assert "suite still failing" in green["sample_reason"]

    timeout = next(b for b in out["machine"]
                   if b["stage"] == "red" and b["cause"] == "timeout")
    assert timeout["count"] >= 1

    reject = next(b for b in out["human"]
                  if b["action"] == "rejected_merge" and b["reason_code"] == "quality")
    assert reject["count"] >= 1
    assert reject["sample_note"] == "Header row missing"
    assert reject["sample_ref"] == d["ref"]

    assert out["totals"]["machine_failures"] >= 3
    assert out["totals"]["human_feedback"] >= 1


def test_send_back_notes_never_grow_a_spurious_reason_code(client):
    """Only rejected_* notes carry '(reason_code) text'; an operator writing
    '(perf) too slow' in a send-back must NOT mint a reason_code bucket."""
    d = approved_request(client, title="Send-back prefix subject")
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        req.stage = "review"  # send-back needs a strictly-earlier target
        res = transitions.apply_committed(
            db, req, "escalate", actor=transitions.FACTORY,
            params={"reason": "needs a human"})
        assert isinstance(res, transitions.Win)
    sent = client.post(
        f"/api/requests/{d['id']}/send-back-to-stage",
        json={"operator_id": 1, "stage": "build",
              "reason": "(perf) the export query is too slow"},
    )
    assert sent.status_code == 200, sent.text

    out = client.get("/api/harness/pressure", params={"days": 7}).json()
    sendbacks = [b for b in out["human"] if b["action"] == "sent_back_to_stage"]
    assert sendbacks and all(b["reason_code"] is None for b in sendbacks)
    ours = next(b for b in sendbacks
                if b["sample_note"] == "(perf) the export query is too slow")
    assert ours["count"] >= 1
