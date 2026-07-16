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

import pytest
from fake_github import FakeGitHub
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

from app import cost, intents, settings, simulator, transitions, workspace
from app import kube_runner as kube_runner_module
from app.db import SessionLocal
from app.kube_jobs import job_name
from app.kube_runner import GATE_INFRA_LIMIT, KubeJobRunner
from app.leader import get_elector
from app.models import Intent, Request, StageJob, utcnow
from app.ws_exec import _git


@pytest.fixture(autouse=True)
def _legacy_tests_do_not_share_a_fairness_pool(monkeypatch):
    """Each test creates a fresh fake cluster but the module shares one DB.

    Keep unrelated historical tests work-conserving despite fake-cluster
    orphans. The dedicated fairness test overrides this with the real cap.
    """
    monkeypatch.setattr(settings, "PER_APP_CAP", 10_000)


def make_runner() -> tuple[KubeJobRunner, FakeKubeClient]:
    fake = FakeKubeClient()
    return KubeJobRunner(client=fake), fake


def test_rewind_supersede_ignores_preview_and_deploy_rows(client):
    request = approved_request(client, title="Preview rewind row lanes")
    runner, _fake = make_runner()
    entered = utcnow()
    old = entered - timedelta(seconds=30)
    deadline = entered + timedelta(minutes=5)

    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        req.stage = "architecture"
        req.stage_entered_at = entered
        rows = [
            StageJob(request_id=req.id, stage="architecture", attempt=1, role="stage",
                     job_name=f"{req.ref.lower()}-architecture", status="succeeded",
                     created_at=old, deadline_at=deadline),
            StageJob(request_id=req.id, stage="red", attempt=1, role="stage",
                     job_name=f"{req.ref.lower()}-red", status="succeeded",
                     created_at=old, deadline_at=deadline),
            StageJob(request_id=req.id, stage="review", attempt=1, role="gate",
                     job_name=f"{req.ref.lower()}-review", status="succeeded",
                     created_at=old, deadline_at=deadline),
            StageJob(request_id=req.id, stage="preview", attempt=1, role="pdeploy",
                     job_name=f"{req.ref.lower()}-preview", status="succeeded",
                     created_at=old, deadline_at=deadline),
            StageJob(request_id=req.id, stage="deploy", attempt=1, role="build",
                     job_name=f"{req.ref.lower()}-deploy", status="succeeded",
                     created_at=old, deadline_at=deadline),
        ]
        db.add_all(rows)
        db.commit()

        runner._supersede_rewound_rows(db, req, rows)

        by_stage = {row.stage: row.status for row in rows}
        assert by_stage["architecture"] == "superseded"
        assert by_stage["red"] == "superseded"
        assert by_stage["review"] == "superseded"
        assert by_stage["preview"] == "succeeded"
        assert by_stage["deploy"] == "succeeded"


def test_github_dependency_is_injectable_and_lazy(monkeypatch):
    fake_kube = FakeKubeClient()
    injected = FakeGitHub("octocat")
    runner = KubeJobRunner(client=fake_kube, github=injected)

    assert runner.github is injected

    import app.github as github_module

    constructed = []

    def make_github():
        constructed.append(True)
        return injected

    monkeypatch.setattr(github_module, "GitHub", make_github)
    lazy = KubeJobRunner(client=fake_kube)
    assert lazy._github is None
    assert lazy.github is injected
    assert lazy.github is injected
    assert constructed == [True]


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


def test_zero_acceptance_coverage_never_blocks_review_gate(client, monkeypatch):
    runner, _fake = make_runner()
    request = approved_request(client, title="Zero AC coverage is advisory")
    monkeypatch.setattr(settings, "ACCEPTANCE", True)
    monkeypatch.setattr(
        runner,
        "_coverage_at_stage",
        lambda *_args: {
            "total_count": 2,
            "covered_count": 0,
            "coverage": 0.0,
            "distinct_covering_nodes": 0,
            "max_fanin": 2,
            "per_ac": {"AC-1": False, "AC-2": False},
        },
    )
    moved = []
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        red_gate = StageJob(
            request_id=req.id,
            stage="red",
            attempt=1,
            role="gate",
            job_name=f"{req.ref.lower()}-red-gate",
            deadline_at=utcnow() + timedelta(minutes=5),
        )
        db.add(red_gate)
        db.commit()
        runner._grade(
            db,
            req,
            red_gate,
            "succeeded",
            pass_verdict(),
            moved,
        )
        assert red_gate.status == "succeeded"
        req.stage = "review"
        review_stage = StageJob(
            request_id=req.id,
            stage="review",
            attempt=1,
            role="stage",
            job_name=f"{req.ref.lower()}-review-stage",
            status="succeeded",
            envelope={"detail": "APPROVE"},
            logs_tail='{"type":"review","text":"Coverage is advisory."}',
            deadline_at=utcnow() + timedelta(minutes=5),
        )
        gate = StageJob(
            request_id=req.id,
            stage="review",
            attempt=1,
            role="gate",
            job_name=f"{req.ref.lower()}-review-gate",
            deadline_at=utcnow() + timedelta(minutes=5),
        )
        db.add_all([review_stage, gate])
        db.commit()
        runner._grade(
            db,
            req,
            gate,
            "succeeded",
            pass_verdict(metrics=GOOD_METRICS),
            moved,
        )
        db.refresh(req)
        assert req.gate == transitions.GATE_APPROVE_MERGE
        event = db.scalar(
            select(kube_runner_module.ProgressEvent)
            .where(
                kube_runner_module.ProgressEvent.request_id == req.id,
                kube_runner_module.ProgressEvent.kind == "verification",
            )
            .order_by(kube_runner_module.ProgressEvent.id.desc())
        )
        assert event.payload["covered_count"] == 0
        assert event.payload["ac_coverage"] == 0.0


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
        elif "-review-" in name:
            v = stage_ok("APPROVE")
        else:
            v = stage_ok()
        import json as _json
        job.phase = "succeeded"
        job.termination_message = _json.dumps(v)
        if "-review-" in name and not name.endswith("-gate"):
            job.logs = '{"type":"review","text":"Evidence is incomplete."}\n'
    fake.on_observe = run

    d = _approved(client, "Kube empty evidence")
    out = tick_until(client, runner, d["id"], lambda o: o["needs_human"])
    assert "Verification could not be built" in out["needs_human_reason"]
    assert out["gate"] != "approve_merge"


