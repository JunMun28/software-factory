import os
import subprocess
import sys
from datetime import timedelta
from pathlib import Path

import pytest
from fake_kube import FakeKubeClient, pass_verdict, stage_ok
from sqlalchemy import select
from test_kube_runner import _approved, make_runner, tick_until

from app import kube_runner as runner_module
from app.db import SessionLocal
from app.kube_client import JobView
from app.models import Request, StageJob, utcnow


def _honest_or_fault(fake, request_ref, target_stage, fault):
    def observe(name, job):
        if job.phase != "running":
            return
        if name.endswith("-gate"):
            fake.finish(name, pass_verdict())
        elif name.startswith(f"sf-{request_ref.lower()}-{target_stage}-"):
            fault(name, job)
        else:
            fake.finish(name, stage_ok())

    fake.on_observe = observe


def test_shared_infra_limit_is_env_tunable():
    env = os.environ.copy()
    env["FACTORY_GATE_INFRA_LIMIT"] = "7"
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "from app.kube_runner import GATE_INFRA_LIMIT, STAGE_INFRA_LIMIT; "
                "print(GATE_INFRA_LIMIT, STAGE_INFRA_LIMIT)"
            ),
        ],
        cwd=Path(__file__).parents[1],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == "7 7"


def test_oom_stage_reruns_same_attempt_not_a_domain_failure(client):
    runner, fake = make_runner()
    failed_uids = set()

    def oom_once(name, job):
        if not failed_uids:
            failed_uids.add(job.uid)
            fake.fail_infra(name)
        else:
            fake.finish(name, stage_ok())

    request = _approved(client, "Kube OOM infra")
    _honest_or_fault(fake, request["ref"], "architecture", oom_once)
    tick_until(client, runner, request["id"], lambda out: out["gate"] == "approve_merge")

    with SessionLocal() as db:
        rows = db.scalars(
            select(StageJob)
            .where(
                StageJob.request_id == request["id"],
                StageJob.stage == "architecture",
                StageJob.role == "stage",
            )
            .order_by(StageJob.id)
        ).all()
    assert [row.attempt for row in rows] == [1, 1]
    assert [row.status for row in rows] == ["infra", "succeeded"]
    assert rows[0].envelope["infra_class"] == "oom"
    titles = [
        event["title"]
        for event in client.get("/api/events", params={"request_id": request["id"]}).json()
    ]
    assert not any(title.startswith("Attempt 1 failed") for title in titles)


def test_unschedulable_stage_caught_by_probe_is_infra_named(monkeypatch, client):
    monkeypatch.setattr(runner_module, "INFRA_DETECT_GRACE", -1)
    monkeypatch.setattr(runner_module, "INFRA_DETECT_WINDOW", 10_000)
    runner, fake = make_runner()

    def stuck(name, _job):
        fake.pending_unschedulable(name)

    request = _approved(client, "Kube unschedulable infra")
    _honest_or_fault(fake, request["ref"], "red", stuck)
    out = tick_until(client, runner, request["id"], lambda value: value["needs_human"])

    assert "unschedulable" in out["needs_human_reason"].lower()
    with SessionLocal() as db:
        rows = db.scalars(
            select(StageJob).where(
                StageJob.request_id == request["id"],
                StageJob.stage == "red",
                StageJob.role == "stage",
            )
        ).all()
    assert len(rows) == runner_module.STAGE_INFRA_LIMIT
    assert {row.attempt for row in rows} == {1}
    assert all(row.envelope["infra_class"] == "unschedulable" for row in rows)
    assert sum(name.endswith("-red-1") for name in fake.deletions) == len(rows)


def test_image_pull_backoff_probe_reruns_then_recovers(monkeypatch, client):
    monkeypatch.setattr(runner_module, "INFRA_DETECT_GRACE", -1)
    monkeypatch.setattr(runner_module, "INFRA_DETECT_WINDOW", 10_000)
    runner, fake = make_runner()
    fault_uid = []

    def pull_once(name, job):
        if not fault_uid:
            fault_uid.append(job.uid)
        if job.uid == fault_uid[0]:
            fake.pending_unschedulable(name, reason="ImagePullBackOff")
        else:
            fake.finish(name, stage_ok())

    request = _approved(client, "Kube image pull recovers")
    _honest_or_fault(fake, request["ref"], "red", pull_once)
    out = tick_until(client, runner, request["id"], lambda value: value["gate"] == "approve_merge")
    assert out["needs_human"] is False
    with SessionLocal() as db:
        rows = db.scalars(
            select(StageJob)
            .where(
                StageJob.request_id == request["id"],
                StageJob.stage == "red",
                StageJob.role == "stage",
            )
            .order_by(StageJob.id)
        ).all()
    assert [row.attempt for row in rows] == [1, 1]
    assert rows[0].envelope["infra_class"] == "image_pull"
    assert rows[1].status == "succeeded"


