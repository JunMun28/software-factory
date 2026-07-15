"""KubeJobRunner tests — FakeKubeClient stands in for the cluster, so these
prove the ORCHESTRATOR's guarantees (spawn/observe/grade/reap, gates,
escalation, fencing), not any container. The kube reimplementation of the four
AGENTS.md §7 witness behaviors lives here."""
from fake_kube import (
    GOOD_METRICS,
    FakeKubeClient,
    honest_cluster,
    pass_verdict,
    stage_ok,
)
from helpers import approved_request
from sqlalchemy import select

from app import settings
from app.db import SessionLocal
from app.kube_runner import KubeJobRunner
from app.models import Request, StageJob


def make_runner() -> tuple[KubeJobRunner, FakeKubeClient]:
    fake = FakeKubeClient()
    return KubeJobRunner(client=fake), fake


def tick_until(client, runner, rid: int, pred, limit: int = 40):
    """Drive the tick loop until pred(request_json) — the kube runner is
    tick-driven (spec §4): nothing advances without a tick."""
    out = client.get(f"/api/requests/{rid}").json()
    for _ in range(limit):
        if pred(out):
            return out
        with SessionLocal() as db:
            runner.tick(db)
        out = client.get(f"/api/requests/{rid}").json()
    raise AssertionError(f"condition not reached after {limit} ticks: {out}")


def _approved(client, title):
    return approved_request(
        client, title=title,
        description="Add a monthly_export function that returns the export format name.")


def test_full_pipeline_to_merge_gate(client):
    runner, fake = make_runner()
    honest_cluster(fake)
    d = _approved(client, "Kube happy path")

    out = tick_until(client, runner, d["id"], lambda o: o["gate"] == "approve_merge")
    assert out["stage"] == "review" and not out["needs_human"]

    ref = out["ref"].lower()
    # every stage ran as agent Job + gate Job, attempt 1, deterministic names (spec §5)
    names = [
        m["metadata"]["name"]
        for m in fake.creations
        if m["metadata"]["labels"]["sf/request"] == ref
    ]
    assert names == [
        f"sf-{ref}-architecture-1", f"sf-{ref}-architecture-1-gate",
        f"sf-{ref}-red-1", f"sf-{ref}-red-1-gate",
        f"sf-{ref}-green-1", f"sf-{ref}-green-1-gate",
        f"sf-{ref}-review-1", f"sf-{ref}-review-1-gate",
    ]
    # the orchestrator owns the full Job lifecycle: everything it created it deleted (spec §5)
    assert sorted(name for name in fake.deletions if name.startswith(f"sf-{ref}-")) == sorted(names)

    # feed parity: the same milestone shape the other runners emit
    titles = [e["title"] for e in client.get("/api/events", params={"request_id": d["id"]}).json()]
    assert any(t.startswith("Architecture plan committed") for t in titles)
    assert any(t.startswith("RED: failing tests authored") for t in titles)
    assert any("touched no test files" in t for t in titles)
    assert any("merge gate" in t for t in titles)

    with SessionLocal() as db:
        rows = db.scalars(select(StageJob).where(StageJob.request_id == d["id"])).all()
        assert len(rows) == 8 and all(r.status == "succeeded" for r in rows)
        assert all(r.logs_tail for r in rows)  # logs captured BEFORE deletion
        # spawning was intent-logged and completed
        from app.models import Intent
        intents_rows = db.scalars(select(Intent).where(Intent.request_id == d["id"])).all()
        assert len(intents_rows) == 8 and all(i.status == "done" for i in intents_rows)

    # the human merge gate still closes the loop (B1: simulator finish_done path)
    done = client.post(f"/api/requests/{d['id']}/approve", json={"operator_id": 1}).json()
    assert done["status"] == "done" and done["stage"] == "done"


def test_review_gate_metrics_become_merge_evidence(client):
    from app import supervision

    runner, fake = make_runner()
    honest_cluster(fake)
    d = _approved(client, "Kube verification evidence")
    tick_until(client, runner, d["id"], lambda o: o["gate"] == "approve_merge")

    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        ev = supervision.evidence(db, req)
    assert ev is not None and ev["kind"] == "merge"
    assert ev["tests_passed"] == GOOD_METRICS["tests_passed"]
    assert ev["tests_total"] == GOOD_METRICS["tests_total"]
    assert ev["files_changed"] == GOOD_METRICS["files_changed"]
    assert "APPROVE" in (ev["reviewer_verdict"] or "")


def test_review_escalates_when_gate_reports_no_evidence(client):
    """A green suite with no tests or an empty diff is not honest evidence —
    the merge gate must not be raised on it (mirrors the AgentRunner guard)."""
    runner, fake = make_runner()

    def run(name, job):
        if job.phase != "running":
            return
        if name.endswith("-gate") and "-review-" in name:
            v = pass_verdict(metrics={**GOOD_METRICS, "tests_total": 0, "tests_passed": 0})
        elif name.endswith("-gate"):
            v = pass_verdict()
        else:
            v = stage_ok()
        import json as _json
        job.phase = "succeeded"
        job.termination_message = _json.dumps(v)
    fake.on_observe = run

    d = _approved(client, "Kube empty evidence")
    out = tick_until(client, runner, d["id"], lambda o: o["needs_human"])
    assert "Verification could not be built" in out["needs_human_reason"]
    assert out["gate"] != "approve_merge"


def test_fairness_and_job_cap(client, monkeypatch):
    """Oldest-runnable-first under the concurrent-Job cap (spec §2, §3.6)."""
    monkeypatch.setattr(settings, "KUBE_JOB_CAP", 1)
    runner, fake = make_runner()  # nothing completes: jobs stay running
    a = _approved(client, "Kube fairness A")
    b = _approved(client, "Kube fairness B")
    with SessionLocal() as db:
        runner.tick(db)
        runner.tick(db)
    spawned = [m["metadata"]["name"] for m in fake.creations]
    assert len(spawned) == 1                       # the cap held across ticks
    assert f"sf-{a['ref'].lower()}-" in spawned[0]  # and the OLDEST request won
    assert b["ref"]  # (b exists, still queued)