def test_fairness_per_app_cap_and_queue_position(client, monkeypatch):
    """One app cannot consume the fleet; capped siblings remain discoverable."""
    monkeypatch.setattr(settings, "KUBE_JOB_CAP", 3)
    monkeypatch.setattr(settings, "PER_APP_CAP", 2)
    runner, fake = make_runner()  # nothing completes: jobs stay running
    with SessionLocal() as db:
        for row in db.scalars(
            select(StageJob).where(StageJob.status == "running")
        ).all():
            row.status = "reaped"
            row.completed_at = utcnow()
        db.commit()
    apps = client.get("/api/apps").json()
    a = [
        approved_request(client, title=f"Kube fairness A{i}", app_id=apps[0]["id"])
        for i in range(4)
    ]
    b = approved_request(client, title="Kube fairness B", app_id=apps[1]["id"])
    target_ids = [request["id"] for request in [*a, b]]
    monkeypatch.setattr(
        cost,
        "runnable_requests",
        lambda db: [db.get(Request, request_id) for request_id in target_ids],
    )
    with SessionLocal() as db:
        runner.tick(db)
        runner.tick(db)
    spawned = [m["metadata"]["name"] for m in fake.creations]
    assert len(spawned) == 3
    assert sum(any(item["ref"].lower() in name for item in a) for name in spawned) == 2
    assert any(b["ref"].lower() in name for name in spawned)

    first_waiter = client.get(f"/api/requests/{a[2]['id']}/cost").json()
    second_waiter = client.get(f"/api/requests/{a[3]['id']}/cost").json()
    assert first_waiter["queue_position"] == 1
    assert second_waiter["queue_position"] == 2
    for request in [*a, b]:
        client.post(
            f"/api/requests/{request['id']}/cancel", json={"operator_id": 1}
        )
    with SessionLocal() as db:
        for row in db.scalars(
            select(StageJob).where(
                StageJob.request_id.in_([request["id"] for request in [*a, b]]),
                StageJob.status == "running",
            )
        ).all():
            row.status = "reaped"
            row.completed_at = utcnow()
        db.commit()


def _make_pipeline_build_ready(db, request_id: int) -> None:
    req = db.get(Request, request_id)
    now = utcnow()
    req.stage = "build"
    req.gate = None
    req.needs_human = False
    req.stage_entered_at = now
    db.add(
        StageJob(
            request_id=req.id,
            stage="architecture",
            attempt=1,
            role="gate",
            job_name=f"{req.ref.lower()}-architecture-gate-complete",
            status="succeeded",
            created_at=now,
            completed_at=now,
            deadline_at=now,
        )
    )


def _make_preview_build_ready(db, request_id: int) -> None:
    req = db.get(Request, request_id)
    req.stage = "preview"
    req.gate = None
    req.needs_human = False


def _clear_scheduler_candidates(db) -> None:
    now = utcnow()
    for req in db.scalars(select(Request)).all():
        if req.status == transitions.APPROVED:
            req.status = transitions.DONE
    for row in db.scalars(
        select(StageJob).where(StageJob.status == "running")
    ).all():
        row.status = "reaped"
        row.completed_at = now
    db.commit()


def test_build_slot_goes_to_older_pipeline_before_newer_preview(
    client, monkeypatch
):
    monkeypatch.setattr(settings, "BUILD_CAP", 1)
    monkeypatch.setattr(settings, "KUBE_JOB_CAP", 10)
    monkeypatch.setattr(settings, "preview_enabled", lambda: True)
    monkeypatch.setattr(settings, "app_deploy_enabled", lambda: False)
    runner, fake = make_runner()
    monkeypatch.setattr(runner, "_last_graded_sha", lambda *_args: "a" * 40)
    with SessionLocal() as db:
        _clear_scheduler_candidates(db)

    older = approved_request(client, title="Older pipeline build")
    newer = approved_request(client, title="Newer preview build")
    with SessionLocal() as db:
        _make_pipeline_build_ready(db, older["id"])
        _make_preview_build_ready(db, newer["id"])
        db.commit()

        assert cost.queue_position(db, older["id"]) is None
        assert cost.queue_position(db, newer["id"]) == 1
        runner.tick(db)

        running = db.scalars(
            select(StageJob).where(
                StageJob.status == "running",
                StageJob.request_id.in_((older["id"], newer["id"])),
            )
        ).all()

    assert [(row.request_id, row.role, row.stage) for row in running] == [
        (older["id"], "stage", "red")
    ]
    assert [manifest["metadata"]["name"] for manifest in fake.creations] == [
        job_name(older["ref"], "red", 1)
    ]


def test_preview_backlog_cannot_starve_older_pipeline_build(client, monkeypatch):
    monkeypatch.setattr(settings, "BUILD_CAP", 1)
    monkeypatch.setattr(settings, "KUBE_JOB_CAP", 20)
    monkeypatch.setattr(settings, "preview_enabled", lambda: True)
    monkeypatch.setattr(settings, "app_deploy_enabled", lambda: False)
    runner, fake = make_runner()
    monkeypatch.setattr(runner, "_last_graded_sha", lambda *_args: "b" * 40)
    with SessionLocal() as db:
        _clear_scheduler_candidates(db)

    holder = approved_request(client, title="Existing build-slot holder")
    older = approved_request(client, title="Pipeline waiting behind holder")
    previews = [
        approved_request(client, title=f"Sustained preview backlog {index}")
        for index in range(3)
    ]
    with SessionLocal() as db:
        holder_req = db.get(Request, holder["id"])
        holder_req.stage = "deploy"
        holder_req.gate = transitions.GATE_APPROVE_DEPLOY
        now = utcnow()
        holder_job = StageJob(
            request_id=holder_req.id,
            stage="deploy",
            attempt=1,
            role="build",
            job_name=f"{holder_req.ref.lower()}-build-holder",
            status="running",
            deadline_at=now + timedelta(minutes=5),
        )
        db.add(holder_job)
        _make_pipeline_build_ready(db, older["id"])
        for preview in previews:
            _make_preview_build_ready(db, preview["id"])
        db.commit()

        for _ in range(3):
            runner.tick(db)
            assert not db.scalars(
                select(StageJob).where(
                    StageJob.request_id.in_(
                        [older["id"], *(preview["id"] for preview in previews)]
                    ),
                    StageJob.status == "running",
                )
            ).all()

        holder_job.status = "succeeded"
        holder_job.completed_at = utcnow()
        db.commit()
        runner.tick(db)

        started = db.scalars(
            select(StageJob).where(
                StageJob.request_id.in_(
                    [older["id"], *(preview["id"] for preview in previews)]
                ),
                StageJob.status == "running",
            )
        ).all()

    assert [(row.request_id, row.role, row.stage) for row in started] == [
        (older["id"], "stage", "red")
    ]
    assert [manifest["metadata"]["name"] for manifest in fake.creations] == [
        job_name(older["ref"], "red", 1)
    ]


def test_finished_newer_build_stage_cannot_keep_slot_for_its_gate(
    client, monkeypatch
):
    monkeypatch.setattr(settings, "BUILD_CAP", 1)
    monkeypatch.setattr(settings, "KUBE_JOB_CAP", 10)
    runner, fake = make_runner()
    with SessionLocal() as db:
        _clear_scheduler_candidates(db)

    older = approved_request(client, title="Older build waiting for slot")
    newer = approved_request(client, title="Newer build finishing stage")
    with SessionLocal() as db:
        _make_pipeline_build_ready(db, older["id"])
        _make_pipeline_build_ready(db, newer["id"])
        db.commit()
        newer_req = db.get(Request, newer["id"])
        assert runner._spawn_next(db, newer_req, []) is True

    newer_stage_name = job_name(newer["ref"], "red", 1)
    fake.finish(newer_stage_name, stage_ok())
    with SessionLocal() as db:
        runner.tick(db)
        running = db.scalars(
            select(StageJob).where(
                StageJob.request_id.in_((older["id"], newer["id"])),
                StageJob.status == "running",
            )
        ).all()

    assert [(row.request_id, row.role, row.stage) for row in running] == [
        (older["id"], "stage", "red")
    ]
    assert [manifest["metadata"]["name"] for manifest in fake.creations] == [
        newer_stage_name,
        job_name(older["ref"], "red", 1),
    ]


