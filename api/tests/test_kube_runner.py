"""KubeJobRunner tests — FakeKubeClient stands in for the cluster, so these
prove the ORCHESTRATOR's guarantees (spawn/observe/grade/reap, gates,
escalation, fencing), not any container. The kube reimplementation of the four
AGENTS.md §7 witness behaviors lives here."""
import builtins
import importlib.util
import inspect
import json
import os
import shutil
import subprocess
import sys
from datetime import timedelta
from pathlib import Path

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

from app import settings, simulator, transitions, workspace
from app.db import SessionLocal
from app.kube_runner import KubeJobRunner
from app.models import Request, StageJob, utcnow
from app.ws_exec import _git


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


# ---------- final-review recovery and hardening fixes ----------

def test_tick_repairs_review_grade_committed_before_merge_gate(client, monkeypatch):
    """A crash after the review grade commit must not strand approved work."""
    runner, fake = make_runner()
    honest_cluster(fake)
    d = _approved(client, "Kube merge-gate repair")
    finish_review = runner._finish_review
    interrupted: list[dict] = []

    def lose_finish(db, req, envelope, moved):
        interrupted.append(envelope)

    monkeypatch.setattr(runner, "_finish_review", lose_finish)
    tick_until(client, runner, d["id"], lambda _o: bool(interrupted))
    stranded = client.get(f"/api/requests/{d['id']}").json()
    assert stranded["status"] == "approved" and stranded["gate"] is None

    monkeypatch.setattr(runner, "_finish_review", finish_review)
    repaired = tick_until(
        client, runner, d["id"], lambda o: o["gate"] == "approve_merge", limit=10
    )
    assert repaired["gate"] == "approve_merge"


def test_hung_gate_infra_loop_consumes_attempt_and_escalates(client):
    """A deadline-killed gate with no envelope cannot churn forever."""
    runner, fake = make_runner()

    def deadline_kill(name, job):
        if job.phase != "running":
            return
        if name.endswith("-gate"):
            job.phase = "failed"
        else:
            job.phase = "succeeded"
            job.termination_message = json.dumps(stage_ok())

    fake.on_observe = deadline_kill
    d = _approved(client, "Kube bounded gate infra")
    out = tick_until(client, runner, d["id"], lambda o: o["needs_human"], limit=30)
    ref = d["ref"].lower()

    assert "produced no verdict" in out["needs_human_reason"]
    assert [
        m["metadata"]["name"]
        for m in fake.creations
        if m["metadata"]["name"].startswith(f"sf-{ref}-architecture-")
        and m["metadata"]["name"].endswith("-gate")
    ] == [
        f"sf-{ref}-architecture-1-gate",
        f"sf-{ref}-architecture-1-gate",
        f"sf-{ref}-architecture-1-gate",
        f"sf-{ref}-architecture-2-gate",
        f"sf-{ref}-architecture-2-gate",
        f"sf-{ref}-architecture-2-gate",
    ]


def test_gate_infra_bound_resets_for_a_new_attempt(client):
    runner, fake = make_runner()
    failures: dict[str, int] = {}

    def recover_on_second_attempt(name, job):
        if job.phase != "running":
            return
        if not name.endswith("-gate"):
            job.phase = "succeeded"
            job.termination_message = json.dumps(stage_ok())
            return
        failures[name] = failures.get(name, 0) + 1
        if "-architecture-1-gate" in name or failures[name] < 3:
            job.phase = "failed"
            return
        job.phase = "succeeded"
        job.termination_message = json.dumps(pass_verdict())

    fake.on_observe = recover_on_second_attempt
    d = _approved(client, "Kube gate infra resets")
    ref = d["ref"].lower()
    tick_until(
        client,
        runner,
        d["id"],
        lambda _o: f"sf-{ref}-red-1" in fake.jobs,
        limit=30,
    )

    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is False
    assert failures[f"sf-{ref}-architecture-2-gate"] == 3


def test_observe_tolerates_one_transient_get_job_failure(client):
    runner, fake = make_runner()
    d = _approved(client, "Kube observe flake")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)

    fake.raise_once.add(name)
    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(select(StageJob).where(StageJob.job_name == name))
        assert row.status == "running"
    assert name not in fake.deletions
    assert client.get(f"/api/requests/{d['id']}").json()["needs_human"] is False

    fake.finish(name, stage_ok())
    with SessionLocal() as db:
        runner.tick(db)
    assert f"{name}-gate" in fake.jobs