def test_probe_does_not_fire_before_grace_or_for_healthy_pods(
    monkeypatch, client
):
    assert hasattr(runner_module.KubeJobRunner, "_schedule_probe_due")
    now = utcnow()
    row = StageJob(created_at=now, deadline_at=now + timedelta(seconds=60))
    assert runner_module.KubeJobRunner._schedule_probe_due(row, now) is False

    monkeypatch.setattr(runner_module, "INFRA_DETECT_GRACE", -1)
    monkeypatch.setattr(runner_module, "INFRA_DETECT_WINDOW", 10_000)
    runner, fake = make_runner()
    request = _approved(client, "Kube healthy scheduling probe")
    name = f"sf-{request['ref'].lower()}-architecture-1"
    tick_until(client, runner, request["id"], lambda _out: name in fake.jobs)
    fake.observations.clear()
    fake.deletions.clear()

    with SessionLocal() as db:
        runner.tick(db)
        current = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"],
                StageJob.job_name == name,
            )
        )
        assert current.status == "running"

    assert fake.observations.count(name) == 2  # cheap poll + pod probe
    assert name not in fake.deletions
    assert client.get(f"/api/requests/{request['id']}").json()["needs_human"] is False


def test_codex_quota_exit_is_infra_not_agent_failure(client):
    runner, fake = make_runner()
    failed_uids = set()

    def quota_once(name, job):
        if not failed_uids:
            failed_uids.add(job.uid)
            fake.finish(
                name,
                {
                    "outcome": "fail",
                    "detail": "codex exec failed: You have hit your usage limit",
                },
                phase="failed",
            )
        else:
            fake.finish(name, stage_ok())

    request = _approved(client, "Kube quota infra")
    _honest_or_fault(fake, request["ref"], "green", quota_once)
    gate_name = f"sf-{request['ref'].lower()}-green-1-gate"
    tick_until(client, runner, request["id"], lambda _out: gate_name in fake.jobs)
    with SessionLocal() as db:
        rows = db.scalars(
            select(StageJob)
            .where(
                StageJob.request_id == request["id"],
                StageJob.stage == "green",
                StageJob.role == "stage",
            )
            .order_by(StageJob.id)
        ).all()
    assert [row.attempt for row in rows] == [1, 1]
    assert rows[0].envelope["infra_class"] == "quota"


def test_entrypoint_infra_sentinel_is_retry_neutral(client):
    runner, fake = make_runner()
    seen = set()

    def sentinel_once(name, job):
        if not seen:
            seen.add(job.uid)
            fake.finish(name, {"outcome": "infra", "reason": "quota"}, phase="failed")
        else:
            fake.finish(name, stage_ok())

    request = _approved(client, "Kube sentinel infra")
    _honest_or_fault(fake, request["ref"], "architecture", sentinel_once)
    tick_until(client, runner, request["id"], lambda out: out["gate"] == "approve_merge")
    with SessionLocal() as db:
        rows = db.scalars(
            select(StageJob)
            .where(
                StageJob.request_id == request["id"],
                StageJob.stage == "architecture",
                StageJob.role == "stage",
            )
            .order_by(StageJob.id)
        ).all()
    assert [row.attempt for row in rows] == [1, 1]
    assert rows[0].envelope["infra_class"] == "agent_infra"
    assert rows[0].envelope["reason"] == "quota"


def test_genuine_agent_fail_still_burns_attempt(client):
    runner, fake = make_runner()

    def fail_first(name, _job):
        if name.endswith("-architecture-1"):
            fake.finish(
                name,
                {"outcome": "fail", "detail": "assertion mismatch"},
                phase="failed",
            )
        else:
            fake.finish(name, stage_ok())

    request = _approved(client, "Kube domain failure")
    _honest_or_fault(fake, request["ref"], "architecture", fail_first)
    name2 = f"sf-{request['ref'].lower()}-architecture-2"
    tick_until(client, runner, request["id"], lambda _out: name2 in fake.jobs)
    with SessionLocal() as db:
        rows = db.scalars(
            select(StageJob)
            .where(
                StageJob.request_id == request["id"],
                StageJob.stage == "architecture",
                StageJob.role == "stage",
            )
            .order_by(StageJob.id)
        ).all()
    assert [row.attempt for row in rows] == [1, 2]
    assert rows[0].status == "failed"