def test_review_to_build_rewind_is_classified_as_build_slot_work(
    client, monkeypatch
):
    monkeypatch.setattr(settings, "BUILD_CAP", 1)
    monkeypatch.setattr(settings, "KUBE_JOB_CAP", 10)
    runner, fake = make_runner()
    with SessionLocal() as db:
        _clear_scheduler_candidates(db)

    holder = approved_request(client, title="Rewind build-slot holder")
    rewind = approved_request(client, title="Review sent back to build")
    with SessionLocal() as db:
        now = utcnow()
        holder_req = db.get(Request, holder["id"])
        holder_req.stage = "deploy"
        holder_req.gate = transitions.GATE_APPROVE_DEPLOY
        db.add(
            StageJob(
                request_id=holder_req.id,
                stage="deploy",
                attempt=1,
                role="build",
                job_name=f"{holder_req.ref.lower()}-rewind-holder",
                status="running",
                deadline_at=now + timedelta(minutes=5),
            )
        )
        req = db.get(Request, rewind["id"])
        req.stage = "build"
        req.gate = None
        req.stage_entered_at = now
        old = now - timedelta(minutes=1)
        db.add_all(
            [
                StageJob(
                    request_id=req.id,
                    stage=stage,
                    attempt=1,
                    role=role,
                    job_name=f"{req.ref.lower()}-{stage}-{role}-before-rewind",
                    status="succeeded",
                    created_at=old,
                    completed_at=old,
                    deadline_at=old,
                )
                for stage, role in (
                    ("architecture", "gate"),
                    ("red", "gate"),
                    ("green", "gate"),
                    ("review", "stage"),
                )
            ]
        )
        db.commit()

        assert cost.queue_position(db, req.id) == 1
        runner.tick(db)
        assert not db.scalars(
            select(StageJob).where(
                StageJob.request_id == req.id,
                StageJob.status == "running",
            )
        ).all()

    assert fake.creations == []


def test_preview_capacity_wait_does_not_reserve_build_queue_position(
    client, monkeypatch
):
    monkeypatch.setattr(settings, "BUILD_CAP", 1)
    monkeypatch.setattr(settings, "KUBE_JOB_CAP", 10)
    monkeypatch.setattr(settings, "PREVIEW_CAP", 1)
    monkeypatch.setattr(settings, "preview_enabled", lambda: True)
    monkeypatch.setattr(settings, "app_deploy_enabled", lambda: False)
    runner, fake = make_runner()
    with SessionLocal() as db:
        _clear_scheduler_candidates(db)

    active = approved_request(client, title="Active preview environment")
    blocked = approved_request(client, title="Preview waiting for environment")
    pipeline = approved_request(client, title="Pipeline behind preview-cap waiter")
    with SessionLocal() as db:
        _make_preview_build_ready(db, active["id"])
        _make_preview_build_ready(db, blocked["id"])
        now = utcnow()
        db.add(
            StageJob(
                request_id=active["id"],
                stage="preview",
                attempt=1,
                role="pdeploy",
                job_name=f"{active['ref'].lower()}-active-preview",
                status="succeeded",
                deadline_at=now,
                completed_at=now,
                envelope={"round": 0, "digest": "sha256:" + "c" * 64},
            )
        )
        db.commit()

        assert cost.queue_position(db, blocked["id"]) is None
        assert cost.queue_position(db, pipeline["id"]) is None
        runner.tick(db)

        pipeline_job = db.scalar(
            select(StageJob).where(
                StageJob.request_id == pipeline["id"],
                StageJob.status == "running",
            )
        )

    assert pipeline_job is not None and pipeline_job.stage == "architecture"
    assert [manifest["metadata"]["name"] for manifest in fake.creations] == [
        job_name(pipeline["ref"], "architecture", 1)
    ]


def test_preview_build_spawn_respects_per_app_kube_cap(client, monkeypatch):
    monkeypatch.setattr(settings, "KUBE_JOB_CAP", 10)
    monkeypatch.setattr(settings, "PER_APP_CAP", 2)
    monkeypatch.setattr(settings, "preview_enabled", lambda: True)
    runner, fake = make_runner()
    app_id = client.get("/api/apps").json()[0]["id"]
    requests = [
        approved_request(client, title=f"Preview fair share {i}", app_id=app_id)
        for i in range(3)
    ]
    now = utcnow()
    with SessionLocal() as db:
        for request in requests[:2]:
            req = db.get(Request, request["id"])
            started = transitions.apply(
                db,
                req,
                "begin_preview",
                actor=transitions.FACTORY,
                epoch=get_elector().epoch,
            )
            assert isinstance(started, transitions.Win)
            db.add(
                StageJob(
                    request_id=request["id"],
                    stage="preview",
                    attempt=1,
                    role="pbuild",
                    job_name=f"preview-cap-{request['id']}",
                    status="running",
                    created_at=now,
                    deadline_at=now + timedelta(minutes=5),
                    envelope={"round": 0},
                )
            )
        target = db.get(Request, requests[2]["id"])
        started = transitions.apply(
            db,
            target,
            "begin_preview",
            actor=transitions.FACTORY,
            epoch=get_elector().epoch,
        )
        assert isinstance(started, transitions.Win)
        db.commit()
        moved = []
        runner._spawn_preview_build(db, target, "preview-cap", 0, moved)

    assert fake.creations == []
    assert moved == [f"{requests[2]['ref']}: waiting for a build slot"]
    assert client.get(f"/api/requests/{requests[2]['id']}/cost").json()[
        "queue_position"
    ] is not None

    for request in requests:
        client.post(
            f"/api/requests/{request['id']}/cancel", json={"operator_id": 1}
        )
    with SessionLocal() as db:
        for row in db.scalars(
            select(StageJob).where(
                StageJob.request_id.in_([request["id"] for request in requests]),
                StageJob.status == "running",
            )
        ).all():
            row.status = "reaped"
            row.completed_at = utcnow()
        db.commit()


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