def test_send_back_to_build_supersedes_later_rows_and_restarts_red(client):
    runner, fake = make_runner()

    def fail_green(name):
        if name.endswith("-gate") and "-green-" in name:
            return fail_verdict("green needs another implementation pass")
        return pass_verdict() if name.endswith("-gate") else stage_ok()

    _scripted(fake, fail_green)
    d = _approved(client, "Kube rewind")
    tick_until(client, runner, d["id"], lambda o: o["needs_human"])
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        result = transitions.apply(
            db,
            req,
            "send_back_to_stage",
            actor=transitions.Actor(name="Riley Rewind"),
            params={"stage": "build", "reason": "Redo from RED"},
        )
        assert not isinstance(result, transitions.Loss)
        db.commit()

    creations_before = len(fake.creations)
    with SessionLocal() as db:
        runner.tick(db)
        superseded = db.scalars(
            select(StageJob).where(
                StageJob.request_id == d["id"], StageJob.status == "superseded"
            )
        ).all()

    spawned = fake.creations[creations_before:]
    assert spawned[0]["metadata"]["name"] == f"sf-{d['ref'].lower()}-red-2"
    assert {row.stage for row in superseded} == {"red", "green"}


def test_reap_failure_isolated_so_other_work_is_observed_and_spawned(client):
    runner, fake = make_runner()
    poisoned = _approved(client, "Kube poisoned reap")
    healthy = _approved(client, "Kube healthy observe")
    with SessionLocal() as db:
        runner.tick(db)

    poisoned_name = f"sf-{poisoned['ref'].lower()}-architecture-1"
    healthy_name = f"sf-{healthy['ref'].lower()}-architecture-1"
    client.post(
        f"/api/requests/{poisoned['id']}/cancel",
        json={"operator_id": 1, "note": "stop"},
    )
    queued = _approved(client, "Kube spawn despite poisoned reap")
    fake.raise_always.add(poisoned_name)
    fake.finish(healthy_name, stage_ok())

    with SessionLocal() as db:
        runner.tick(db)

    assert f"{healthy_name}-gate" in fake.jobs
    assert f"sf-{queued['ref'].lower()}-architecture-1" in fake.jobs


def test_wall_clock_captures_available_output_before_delete(client, monkeypatch):
    monkeypatch.setattr(settings, "STAGE_WALL_CLOCK", -1)
    runner, fake = make_runner()
    d = _approved(client, "Kube timeout capture")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)
    fake.jobs[name].termination_message = json.dumps(stage_ok("partial output"))
    fake.jobs[name].logs = "partial running log"

    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(select(StageJob).where(StageJob.job_name == name))

    # A running pod has no terminated-container message yet; only its logs are
    # available through capture=True under the seam-v2 contract.
    assert row.envelope is None
    assert row.logs_tail == "partial running log"
    assert name in fake.deletions


def test_stage_jobs_migration_owns_its_timezone_type(monkeypatch):
    migration = (
        Path(__file__).parents[1]
        / "alembic"
        / "versions"
        / "7f2a9c4d1e88_stage_jobs.py"
    )
    real_import = builtins.__import__

    def reject_live_model(name, *args, **kwargs):
        if name == "app.models":
            raise AssertionError("migration imported live app.models")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", reject_live_model)
    spec = importlib.util.spec_from_file_location("stage_jobs_migration", migration)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.TZDateTime.__module__ == "stage_jobs_migration"


def test_kube_max_attempts_prefers_new_env_and_keeps_compat_fallback():
    api_dir = Path(__file__).parents[1]
    command = [sys.executable, "-c", "from app.settings import KUBE_MAX_ATTEMPTS; print(KUBE_MAX_ATTEMPTS)"]
    env = os.environ.copy()
    env.update(FACTORY_KUBE_MAX_ATTEMPTS="7", FACTORY_MAX_ATTEMPTS="4")
    preferred = subprocess.run(
        command, cwd=api_dir, env=env, capture_output=True, text=True, check=True
    )
    env.pop("FACTORY_KUBE_MAX_ATTEMPTS")
    fallback = subprocess.run(
        command, cwd=api_dir, env=env, capture_output=True, text=True, check=True
    )
    assert preferred.stdout.strip() == "7"
    assert fallback.stdout.strip() == "4"