def _classify_detail(detail):
    return runner_module.classify_infra(
        JobView(name="job", phase="failed"),
        {"outcome": "fail", "detail": detail},
        None,
    )


def test_quota_prefix_present_but_non_quota_stays_domain():
    assert _classify_detail("codex exec failed: SyntaxError: invalid syntax") is None


def test_quota_incidental_429_in_tail_stays_domain():
    assert _classify_detail("codex exec failed: GET https://x 429 in test") is None


def test_quota_signature_needs_cli_prefix():
    assert _classify_detail("assertion failed: monthly export quota exceeded") is None


def test_foreign_infra_rows_do_not_shorten_the_cap(client):
    assert hasattr(runner_module.KubeJobRunner, "_record_stage_infra")
    runner = runner_module.KubeJobRunner(client=FakeKubeClient())
    request = _approved(client, "Kube scoped classifier cap")
    with SessionLocal() as db:
        req = db.get(Request, request["id"])
        deadline = utcnow() + timedelta(seconds=60)
        for cause in ("stranger", "vanish"):
            db.add(
                StageJob(
                    request_id=req.id,
                    stage="architecture",
                    attempt=1,
                    role="stage",
                    job_name=f"sf-{req.ref.lower()}-architecture-1",
                    status="infra",
                    envelope={"infra_cause": cause},
                    epoch=1,
                    deadline_at=deadline,
                )
            )
        current = StageJob(
            request_id=req.id,
            stage="architecture",
            attempt=1,
            role="stage",
            job_name=f"sf-{req.ref.lower()}-architecture-1",
            status="running",
            epoch=1,
            deadline_at=deadline,
        )
        db.add(current)
        db.commit()
        runner._record_stage_infra(db, req, current, ("oom", "OOMKilled"), [])
        db.refresh(req)
        assert req.needs_human is False


def test_human_retry_grants_fresh_infra_budget(monkeypatch, client):
    monkeypatch.setattr(runner_module, "INFRA_DETECT_GRACE", -1)
    monkeypatch.setattr(runner_module, "INFRA_DETECT_WINDOW", 10_000)
    runner, fake = make_runner()

    def stuck(name, _job):
        fake.pending_unschedulable(name)

    request = _approved(client, "Kube retry infra budget")
    _honest_or_fault(fake, request["ref"], "architecture", stuck)
    tick_until(client, runner, request["id"], lambda out: out["needs_human"])
    response = client.post(
        f"/api/requests/{request['id']}/retry",
        json={"operator_id": 1, "note": "capacity added"},
    )
    assert response.status_code == 200, response.text
    with SessionLocal() as db:
        runner.tick(db)
    with SessionLocal() as db:
        runner.tick(db)
    out = client.get(f"/api/requests/{request['id']}").json()
    assert out["needs_human"] is False
    with SessionLocal() as db:
        rows = db.scalars(
            select(StageJob)
            .where(
                StageJob.request_id == request["id"],
                StageJob.stage == "architecture",
                StageJob.role == "stage",
                StageJob.status == "infra",
            )
            .order_by(StageJob.id)
        ).all()
    assert len(rows) == runner_module.STAGE_INFRA_LIMIT + 1
    assert {row.attempt for row in rows} == {1}


@pytest.mark.parametrize(
    ("view", "envelope", "expected"),
    [
        (JobView("j", "failed", reason="OOMKilled", exit_code=137), None, "oom"),
        (JobView("j", "failed", exit_code=137), None, "oom"),
        (JobView("j", "running", reason="ImagePullBackOff"), None, "image_pull"),
        (JobView("j", "running", reason="Unschedulable"), None, "unschedulable"),
        (JobView("j", "failed"), {"outcome": "infra", "reason": "quota"}, "agent_infra"),
        (
            JobView("j", "failed"),
            {"outcome": "fail", "detail": "codex exec failed: rate limit exceeded"},
            "quota",
        ),
        (JobView("j", "failed"), {"outcome": "fail", "detail": "plain fail"}, None),
        (JobView("j", "running"), None, None),
    ],
)
def test_classify_infra_table(view, envelope, expected):
    result = runner_module.classify_infra(view, envelope, None)
    assert (result[0] if result else None) == expected