def test_request_attempt_budget_blocks_a_further_human_retry(client, monkeypatch):
    monkeypatch.setattr(settings, "REQUEST_ATTEMPT_BUDGET", 2)
    runner, fake = make_runner()
    d = _approved(client, "Kube lifetime attempt budget")
    now = utcnow()
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        db.add_all(
            [
                StageJob(
                    request_id=req.id,
                    stage="architecture",
                    attempt=attempt,
                    role="stage",
                    job_name=f"{req.ref.lower()}-architecture-{attempt}",
                    status="failed",
                    created_at=now - timedelta(minutes=attempt),
                    completed_at=now,
                    deadline_at=now + timedelta(minutes=5),
                )
                for attempt in (1, 2)
            ]
        )
        escalated = transitions.apply(
            db,
            req,
            "escalate",
            actor=transitions.FACTORY,
            params={"reason": "prior attempts failed"},
            epoch=get_elector().epoch,
        )
        assert isinstance(escalated, transitions.Win)
        db.commit()

    response = client.post(
        f"/api/requests/{d['id']}/retry",
        json={"operator_id": 1, "note": "one more"},
    )
    assert response.status_code == 200
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        runner._spawn_next(db, req, [])

    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is True
    assert "attempt budget exhausted" in out["needs_human_reason"].lower()
    assert not any(d["ref"].lower() in m["metadata"]["name"] for m in fake.creations)


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


def test_hung_gate_infra_loop_escalates_without_consuming_attempt(client):
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
    ]
    with SessionLocal() as db:
        rows = db.scalars(
            select(StageJob).where(StageJob.request_id == d["id"])
        ).all()
    assert {row.attempt for row in rows} == {1}
    assert all(row.status == "infra" for row in rows if row.role == "gate")


def test_gate_infra_bound_resets_after_human_retry(client):
    runner, fake = make_runner()

    def fail_gate(name, job):
        if job.phase != "running":
            return
        if not name.endswith("-gate"):
            job.phase = "succeeded"
            job.termination_message = json.dumps(stage_ok())
            return
        job.phase = "failed"

    fake.on_observe = fail_gate
    d = _approved(client, "Kube gate infra resets")
    ref = d["ref"].lower()
    tick_until(client, runner, d["id"], lambda out: out["needs_human"])
    response = client.post(
        f"/api/requests/{d['id']}/retry",
        json={"operator_id": 1, "note": "gate infrastructure recovered"},
    )
    assert response.status_code == 200, response.text
    honest_cluster(fake)
    tick_until(
        client, runner, d["id"], lambda _out: f"sf-{ref}-red-1" in fake.jobs
    )

    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is False
    gates = [
        manifest["metadata"]["name"]
        for manifest in fake.creations
        if manifest["metadata"]["name"].endswith("architecture-1-gate")
    ]
    assert gates == [f"sf-{ref}-architecture-1-gate"] * 4


def test_gate_infra_sentinel_escalates_without_burning_attempt(client):
    runner, fake = make_runner()

    def quota_gate(name, job):
        if job.phase != "running":
            return
        if name.endswith("-gate"):
            fake.finish(
                name,
                {"outcome": "infra", "reason": "quota"},
                phase="failed",
            )
        else:
            fake.finish(name, stage_ok())

    fake.on_observe = quota_gate
    request = _approved(client, "Kube gate quota infra")
    out = tick_until(
        client, runner, request["id"], lambda value: value["needs_human"]
    )
    assert "quota" in out["needs_human_reason"]
    with SessionLocal() as db:
        rows = db.scalars(
            select(StageJob).where(StageJob.request_id == request["id"])
        ).all()
    assert {row.attempt for row in rows} == {1}
    assert all(row.status == "infra" for row in rows if row.role == "gate")


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


def test_infra_then_succeeded_stage_spawns_gate_not_respawn(client):
    runner, fake = make_runner()
    request = _approved(client, "Kube infra-then-succeeded")
    name = f"sf-{request['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(select(StageJob).where(StageJob.job_name == name))
        row.status = "infra"
        row.completed_at = utcnow()
        db.add(
            StageJob(
                request_id=request["id"],
                stage="architecture",
                attempt=1,
                role="stage",
                job_name=name,
                epoch=row.epoch,
                status="succeeded",
                envelope={"outcome": "ok", "sha": "0" * 40},
                deadline_at=utcnow() + timedelta(seconds=60),
            )
        )
        db.commit()
    with SessionLocal() as db:
        runner.tick(db)

    assert f"{name}-gate" in fake.jobs
    with SessionLocal() as db:
        stage_rows = db.scalars(
            select(StageJob).where(
                StageJob.request_id == request["id"],
                StageJob.role == "stage",
            )
        ).all()
    assert len(stage_rows) == 2


def test_infra_then_failed_stage_uses_newest_failure(client):
    """Adjacent review case: newest failed beats an older same-attempt park."""
    runner, _fake = make_runner()
    request = _approved(client, "Kube infra-then-failed")
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        deadline = utcnow() + timedelta(seconds=60)
        for status in ("infra", "failed"):
            db.add(
                StageJob(
                    request_id=req.id,
                    stage="architecture",
                    attempt=1,
                    role="stage",
                    job_name=f"sf-{req.ref.lower()}-architecture-1",
                    epoch=1,
                    status=status,
                    deadline_at=deadline,
                )
            )
        db.commit()
        assert runner._next_work(db, req, [])[:3] == ("stage", "architecture", 2)


def test_stage_stranger_park_loop_caps_and_escalates(client):
    from fake_kube import FakeJob

    from app.kube_jobs import stage_job_manifest

    runner, fake = make_runner()
    request = _approved(client, "Kube stage stranger loop")
    name = f"sf-{request['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)
    fake.jobs[name] = FakeJob(
        manifest=stage_job_manifest(request["ref"], "architecture", 1),
        uid="uid-stranger",
    )
    with SessionLocal() as db:
        runner.tick(db)
    for _ in range(6):
        fake.conflicts.add(name)
        with SessionLocal() as db:
            runner.tick(db)
        if client.get(f"/api/requests/{request['id']}").json()["needs_human"]:
            break

    out = client.get(f"/api/requests/{request['id']}").json()
    assert out["needs_human"] is True
    assert "infra loop" in out["needs_human_reason"]
    with SessionLocal() as db:
        infra = db.scalars(
            select(StageJob).where(
                StageJob.request_id == request["id"],
                StageJob.role == "stage",
                StageJob.status == "infra",
            )
        ).all()
    assert len(infra) == GATE_INFRA_LIMIT
    assert f"{name}-gate" not in fake.jobs


def test_gate_stranger_park_loop_caps_and_escalates(client):
    from fake_kube import FakeJob

    from app.kube_jobs import gate_job_manifest

    runner, fake = make_runner()
    request = _approved(client, "Kube gate stranger loop")
    name = f"sf-{request['ref'].lower()}-architecture-1"
    gate_name = f"{name}-gate"
    with SessionLocal() as db:
        runner.tick(db)
    fake.finish(name, stage_ok())
    with SessionLocal() as db:
        runner.tick(db)
    fake.jobs[gate_name] = FakeJob(
        manifest=gate_job_manifest(request["ref"], "architecture", 1),
        uid="uid-stranger",
    )
    with SessionLocal() as db:
        runner.tick(db)
    for _ in range(6):
        fake.conflicts.add(gate_name)
        with SessionLocal() as db:
            runner.tick(db)
        if client.get(f"/api/requests/{request['id']}").json()["needs_human"]:
            break

    out = client.get(f"/api/requests/{request['id']}").json()
    assert out["needs_human"] is True
    assert "infra loop" in out["needs_human_reason"]