def test_kube_runner_module_contract_documents_actual_limits():
    import app.kube_runner as kube_runner

    doc = inspect.getdoc(kube_runner)
    assert "three consecutive infra outcomes" in doc
    assert "running-pod capture is best-effort" in doc
    assert "grades themselves are not epoch-fenced" in doc


# ---------- B2 task 2: uid tracking, capture-before-delete, supersede leak ----------


def test_create_records_uid_and_replay_adopts(client):
    """Intent replay: our own earlier create landed (409) — adopt its uid."""
    runner, fake = make_runner()
    d = _approved(client, "Kube uid adopt")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    # a previous leader's create landed, then it crashed before recording it
    from app.kube_jobs import stage_job_manifest

    pre_uid = fake.create_job(stage_job_manifest(d["ref"], "architecture", 1))
    fake.conflicts.add(name)  # our create will 409 against it
    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(
            select(StageJob)
            .where(StageJob.job_name == name)
            .order_by(StageJob.id.desc())
        )
        assert row.status == "running" and row.job_uid == pre_uid  # adopted


def test_create_conflict_with_dying_predecessor_parks_infra(client, monkeypatch):
    """A prior attempt's same-name Job is still terminating: never adopt it —
    park as infra and re-run once the name frees up (B1 ledger: 409s)."""
    monkeypatch.setattr(settings, "STAGE_WALL_CLOCK", -1)  # attempt 1 times out instantly
    runner, fake = make_runner()
    d = _approved(client, "Kube dying predecessor")
    with SessionLocal() as db:
        runner.tick(db)  # spawn attempt 1
        runner.tick(db)  # wall clock fires: row1 timed_out, job deleted, retry queued
    monkeypatch.setattr(settings, "STAGE_WALL_CLOCK", 2100)
    # the kubelet is slow: the old attempt-1 Job object is STILL there when the
    # infra path recreates the same deterministic name for attempt... (attempt 2
    # has its own name; force the same-name case via an infra vanish instead)
    name2 = f"sf-{d['ref'].lower()}-architecture-2"
    with SessionLocal() as db:
        runner.tick(db)  # spawns attempt 2 (name2)
    fake.jobs[name2].deleted = True  # vanishes under us → infra re-run, SAME name
    with SessionLocal() as db:
        runner.tick(db)  # observes absent → row infra
    old_uid = fake.jobs[name2].uid
    fake.jobs[name2].deleted = False  # ...but the object lingers, dying
    fake.conflicts.add(name2)
    with SessionLocal() as db:
        runner.tick(db)  # re-create 409s against the dying predecessor
        rows = db.scalars(
            select(StageJob).where(StageJob.job_name == name2).order_by(StageJob.id)
        ).all()
        assert rows[-1].status == "infra" and rows[-1].job_uid is None
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is False  # parked, not escalated
    fake.jobs[name2].deleted = True  # predecessor finally reaped
    with SessionLocal() as db:
        runner.tick(db)
        fresh = db.scalar(
            select(StageJob)
            .where(StageJob.job_name == name2)
            .order_by(StageJob.id.desc())
        )
        assert fresh.status == "running" and fresh.job_uid not in (None, old_uid)


def test_observe_discards_same_name_stranger(client):
    """A same-name Job with a DIFFERENT uid is not ours: infra, re-run,
    never graded (B1 ledger: uid tracking)."""
    runner, fake = make_runner()
    d = _approved(client, "Kube uid stranger")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)
    # someone deleted + recreated the job out-of-band
    from fake_kube import FakeJob

    from app.kube_jobs import stage_job_manifest

    fake.jobs[name] = FakeJob(
        manifest=stage_job_manifest(d["ref"], "architecture", 1),
        uid="uid-stranger",
    )
    fake.finish(name, stage_ok())  # the stranger even "succeeds"
    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(
            select(StageJob).where(StageJob.job_name == name).order_by(StageJob.id)
        )
        assert row.status == "infra"  # discarded, not graded
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is False


