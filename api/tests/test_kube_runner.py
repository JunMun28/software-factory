"""KubeJobRunner tests — FakeKubeClient stands in for the cluster, so these
prove the ORCHESTRATOR's guarantees (spawn/observe/grade/reap, gates,
escalation, fencing), not any container. The kube reimplementation of the four
AGENTS.md §7 witness behaviors lives here."""
from fake_kube import (
    GOOD_METRICS,
    SURFACE,
    FakeKubeClient,
    fail_verdict,
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


# ---------- the four AGENTS.md §7 witness behaviors, kube edition ----------

def _scripted(fake, decide):
    """decide(name) -> envelope dict for any running job the runner polls."""
    import json as _json

    def run(name, job):
        if job.phase != "running":
            return
        job.phase = "succeeded"
        job.termination_message = _json.dumps(decide(name))
    fake.on_observe = run


def test_red_gate_rejects_non_failing_tests_and_escalates_after_retry(client):
    """Witness 1 + 3: a bad verdict fails the attempt; retry-with-feedback runs
    ONCE (spec §4.6, N=2); then the request escalates — never silently stranded."""
    runner, fake = make_runner()
    _scripted(fake, lambda name: (
        fail_verdict("RED gate: new tests did not fail — nothing pins the new behavior")
        if name.endswith("-gate") and "-red-" in name
        else pass_verdict() if name.endswith("-gate") else stage_ok()))

    d = _approved(client, "Kube lazy test author")
    out = tick_until(client, runner, d["id"], lambda o: o["needs_human"])
    assert "RED gate" in out["needs_human_reason"]
    assert "after 2 attempts" in out["needs_human_reason"]
    ref = out["ref"].lower()
    # attempt 2 existed and carried the gate's feedback into the agent Job (spec §4.6)
    second = next(m for m in fake.creations if m["metadata"]["name"] == f"sf-{ref}-red-2")
    env = {e["name"]: e["value"] for e in second["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert "new tests did not fail" in env["SF_GATE_FEEDBACK"]
    # every attempt is an event (spec §5)
    titles = [e["title"] for e in client.get("/api/events", params={"request_id": d["id"]}).json()]
    assert any(t.startswith("Attempt 1 failed at red") for t in titles)


def test_isolation_gate_catches_cheating_implementer(client):
    """Witness 2: green's gate reports a DIFFERENT frozen-surface hash than
    red recorded — the orchestrator rejects the attempt even though the
    (untrusted) gate pod claimed a pass."""
    runner, fake = make_runner()
    _scripted(fake, lambda name: (
        pass_verdict(surface_hash=("b" * 64 if "-green-" in name else SURFACE))
        if name.endswith("-gate") else stage_ok()))

    d = _approved(client, "Kube cheater detection")
    out = tick_until(client, runner, d["id"], lambda o: o["needs_human"])
    assert "Test-isolation gate" in out["needs_human_reason"]
    assert out["stage"] == "build"  # green maps onto build (REQUEST_STAGE)
    with SessionLocal() as db:
        attempts = db.scalars(select(StageJob).where(
            StageJob.request_id == d["id"], StageJob.stage == "green",
            StageJob.role == "stage")).all()
        assert [a.attempt for a in attempts] == [1, 2]  # it got its one retry, then a human


def test_cancel_wins_over_a_running_pipeline(client):
    """Witness 4: cancel CAS-transitions the request and the running Job is
    reaped (deleted after capture); a late completion changes nothing."""
    runner, fake = make_runner()  # nothing completes: the job stays running
    d = _approved(client, "Kube cancel wins")
    with SessionLocal() as db:
        runner.tick(db)  # spawns sf-<ref>-architecture-1
    name = f"sf-{d['ref'].lower()}-architecture-1"
    assert fake.jobs[name].phase == "running"

    out = client.post(f"/api/requests/{d['id']}/cancel",
                      json={"operator_id": 1, "note": "changed my mind"}).json()
    assert out["status"] == "cancelled"

    with SessionLocal() as db:
        runner.tick(db)  # reap pass
        row = db.scalar(select(StageJob).where(StageJob.job_name == name))
        assert row.status == "reaped"
    assert name in fake.deletions
    creations_after_cancel = len(fake.creations)

    # a stale completion for the reaped job is DISCARDED (spec §5): the row is
    # no longer 'running', so it is never polled or graded again
    fake.jobs[name].deleted = False
    fake.finish(name, stage_ok())
    polls_before = fake.observations.count(name)
    with SessionLocal() as db:
        runner.tick(db)
        runner.tick(db)
    assert fake.observations.count(name) == polls_before  # never looked at again
    assert len(fake.creations) == creations_after_cancel  # and nothing new spawned
    final = client.get(f"/api/requests/{d['id']}").json()
    assert final["status"] == "cancelled" and not final["needs_human"]


# ---------- kube-specific bounds (spec §5/§6) ----------

def test_wall_clock_timeout_retries_then_escalates(client, monkeypatch):
    monkeypatch.setattr(settings, "STAGE_WALL_CLOCK", -1)  # every attempt is instantly overdue
    runner, fake = make_runner()  # jobs never complete
    d = _approved(client, "Kube partitioned node")
    out = tick_until(client, runner, d["id"], lambda o: o["needs_human"], limit=10)
    assert "wall clock" in out["needs_human_reason"]
    ref = d["ref"].lower()
    assert f"sf-{ref}-architecture-1" in fake.deletions  # the orchestrator killed it
    assert f"sf-{ref}-architecture-2" in fake.deletions  # retry got the same backstop
    with SessionLocal() as db:
        rows = db.scalars(select(StageJob).where(StageJob.request_id == d["id"])
                          .order_by(StageJob.id)).all()
        assert [r.status for r in rows] == ["timed_out", "timed_out"]


def test_absent_gate_verdict_reruns_without_consuming_attempt(client):
    """Gate infra failure (spec §6): absent verdict → the gate re-runs, same
    attempt, no escalation, no retry consumed."""
    runner, fake = make_runner()
    d = _approved(client, "Kube gate infra")
    ref = d["ref"].lower()
    name = f"sf-{ref}-architecture-1"
    gname = f"{name}-gate"

    with SessionLocal() as db:
        runner.tick(db)                       # spawns the agent Job
    fake.finish(name, stage_ok())
    with SessionLocal() as db:
        runner.tick(db)                       # observes success → spawns the gate
    fake.jobs[gname].phase = "succeeded"      # …but the pod wrote NO termination message
    with SessionLocal() as db:
        runner.tick(db)                       # absent verdict → infra, job deleted
        runner.tick(db)                       # gate re-spawned, SAME name, SAME attempt
    assert [m["metadata"]["name"] for m in fake.creations] == [name, gname, gname]

    fake.finish(gname, pass_verdict())        # the re-run grades clean
    with SessionLocal() as db:
        runner.tick(db)

    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is False
    titles = [e["title"] for e in client.get("/api/events", params={"request_id": d["id"]}).json()]
    assert any(t.startswith("Architecture plan committed") for t in titles)
    assert not any(t.startswith("Attempt") for t in titles)  # no attempt was consumed


def test_capture_failure_on_agent_job_escalates(client):
    """A SUCCEEDED agent Job whose envelope cannot be read is a capture
    failure — its own escalation reason (spec §5), never a silent pass."""
    runner, fake = make_runner()
    d = _approved(client, "Kube capture failure")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)
    fake.jobs[name].phase = "succeeded"       # no termination message written
    with SessionLocal() as db:
        runner.tick(db)
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is True
    assert "could not be captured" in out["needs_human_reason"]


def test_human_retry_grants_one_fresh_attempt(client):
    """After escalation, Retry re-enters the runnable set; the runner spawns
    attempt+1 (names stay unique — spec §5 attempt semantics) and a further
    failure escalates again."""
    runner, fake = make_runner()
    _scripted(fake, lambda name: (
        fail_verdict("RED gate: new tests did not fail")
        if name.endswith("-gate") and "-red-" in name
        else pass_verdict() if name.endswith("-gate") else stage_ok()))
    d = _approved(client, "Kube human retry")
    tick_until(client, runner, d["id"], lambda o: o["needs_human"])

    client.post(f"/api/requests/{d['id']}/retry", json={"operator_id": 1, "note": "try once more"})
    out = tick_until(client, runner, d["id"], lambda o: o["needs_human"])
    ref = d["ref"].lower()
    red_attempts = [m["metadata"]["name"] for m in fake.creations
                    if m["metadata"]["name"].startswith(f"sf-{ref}-red-")
                    and not m["metadata"]["name"].endswith("-gate")]
    assert red_attempts == [f"sf-{ref}-red-1", f"sf-{ref}-red-2", f"sf-{ref}-red-3"]
    assert out["needs_human"] is True  # the fresh attempt also failed → back to a human