def test_dying_predecessor_park_is_time_bounded_not_count_bounded(client):
    runner, fake = make_runner()
    request = _approved(client, "Kube predecessor grace")
    name = f"sf-{request['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)
        first = db.scalar(select(StageJob).where(StageJob.job_name == name))
        first_uid = fake.jobs[name].uid
        first.status = "infra"
        first.completed_at = utcnow()
        first.envelope = {"infra_cause": "predecessor"}
        db.commit()
    for _ in range(5):
        fake.conflicts.add(name)
        with SessionLocal() as db:
            runner.tick(db)
    assert client.get(f"/api/requests/{request['id']}").json()["needs_human"] is False
    with SessionLocal() as db:
        parks = db.scalars(
            select(StageJob).where(
                StageJob.job_name == name,
                StageJob.status == "infra",
            )
        ).all()
    assert len(parks) >= 4
    assert all((row.envelope or {}).get("infra_cause") == "predecessor" for row in parks)
    fake.jobs[name].deleted = True
    with SessionLocal() as db:
        runner.tick(db)
        fresh = db.scalar(
            select(StageJob)
            .where(StageJob.job_name == name)
            .order_by(StageJob.id.desc())
        )
    assert fresh.status == "running" and fresh.job_uid not in (None, first_uid)


def test_stuck_predecessor_past_grace_escalates(monkeypatch, client):
    monkeypatch.setattr(kube_runner_module, "PARK_PREDECESSOR_GRACE", 0)
    runner, fake = make_runner()
    request = _approved(client, "Kube stuck predecessor")
    name = f"sf-{request['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        runner.tick(db)
        first = db.scalar(select(StageJob).where(StageJob.job_name == name))
        first.status = "infra"
        first.completed_at = utcnow()
        first.envelope = {"infra_cause": "predecessor"}
        db.commit()
    for _ in range(6):
        fake.conflicts.add(name)
        with SessionLocal() as db:
            runner.tick(db)
        if client.get(f"/api/requests/{request['id']}").json()["needs_human"]:
            break
    out = client.get(f"/api/requests/{request['id']}").json()
    assert out["needs_human"] is True
    assert "infra loop" in out["needs_human_reason"]


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


def test_captured_logs_tail_is_capped_by_utf8_bytes(client, monkeypatch):
    monkeypatch.setattr(settings, "LOGS_TAIL_MAX", 5)
    runner, fake = make_runner()
    d = _approved(client, "Kube bounded log tail")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        assert runner._spawn_next(db, req, []) is True
    fake.finish(name, stage_ok(), logs="0123456789")

    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        row = db.scalar(select(StageJob).where(StageJob.job_name == name))
        runner._observe(db, req, row, [])
        assert row.logs_tail == "56789"
        assert len(row.logs_tail.encode()) <= settings.LOGS_TAIL_MAX


def test_captured_stage_stdout_is_scrubbed_before_logs_tail_is_stored(client):
    runner, fake = make_runner()
    d = _approved(client, "Kube source log scrub")
    name = f"sf-{d['ref'].lower()}-architecture-1"
    token = "ghp_" + "S" * 36
    with SessionLocal() as db:
        runner.tick(db)
    fake.finish(
        name,
        stage_ok(),
        logs=f'{{"type":"note","text":"leaked {token}"}}\n',
    )

    with SessionLocal() as db:
        runner.tick(db)
        row = db.scalar(select(StageJob).where(StageJob.job_name == name))

    assert row.status == "succeeded"
    assert token not in (row.logs_tail or "")
    assert "***" in (row.logs_tail or "")


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


def _github_mode(monkeypatch, tmp_path):
    _git_mode(monkeypatch, tmp_path)
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "test-token")
    monkeypatch.setattr(settings, "GITHUB_OWNER", "octocat")


def _commit_all(ws, msg):
    _git(ws, "add", "-A")
    _git(ws, "commit", "-q", "-m", msg)
    return _git(ws, "rev-parse", "HEAD").stdout.strip()


def test_git_backed_coverage_event_and_review_evidence_are_non_blocking(
    client, monkeypatch, tmp_path
):
    _git_mode(monkeypatch, tmp_path)
    monkeypatch.setattr(settings, "ACCEPTANCE", True)
    runner = KubeJobRunner(client=FakeKubeClient())
    request = _approved(client, "Git-backed structural acceptance evidence")

    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        runner._prepare_workspace(db, req)
        ws = workspace.workspace_for(req)
        codes = [criterion.code for criterion in req.acceptance_criteria]
        tests = ws / "tests" / "test_acceptance_contract.py"
        tests.write_text(
            "\n\n".join(
                f"def test_ac_{index}():\n    assert True"
                for index, _code in enumerate(codes, 1)
            )
            + "\n"
        )
        (ws / "tests" / "acceptance.json").write_text(
            json.dumps(
                {
                    code: [
                        f"tests/test_acceptance_contract.py::test_ac_{index}"
                    ]
                    for index, code in enumerate(codes, 1)
                }
            )
        )
        sha = _commit_all(ws, "RED acceptance manifest")
        red = StageJob(
            request_id=req.id,
            stage="red",
            attempt=1,
            role="stage",
            job_name=job_name(req.ref, "red", 1),
            status="succeeded",
            envelope={"sha": sha},
            deadline_at=utcnow(),
        )
        review = StageJob(
            request_id=req.id,
            stage="review",
            attempt=1,
            role="stage",
            job_name=job_name(req.ref, "review", 1),
            status="succeeded",
            envelope={"sha": sha},
            deadline_at=utcnow(),
        )
        db.add_all([red, review])
        req.stage = "review"
        db.commit()

        runner._emit_ac_coverage(db, req, stage="red")
        runner._finish_review(
            db, req, pass_verdict(metrics=GOOD_METRICS), moved=[]
        )
        db.refresh(req)
        events = db.scalars(
            select(kube_runner_module.ProgressEvent)
            .where(kube_runner_module.ProgressEvent.request_id == req.id)
            .order_by(kube_runner_module.ProgressEvent.id)
        ).all()
        coverage = next(event for event in events if event.kind == "acceptance_coverage")
        verification_event = next(
            event for event in events if event.kind == "verification"
        )
        assert coverage.payload["covered_count"] == len(codes)
        assert coverage.payload["distinct_covering_nodes"] == len(codes)
        assert coverage.payload["max_fanin"] == 1
        assert verification_event.payload["ac_total"] == len(codes)
        assert req.gate == transitions.GATE_APPROVE_MERGE


def test_preview_change_refreshes_acceptance_contract_before_rerun(
    client, monkeypatch, tmp_path
):
    _git_mode(monkeypatch, tmp_path)
    monkeypatch.setattr(settings, "ACCEPTANCE", True)
    runner = KubeJobRunner(client=FakeKubeClient())
    request = _approved(client, "Preview acceptance refresh")
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        runner._prepare_workspace(db, req)
        ws = workspace.workspace_for(req)
        original = (ws / "ACCEPTANCE.md").read_text()
        req.stage = "preview"
        req.gate = transitions.GATE_ACCEPT_PREVIEW
        db.commit()

    response = client.post(
        f"/api/requests/{request['id']}/preview/request-changes",
        json={"operator_id": 1, "feedback": "Support the revised preview total"},
    )
    assert response.status_code == 200, response.text
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        runner._prepare_workspace(db, req)
        refreshed = (workspace.workspace_for(req) / "ACCEPTANCE.md").read_text()
        versions = {criterion.version for criterion in req.acceptance_criteria}
        assert versions == {0, 1}
        assert "Support the revised preview total." in refreshed
        assert refreshed != original