def test_post_discard_rerun_parks_same_stranger_instead_of_adopting(client):
    runner, fake = make_runner()
    d = _approved(client, "Kube uid stranger replay")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)

    from fake_kube import FakeJob

    from app.kube_jobs import stage_job_manifest

    fake.jobs[name] = FakeJob(
        manifest=stage_job_manifest(d["ref"], "architecture", 1),
        uid="uid-stranger",
    )
    fake.finish(name, stage_ok("stale stranger result"))
    with SessionLocal() as db:
        runner.tick(db)  # discard the stranger against the recorded original uid

    fake.conflicts.add(name)
    with SessionLocal() as db:
        runner.tick(db)  # re-create 409s against that same stranger
        rows = db.scalars(
            select(StageJob).where(StageJob.job_name == name).order_by(StageJob.id)
        ).all()

    assert [row.status for row in rows] == ["infra", "infra"]
    assert rows[-1].job_uid is None
    assert f"{name}-gate" not in fake.jobs


def test_wall_clock_timeout_captures_running_logs(client, monkeypatch):
    monkeypatch.setattr(settings, "STAGE_WALL_CLOCK", -1)
    runner, fake = make_runner()
    d = _approved(client, "Kube timeout capture")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)
    fake.jobs[name].logs = '{"type":"note","text":"i was mid-flight"}\n'
    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(select(StageJob).where(StageJob.job_name == name))
        assert row.status == "timed_out"
        assert "mid-flight" in (row.logs_tail or "")  # captured BEFORE delete
    assert name in fake.deletions


def test_reap_captures_running_logs(client):
    runner, fake = make_runner()
    d = _approved(client, "Kube reap capture")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)
    fake.jobs[name].logs = '{"type":"note","text":"cancelled mid-run"}\n'
    client.post(f"/api/requests/{d['id']}/cancel", json={"operator_id": 1})
    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(select(StageJob).where(StageJob.job_name == name))
        assert row.status == "reaped" and "cancelled mid-run" in (row.logs_tail or "")


def test_supersede_deletes_running_job(client):
    """B1 ledger: a rewound request superseded LATER rows but left their live
    Jobs running forever. Superseding a running row now captures + deletes."""
    runner, fake = make_runner()
    d = _approved(client, "Kube supersede leak")
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        # fabricate a running review-stage job from BEFORE an operator rewind
        from app.kube_jobs import stage_job_manifest

        name = f"sf-{req.ref.lower()}-review-1"
        uid = fake.create_job(stage_job_manifest(req.ref, "review", 1))
        fake.jobs[name].logs = '{"type":"note","text":"stale reviewer"}\n'
        db.add(
            StageJob(
                request_id=req.id,
                stage="review",
                attempt=1,
                role="stage",
                job_name=name,
                job_uid=uid,
                epoch=1,
                deadline_at=utcnow() + timedelta(seconds=2100),
                created_at=utcnow() - timedelta(hours=1),
            )
        )
        req.stage = "architecture"  # the rewind target
        req.stage_entered_at = utcnow()  # newer than the row above
        db.commit()
        runner.tick(db)
        row = db.scalar(select(StageJob).where(StageJob.job_name == name))
        assert row.status == "superseded"
        assert "stale reviewer" in (row.logs_tail or "")
    assert name in fake.deletions  # the leak is closed


# ---------- B2 task 5: git-backed grading, resets, merge ----------

def _git_mode(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "WORKSPACES", tmp_path / "kube-ws")


def _commit_all(ws, msg):
    _git(ws, "add", "-A")
    _git(ws, "commit", "-q", "-m", msg)
    return _git(ws, "rev-parse", "HEAD").stdout.strip()


def git_backed_cluster(fake, ws_root, *, green_cheats=False):
    """Agents that REALLY commit: each stage job writes to the request's
    workspace (standing in for the pod's clone+push) and reports its sha;
    gates pass verdicts whose envelope hashes are junk — proving the
    orchestrator now trusts only its OWN git computation."""
    import json as _json

    def run(name, job):
        if job.phase != "running":
            return
        if name.endswith("-gate"):
            v = pass_verdict(surface_hash="junk-" + name[-12:])  # untrusted + inconsistent
            job.phase = "succeeded"
            job.termination_message = _json.dumps(v)
            return
        env = {e["name"]: e["value"] for e in job.manifest["spec"]["template"]["spec"]["containers"][0]["env"]}
        ref, stage = env["SF_REF"], env["SF_STAGE"]
        ws = ws_root / ref.lower()
        if stage == "architecture":
            (ws / "PLAN.md").write_text("# plan\n")
        elif stage == "red":
            (ws / "tests" / "test_b2.py").write_text("def test_b2():\n    assert False\n")
        elif stage == "green":
            (ws / "src" / "b2.py").write_text("done = True\n")
            if green_cheats:
                (ws / "tests" / "test_b2.py").write_text("def test_b2():\n    assert True\n")
        sha = _commit_all(ws, f"{ref}: {stage}") if stage != "review" else \
            _git(ws, "rev-parse", "HEAD").stdout.strip()
        job.phase = "succeeded"
        job.termination_message = _json.dumps(
            {"v": 1, "outcome": "ok",
             "detail": "APPROVE — looks right" if stage == "review" else "stage complete",
             "sha": sha})

    fake.on_observe = run