def test_github_workspace_prep_creates_and_pushes_repo_once(
    client, monkeypatch, tmp_path
):
    _github_mode(monkeypatch, tmp_path)
    github = FakeGitHub("octocat")
    runner = KubeJobRunner(client=FakeKubeClient(), github=github)
    request = _approved(client, "GitHub repo preparation")
    effects = []

    ensure_repo = github.ensure_repo

    def record_repo(slug):
        effects.append(("repo", slug))
        return ensure_repo(slug)

    def record_git(ws, *args):
        effects.append(("git", *args))
        return subprocess.CompletedProcess(args, 0, "", "")

    def record_work_push(ws, slug, ref, *, force=False):
        effects.append(("work", slug, ref, force))
        return None

    monkeypatch.setattr(github, "ensure_repo", record_repo)
    monkeypatch.setattr(kube_runner_module, "_git", record_git, raising=False)
    monkeypatch.setattr(workspace, "push_branch_to_github", record_work_push)

    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        runner._prepare_workspace(db, req)
        runner._prepare_workspace(db, req)
        row = db.get(Intent, f"repo:{req.ref}")

    assert effects[0] == ("repo", "northwind")
    assert any(effect[0] == "git" and effect[-1] == "main:main" for effect in effects)
    assert effects[-1] == ("work", "northwind", request["ref"], False)
    assert effects.count(("repo", "northwind")) == 1
    assert effects.count(("work", "northwind", request["ref"], False)) == 1
    assert row.kind == "create_repo" and row.status == "done"
    assert json.loads(row.payload_json) == {"slug": "northwind"}
    assert json.loads(row.outcome_json)["clone_url"].endswith("/sf-app-northwind.git")


@pytest.mark.parametrize("intent_status", ["pending", "failed"])
def test_incomplete_repo_intent_replays_idempotent_setup_and_completes(
    client, monkeypatch, tmp_path, intent_status
):
    _github_mode(monkeypatch, tmp_path)
    github = FakeGitHub("octocat")
    runner = KubeJobRunner(client=FakeKubeClient(), github=github)
    request = _approved(client, "GitHub incomplete repo intent")
    effects = []
    monkeypatch.setattr(
        kube_runner_module,
        "_git",
        lambda _ws, *args: effects.append(("main", args[-1]))
        or subprocess.CompletedProcess(args, 0, "", ""),
    )
    monkeypatch.setattr(
        workspace,
        "push_branch_to_github",
        lambda _ws, slug, ref, *, force=False: effects.append(
            ("work", slug, ref, force)
        )
        or None,
    )
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        runner._prepare_workspace(db, req)
        row = db.get(Intent, f"repo:{req.ref}")
        row.status = intent_status
        row.outcome_json = "{}"
        db.commit()
        db.expunge(row)
        effects.clear()

        runner._prepare_workspace(db, req)
        row = db.get(Intent, f"repo:{req.ref}")

    assert effects == [
        ("main", "main:main"),
        ("work", "northwind", request["ref"], False),
    ]
    assert [call[0] for call in github.calls].count("ensure_repo") == 2
    assert row.status == "done"


def test_repo_push_error_escalates_without_spawning_stage(
    client, monkeypatch, tmp_path
):
    _github_mode(monkeypatch, tmp_path)
    github = FakeGitHub("octocat")
    fake = FakeKubeClient()
    runner = KubeJobRunner(client=fake, github=github)
    request = _approved(client, "GitHub repo push failure")
    monkeypatch.setattr(
        kube_runner_module,
        "_git",
        lambda _ws, *args: subprocess.CompletedProcess(
            args, 1, "", "remote rejected baseline"
        ),
    )

    with SessionLocal() as db:
        runner.tick(db)
        req = db.get(Request, request["id"])
        repo_intent = db.get(Intent, f"repo:{req.ref}")
        assert req.needs_human
        assert "remote rejected baseline" in req.needs_human_reason
        assert repo_intent.status == "failed"

    assert not any(
        manifest["metadata"]["labels"]["sf/request"] == request["ref"].lower()
        for manifest in fake.creations
    )


def test_github_retry_reset_force_pushes_after_reset_and_escalates_on_error(
    client, monkeypatch, tmp_path
):
    _github_mode(monkeypatch, tmp_path)
    github = FakeGitHub("octocat")
    runner = KubeJobRunner(client=FakeKubeClient(), github=github)
    request = _approved(client, "GitHub retry rewind")
    monkeypatch.setattr(
        kube_runner_module,
        "_git",
        lambda _ws, *args: subprocess.CompletedProcess(args, 0, "", ""),
        raising=False,
    )
    monkeypatch.setattr(
        workspace, "push_branch_to_github", lambda *_args, **_kwargs: None
    )
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        runner._prepare_workspace(db, req)
        ws = workspace.workspace_for(req)
    (ws / "HALFDONE.md").write_text("stray work\n")
    _commit_all(ws, "half done")

    force_calls = []

    def reject_force(push_ws, slug, ref, *, force=False):
        if ref != request["ref"]:
            return None
        force_calls.append((slug, ref, force, workspace.head_sha(push_ws)))
        return "remote rejected force push"

    monkeypatch.setattr(workspace, "push_branch_to_github", reject_force)
    with SessionLocal() as db:
        runner.tick(db)
        req = db.get(Request, request["id"])
        assert req.needs_human
        assert "remote rejected force push" in req.needs_human_reason

    assert force_calls == [
        ("northwind", request["ref"], True, workspace.head_sha(ws, workspace.BASELINE_TAG))
    ]


def test_github_retry_force_pushes_even_when_local_head_is_already_at_target(
    client, monkeypatch, tmp_path
):
    _github_mode(monkeypatch, tmp_path)
    github = FakeGitHub("octocat")
    fake = FakeKubeClient()
    runner = KubeJobRunner(client=fake, github=github)
    request = _approved(client, "GitHub remote-only stale retry")
    monkeypatch.setattr(
        kube_runner_module,
        "_git",
        lambda _ws, *args: subprocess.CompletedProcess(args, 0, "", ""),
    )
    pushes = []
    monkeypatch.setattr(
        workspace,
        "push_branch_to_github",
        lambda _ws, slug, ref, *, force=False: pushes.append((slug, ref, force))
        or None,
    )
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        runner._prepare_workspace(db, req)
        pushes.clear()
        db.add(
            StageJob(
                request_id=req.id,
                stage="architecture",
                attempt=1,
                role="stage",
                job_name=job_name(req.ref, "architecture", 1),
                status="failed",
                epoch=1,
                deadline_at=utcnow(),
            )
        )
        db.commit()

        assert runner._spawn_stage(db, req, "architecture", 2, "retry", [])

    assert pushes == [("northwind", request["ref"], True)]


def test_github_fetches_pinned_sha_before_gate_and_opens_architecture_pr_once(
    client, monkeypatch, tmp_path
):
    _github_mode(monkeypatch, tmp_path)
    github = FakeGitHub("octocat")
    fake = FakeKubeClient()
    runner = KubeJobRunner(client=fake, github=github)
    request = _approved(client, "GitHub fetch and pull request")
    monkeypatch.setattr(
        kube_runner_module,
        "_git",
        lambda _ws, *args: subprocess.CompletedProcess(args, 0, "", ""),
        raising=False,
    )
    monkeypatch.setattr(
        workspace, "push_branch_to_github", lambda *_args, **_kwargs: None
    )
    fetches = []

    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        runner._prepare_workspace(db, req)
        ws = workspace.workspace_for(req)
        sha = workspace.head_sha(ws)
        stage = StageJob(
            request_id=req.id,
            stage="architecture",
            attempt=1,
            role="stage",
            job_name=job_name(req.ref, "architecture", 1),
            status="succeeded",
            envelope={"outcome": "ok", "detail": "plan ready", "sha": sha},
            epoch=1,
            deadline_at=utcnow(),
        )
        db.add(stage)
        db.commit()

        def fetch_before_spawn(fetch_ws, slug, ref, *, sha=None):
            gate_name = job_name(ref, "architecture", 1, gate=True)
            assert gate_name not in fake.jobs
            fetches.append((fetch_ws, slug, ref, sha))
            return None

        monkeypatch.setattr(workspace, "fetch_ref_from_github", fetch_before_spawn)
        assert runner._spawn_gate(db, req, "architecture", 1, [])

        pr_intent = db.get(Intent, f"pr:{req.ref}")
        pr_number = json.loads(pr_intent.outcome_json)["pr_number"]
        recorded_base = json.loads(pr_intent.payload_json)["base_sha"]

    assert fetches == [(ws, "northwind", request["ref"], sha)]
    assert pr_number == 1
    assert recorded_base == workspace.head_sha(ws, "main")
    assert [call[0] for call in github.calls].count("open_pr") == 1
    open_call = next(call for call in github.calls if call[0] == "open_pr")
    assert open_call[1:4] == (
        "northwind",
        workspace.work_branch(request["ref"]),
        request["ref"],
    )

    gate_name = job_name(request["ref"], "architecture", 1, gate=True)
    fake.finish(gate_name, pass_verdict())
    with SessionLocal() as db:
        runner.tick(db)
    assert [call[0] for call in github.calls].count("open_pr") == 1


@pytest.mark.parametrize("intent_status", ["pending", "failed"])
def test_incomplete_pr_intent_replays_idempotent_open_and_completes(
    client, monkeypatch, tmp_path, intent_status
):
    _github_mode(monkeypatch, tmp_path)
    github = FakeGitHub("octocat")
    runner = KubeJobRunner(client=FakeKubeClient(), github=github)
    request = _approved(client, "GitHub incomplete PR intent")
    monkeypatch.setattr(
        kube_runner_module,
        "_git",
        lambda _ws, *args: subprocess.CompletedProcess(args, 0, "", ""),
    )
    monkeypatch.setattr(
        workspace, "push_branch_to_github", lambda *_args, **_kwargs: None
    )
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        runner._prepare_workspace(db, req)
        key = f"pr:{req.ref}"
        intents.begin(
            db,
            key,
            intents.OPEN_PR,
            req.id,
            {"slug": "northwind", "branch": workspace.work_branch(req.ref)},
        )
        row = db.get(Intent, key)
        row.status = intent_status
        db.commit()
        db.expunge(row)

        assert runner._open_pr(db, req, "northwind")
        row = db.get(Intent, key)

    assert [call[0] for call in github.calls].count("open_pr") == 1
    assert row.status == "done"
    assert json.loads(row.outcome_json) == {"pr_number": 1}


def test_pr_error_escalates_without_spawning_gate(
    client, monkeypatch, tmp_path
):
    _github_mode(monkeypatch, tmp_path)
    github = FakeGitHub("octocat")
    fake = FakeKubeClient()
    runner = KubeJobRunner(client=fake, github=github)
    request = _approved(client, "GitHub PR open failure")
    monkeypatch.setattr(
        kube_runner_module,
        "_git",
        lambda _ws, *args: subprocess.CompletedProcess(args, 0, "", ""),
    )
    monkeypatch.setattr(
        workspace, "push_branch_to_github", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(
        workspace, "fetch_ref_from_github", lambda *_args, **_kwargs: None
    )
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        runner._prepare_workspace(db, req)
        sha = workspace.head_sha(workspace.workspace_for(req))
        db.add(
            StageJob(
                request_id=req.id,
                stage="architecture",
                attempt=1,
                role="stage",
                job_name=job_name(req.ref, "architecture", 1),
                status="succeeded",
                envelope={"outcome": "ok", "detail": "plan ready", "sha": sha},
                epoch=1,
                deadline_at=utcnow(),
            )
        )
        db.commit()
        monkeypatch.setattr(
            github,
            "open_pr",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(
                RuntimeError("PR service unavailable")
            ),
        )

        assert not runner._spawn_gate(db, req, "architecture", 1, [])
        db.refresh(req)
        pr_intent = db.get(Intent, f"pr:{req.ref}")
        assert req.needs_human
        assert "PR service unavailable" in req.needs_human_reason
        assert pr_intent.status == "failed"

    assert fake.creations == []


def test_spawn_stage_epoch_loss_has_no_workspace_or_github_effects(
    client, monkeypatch
):
    runner, fake = make_runner()
    request = _approved(client, "Kube lost spawn fencing")
    prep_calls = []
    monkeypatch.setattr(
        runner,
        "_prepare_workspace",
        lambda *_args, **_kwargs: prep_calls.append("prepared"),
    )
    monkeypatch.setattr(
        transitions,
        "apply",
        lambda *_args, **_kwargs: transitions.Loss(
            transition="advance_stage",
            replay=False,
            winner=None,
            resulting_state="cancelled",
            detail="stale epoch",
        ),
    )
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        assert not runner._spawn_stage(db, req, "architecture", 1, "", [])

    assert prep_calls == []
    assert fake.creations == []


def test_spawn_stage_prep_failure_is_durable_and_creates_no_kube_job(
    client, monkeypatch
):
    runner, fake = make_runner()
    request = _approved(client, "Kube durable prep failure")
    monkeypatch.setattr(
        runner,
        "_prepare_workspace",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("workspace preparation failed")
        ),
    )
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        try:
            result = runner._spawn_stage(db, req, "architecture", 1, "", [])
        except RuntimeError:
            result = "raised"

        assert result is False
        row = db.scalar(
            select(StageJob).where(
                StageJob.request_id == req.id,
                StageJob.stage == "architecture",
                StageJob.attempt == 1,
                StageJob.role == "stage",
            )
        )
        intent = db.get(Intent, f"spawn:{job_name(req.ref, 'architecture', 1)}")
        db.refresh(req)
        assert row.status == "infra" and row.completed_at is not None
        assert intent.status == "failed"
        assert "workspace preparation failed" in intent.outcome_json
        assert req.needs_human
        assert "workspace preparation failed" in req.needs_human_reason

    assert fake.creations == []