def test_git_grading_passes_an_honest_run_and_pins_shas(client, monkeypatch, tmp_path):
    _git_mode(monkeypatch, tmp_path)
    runner, fake = make_runner()
    git_backed_cluster(fake, tmp_path / "kube-ws")
    d = _approved(client, "Kube git honest")
    out = tick_until(client, runner, d["id"], lambda o: o["gate"] == "approve_merge")
    assert out["stage"] == "review" and not out["needs_human"]
    ref = out["ref"].lower()
    ws = tmp_path / "kube-ws" / ref
    assert (ws / ".git").exists() and (ws / "PLAN.md").exists()
    # gates were spawned WITH the pinned SHA of the stage they grade
    red_gate = next(m for m in fake.creations
                    if m["metadata"]["name"] == f"sf-{ref}-red-1-gate")
    env = {e["name"]: e["value"] for e in red_gate["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert len(env["SF_SHA"]) == 40
    review_gate = next(m for m in fake.creations
                       if m["metadata"]["name"] == f"sf-{ref}-review-1-gate")
    renv = {e["name"]: e["value"] for e in review_gate["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert renv["SF_REVIEW_VERDICT"].startswith("APPROVE")


def test_git_grading_catches_a_cheating_implementer(client, monkeypatch, tmp_path):
    """The gate pod says PASS with a junk hash both times; only the
    orchestrator's own git computation catches the frozen-surface change."""
    _git_mode(monkeypatch, tmp_path)
    runner, fake = make_runner()
    git_backed_cluster(fake, tmp_path / "kube-ws", green_cheats=True)
    d = _approved(client, "Kube git cheater")
    out = tick_until(client, runner, d["id"], lambda o: o["needs_human"])
    assert "Test-isolation gate" in out["needs_human_reason"]


def test_git_mode_rejects_non_hex_40_stage_sha_as_gate_failure(
    client, monkeypatch, tmp_path
):
    _git_mode(monkeypatch, tmp_path)
    runner, fake = make_runner()
    d = _approved(client, "Kube invalid stage sha")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)
    fake.finish(name, {"v": 1, "outcome": "ok", "detail": "done", "sha": "--help"})

    with SessionLocal() as db:
        runner.tick(db)
        rows = db.scalars(
            select(StageJob)
            .where(StageJob.request_id == d["id"])
            .order_by(StageJob.id)
        ).all()

    assert [(row.role, row.status) for row in rows] == [
        ("stage", "succeeded"),
        ("gate", "failed"),
    ]
    assert "40 lowercase hex" in (rows[-1].envelope or {}).get("reason", "")
    assert f"{name}-gate" not in fake.jobs


def test_last_graded_sha_ignores_malformed_recorded_sha(client):
    runner, _ = make_runner()
    d = _approved(client, "Kube malformed graded sha")
    with SessionLocal() as db:
        stage = StageJob(
            request_id=d["id"],
            stage="architecture",
            attempt=1,
            role="stage",
            job_name=f"sf-{d['ref'].lower()}-architecture-1",
            status="succeeded",
            envelope={"outcome": "ok", "sha": "--help"},
            epoch=1,
            deadline_at=utcnow(),
        )
        gate = StageJob(
            request_id=d["id"],
            stage="architecture",
            attempt=1,
            role="gate",
            job_name=f"sf-{d['ref'].lower()}-architecture-1-gate",
            status="succeeded",
            envelope=pass_verdict(),
            epoch=1,
            deadline_at=utcnow(),
        )
        db.add_all([stage, gate])
        db.commit()
        req = db.get(Request, d["id"])
        assert runner._last_graded_sha(db, req) is None


def test_retry_resets_the_branch_to_the_last_graded_sha(client, monkeypatch, tmp_path):
    """Attempt 2 must not inherit attempt 1's half-pushed commit (spec §5)."""
    _git_mode(monkeypatch, tmp_path)
    runner, fake = make_runner()
    stray_holder = {}

    import json as _json

    def run(name, job):
        if job.phase != "running":
            return
        env = {e["name"]: e["value"] for e in job.manifest["spec"]["template"]["spec"]["containers"][0]["env"]}
        ref = env.get("SF_REF", "")
        ws = tmp_path / "kube-ws" / ref.lower()
        if name.endswith("-gate"):
            if "-architecture-1-gate" in name:
                v = fail_verdict("architecture gate: PLAN.md missing")
            else:
                v = pass_verdict()
            job.phase = "succeeded"
            job.termination_message = _json.dumps(v)
            return
        if name.endswith("-architecture-1"):
            (ws / "HALFDONE.md").write_text("junk\n")     # half-pushed work
            sha = _commit_all(ws, "half done")
            stray_holder["sha"] = sha
        else:
            (ws / "PLAN.md").write_text("# plan\n")
            sha = _commit_all(ws, "plan")
        job.phase = "succeeded"
        job.termination_message = _json.dumps({"v": 1, "outcome": "ok", "detail": "d", "sha": sha})

    fake.on_observe = run
    d = _approved(client, "Kube git reset")
    ref = d["ref"].lower()
    tick_until(client, runner, d["id"],
               lambda o: any(f"sf-{ref}-architecture-2" == m["metadata"]["name"]
                             for m in fake.creations), limit=12)
    ws = tmp_path / "kube-ws" / ref
    assert not (ws / "HALFDONE.md").exists()               # reset to sf-baseline
    assert workspace.head_sha(ws) != stray_holder["sha"]


def test_kube_approve_merge_merges_the_graded_sha(client, monkeypatch, tmp_path):
    _git_mode(monkeypatch, tmp_path)
    monkeypatch.setenv("FACTORY_RUNNER", "kube")
    from fastapi.testclient import TestClient

    from app.main import create_app

    fake = FakeKubeClient()
    runner = KubeJobRunner(client=fake)
    git_backed_cluster(fake, tmp_path / "kube-ws")
    app = create_app(auto_tick=0, runner=runner)
    with TestClient(app) as c:
        d = approved_request(
            c, title="Kube git merge",
            description="Add a monthly_export function that returns the export format name.")
        out = d
        for _ in range(40):
            if out["gate"] == "approve_merge":
                break
            c.post("/api/simulator/tick")
            out = c.get(f"/api/requests/{d['id']}").json()
        assert out["gate"] == "approve_merge"
        ws = tmp_path / "kube-ws" / d["ref"].lower()
        graded = workspace.head_sha(ws, f"work/{d['ref'].lower()}")
        done = c.post(f"/api/requests/{d['id']}/approve", json={"operator_id": 1}).json()
        assert done["status"] == "done" and done["stage"] == "done"
        assert _git(ws, "merge-base", "--is-ancestor", graded, "main").returncode == 0
    shutil.rmtree(tmp_path / "kube-ws", ignore_errors=True)


def test_kube_approve_merge_without_remote_never_builds_workspace_path(monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "")
    monkeypatch.setattr(
        workspace,
        "workspace_for",
        lambda req: (_ for _ in ()).throw(AssertionError("workspace path built")),
    )
    called = {}
    monkeypatch.setattr(
        simulator,
        "approve_merge",
        lambda db, req, actor: called.update(req=req, actor=actor),
    )
    req = Request(ref="malformed-on-purpose")

    KubeJobRunner(client=FakeKubeClient()).approve_merge(None, req, "operator")

    assert called == {"req": req, "actor": "operator"}


def test_terminal_delete_is_uid_preconditioned(client):
    runner, fake = make_runner()
    d = _approved(client, "Kube uid precondition delete")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(select(StageJob).where(StageJob.job_name == name))
        recorded_uid = row.job_uid
    fake.finish(name, stage_ok())

    with SessionLocal() as db:
        runner.tick(db)

    assert (name, recorded_uid) in fake.deletion_uids