def test_spawn_stage_threads_actual_app_slug_to_github_manifest(
    client, monkeypatch
):
    fake = FakeKubeClient()
    runner = KubeJobRunner(client=fake)
    request = _approved(client, "GitHub stage clone slug")
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "orchestrator-only-token")
    monkeypatch.setattr(settings, "GITHUB_OWNER", "octocat")
    monkeypatch.setattr(runner, "_prepare_workspace", lambda *_args, **_kwargs: None)

    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        slug = req.app.key
        assert slug != req.ref.lower()
        assert runner._spawn_stage(db, req, "architecture", 1, "", [])

    env = {
        entry["name"]: entry
        for entry in fake.creations[-1]["spec"]["template"]["spec"]["containers"][0]["env"]
    }
    assert env["SF_REPO_URL"]["value"] == (
        f"https://github.com/octocat/sf-app-{slug}.git"
    )


def test_baseline_push_error_redacts_github_token_before_persistence(
    client, monkeypatch, tmp_path
):
    _github_mode(monkeypatch, tmp_path)
    github = FakeGitHub("octocat")
    fake = FakeKubeClient()
    runner = KubeJobRunner(client=fake, github=github)
    request = _approved(client, "GitHub redacted baseline failure")
    token = settings.GITHUB_TOKEN
    leaked_url = (
        f"https://x-access-token:{token}@github.com/octocat/sf-app-northwind.git"
    )
    monkeypatch.setattr(
        kube_runner_module,
        "_git",
        lambda _ws, *args: subprocess.CompletedProcess(
            args, 1, "", f"fatal: authentication failed for '{leaked_url}'"
        ),
    )

    with SessionLocal() as db:
        runner.tick(db)
        req = db.get(Request, request["id"])
        repo_intent = db.get(Intent, f"repo:{req.ref}")
        persisted = repo_intent.outcome_json + (req.needs_human_reason or "")

    assert token not in persisted
    assert "x-access-token:" not in persisted
    assert "https://github.com/octocat/sf-app-northwind.git" in persisted
    assert not any(
        manifest["metadata"]["labels"]["sf/request"] == request["ref"].lower()
        for manifest in fake.creations
    )


def test_github_fetch_failure_escalates_before_spawning_gate(
    client, monkeypatch, tmp_path
):
    _github_mode(monkeypatch, tmp_path)
    github = FakeGitHub("octocat")
    fake = FakeKubeClient()
    runner = KubeJobRunner(client=fake, github=github)
    request = _approved(client, "GitHub fetch failure")
    monkeypatch.setattr(
        kube_runner_module,
        "_git",
        lambda _ws, *args: subprocess.CompletedProcess(args, 0, "", ""),
        raising=False,
    )
    monkeypatch.setattr(
        workspace, "push_branch_to_github", lambda *_args, **_kwargs: None
    )
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        runner._prepare_workspace(db, req)
        sha = workspace.head_sha(workspace.workspace_for(req))
        db.add(
            StageJob(
                request_id=req.id,
                stage="architecture",
                attempt=1,
                role="stage",
                job_name=job_name(req.ref, "architecture", 1),
                status="succeeded",
                envelope={"outcome": "ok", "detail": "plan ready", "sha": sha},
                epoch=1,
                deadline_at=utcnow(),
            )
        )
        db.commit()
        monkeypatch.setattr(
            workspace,
            "fetch_ref_from_github",
            lambda *_args, **_kwargs: "fetch rejected",
        )

        assert not runner._spawn_gate(db, req, "architecture", 1, [])
        db.refresh(req)
        assert req.needs_human
        assert f"could not fetch {sha[:12]} from GitHub before grading" in req.needs_human_reason

    assert fake.creations == []
    assert not any(call[0] == "open_pr" for call in github.calls)


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
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "")
    monkeypatch.setattr(settings, "GITHUB_OWNER", "octocat")
    monkeypatch.setattr(
        KubeJobRunner,
        "github",
        property(
            lambda _self: (_ for _ in ()).throw(
                AssertionError("GitHub dependency used with token unset")
            )
        ),
    )
    for helper in (
        "push_branch_to_github",
        "fetch_ref_from_github",
        "fetch_main_from_github",
    ):
        monkeypatch.setattr(
            workspace,
            helper,
            lambda *_args, _helper=helper, **_kwargs: (_ for _ in ()).throw(
                AssertionError(f"{_helper} called with token unset")
            ),
        )
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
        with SessionLocal() as db:
            merge_intent = db.get(Intent, f"merge:{d['ref']}")
            assert merge_intent.status == "done"
    shutil.rmtree(tmp_path / "kube-ws", ignore_errors=True)


def test_incomplete_local_merge_recovers_when_main_contains_graded_sha(
    monkeypatch, tmp_path
):
    _git_mode(monkeypatch, tmp_path)
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "")
    monkeypatch.setattr(settings, "GITHUB_OWNER", "octocat")
    monkeypatch.setenv("FACTORY_RUNNER", "kube")
    from fastapi.testclient import TestClient

    from app.main import create_app

    fake = FakeKubeClient()
    runner = KubeJobRunner(client=fake)
    git_backed_cluster(fake, tmp_path / "kube-ws")
    app = create_app(auto_tick=0, runner=runner)
    with TestClient(app) as c:
        request = approved_request(
            c,
            title="Kube local merge crash recovery",
            description="Add a monthly_export function that returns the export format name.",
        )
        out = request
        for _ in range(40):
            if out["gate"] == "approve_merge":
                break
            c.post("/api/simulator/tick")
            out = c.get(f"/api/requests/{request['id']}").json()
        assert out["gate"] == "approve_merge"
        ws = tmp_path / "kube-ws" / request["ref"].lower()
        graded = workspace.head_sha(ws, workspace.work_branch(request["ref"]))
        with SessionLocal() as db:
            req = db.get(Request, request["id"])
            intents.begin(
                db,
                f"merge:{req.ref}",
                intents.MERGE_PR,
                req.id,
                {"slug": "northwind", "sha": graded},
            )
            db.commit()
        _git(ws, "checkout", "-q", "main")
        merged = _git(ws, "merge", "--no-ff", "-q", "-m", "crash window", graded)
        assert merged.returncode == 0, merged.stderr
        monkeypatch.setattr(
            workspace,
            "merge_graded",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(
                AssertionError("local merge repeated during recovery")
            ),
        )

        done = c.post(
            f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
        ).json()
        assert done["status"] == "done" and done["stage"] == "done"
        with SessionLocal() as db:
            row = db.get(Intent, f"merge:{request['ref']}")
            assert row.status == "done"
            assert json.loads(row.outcome_json)["merge_sha"] == workspace.head_sha(
                ws, "main"
            )
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
