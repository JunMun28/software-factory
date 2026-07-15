"""B3 build+deploy driver — FakeKubeClient stands in for the cluster, so these
prove the ORCHESTRATOR's guarantees: merge -> build Job -> digest capture ->
factory-owned deploy apply -> rollout wait -> health probe -> done, plus
escalation + capture-before-delete + cancel teardown. Env-gated: unset REGISTRY
keeps B2 (merge -> done) exactly."""

from datetime import timedelta

from fake_kube import FakeKubeClient, honest_build
from helpers import approved_request
from sqlalchemy import select

from app import api_helpers, deploy_manifests, kube_runner, settings, transitions
from app.db import SessionLocal
from app.kube_runner import KubeJobRunner
from app.models import AuditEvent, Intent, Request, StageJob, utcnow

DIGEST = "sha256:" + "d" * 64


def _enable_git(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "WORKSPACES", tmp_path / "kube-ws")


def _enable_deploy(monkeypatch, tmp_path):
    _enable_git(monkeypatch, tmp_path)
    monkeypatch.setattr(settings, "REGISTRY", "sf-registry:5000")
    monkeypatch.setattr(settings, "APP_DEPLOY", True)


def _northwind_request(client, title):
    app_id = next(app["id"] for app in client.get("/api/apps").json() if app["key"] == "northwind")
    return approved_request(
        client,
        app_id=app_id,
        title=title,
        description="Add a monthly export function that returns the export format name.",
    )


def _tick_until(client, runner, rid, predicate, limit=40):
    out = client.get(f"/api/requests/{rid}").json()
    for _ in range(limit):
        if predicate(out):
            return out
        with SessionLocal() as db:
            runner.tick(db)
        out = client.get(f"/api/requests/{rid}").json()
    raise AssertionError(f"condition not reached after {limit} ticks: {out}")


def _to_merge_gate(client, monkeypatch, tmp_path, title, *, deploy=True):
    # The session-scoped API client keeps rows between tests. A stranded deploy
    # intentionally replays teardown, so retire earlier scenarios before a new
    # FakeKubeClient starts representing the cluster.
    with SessionLocal() as db:
        for old in db.scalars(select(Request).where(Request.stage == "deploy")).all():
            old.stage = "done"
        db.commit()
    if deploy:
        _enable_deploy(monkeypatch, tmp_path)
    else:
        _enable_git(monkeypatch, tmp_path)
        monkeypatch.setattr(settings, "REGISTRY", "")
        monkeypatch.setattr(settings, "APP_DEPLOY", False)
    runner = KubeJobRunner(client=(fake := FakeKubeClient()))
    honest_build(fake, settings.WORKSPACES)
    request = _northwind_request(client, title)
    out = _tick_until(
        client, runner, request["id"], lambda item: item["gate"] == "approve_merge"
    )
    assert out["stage"] == "review" and not out["needs_human"]
    monkeypatch.setenv("FACTORY_RUNNER", "kube")
    monkeypatch.setattr(api_helpers, "_pipeline", runner)
    approved = client.post(
        f"/api/requests/{request['id']}/approve", json={"operator_id": 1}
    )
    assert approved.status_code == 200, approved.text
    return request, approved.json(), runner, fake


def _spawn_and_finish_build(client, monkeypatch, tmp_path, title):
    request, approved, runner, fake = _to_merge_gate(
        client, monkeypatch, tmp_path, title
    )
    assert approved["stage"] == "deploy" and approved["status"] == transitions.APPROVED
    with SessionLocal() as db:
        runner.tick(db)
        build = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "build"
            )
        )
        assert build is not None and build.status == "running"
        build_name = build.job_name
    fake.finish(build_name, {}, phase="succeeded")
    fake.jobs[build_name].termination_message = DIGEST + "\n"
    with SessionLocal() as db:
        runner.tick(db)
    return request, runner, fake, build_name


def test_merge_disabled_still_ends_at_done(client, monkeypatch, tmp_path):
    request, approved, _runner, _fake = _to_merge_gate(
        client, monkeypatch, tmp_path, "B3 disabled merge", deploy=False
    )

    assert approved["status"] == transitions.DONE and approved["stage"] == "done"
    with SessionLocal() as db:
        roles = db.scalars(
            select(StageJob.role).where(StageJob.request_id == request["id"])
        ).all()
    assert "build" not in roles and "deploy" not in roles


def test_merge_kicks_off_build_then_deploy_to_done(client, monkeypatch, tmp_path):
    request, approved, runner, fake = _to_merge_gate(
        client, monkeypatch, tmp_path, "B3 deploy happy path"
    )
    assert approved["stage"] == "deploy" and approved["status"] == transitions.APPROVED

    with SessionLocal() as db:
        runner.tick(db)
        build = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "build"
            )
        )
        assert build is not None and build.status == "running"
        assert build.envelope and len(build.envelope["sha"]) == 40
        assert build.deadline_at.tzinfo is not None
        assert build.deadline_at > utcnow() + timedelta(
            seconds=settings.BUILD_WALL_CLOCK - 5
        )
        build_name = build.job_name

    fake.finish(build_name, {}, phase="succeeded")
    fake.jobs[build_name].termination_message = DIGEST + "\n"
    with SessionLocal() as db:
        runner.tick(db)
        build = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "build"
            )
        )
        deploy = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "deploy"
            )
        )
        assert build.status == "succeeded" and build.envelope["digest"] == DIGEST
        assert deploy is not None and deploy.status == "running"
        assert deploy.envelope["digest"] == DIGEST
        assert deploy.deadline_at.tzinfo is not None
        assert deploy.deadline_at > utcnow() + timedelta(
            seconds=settings.DEPLOY_WALL_CLOCK - 5
        )
        audit = db.scalar(
            select(AuditEvent)
            .where(AuditEvent.request_id == request["id"])
            .order_by(AuditEvent.id.desc())
        )
        assert audit.action == "approved_merge"
        intent_rows = db.scalars(
            select(Intent).where(Intent.request_id == request["id"])
        ).all()
        assert any(
            row.kind == "trigger_build"
            and row.key == f"build:{request['ref']}:{build.envelope['sha']}"
            and row.status == "done"
            for row in intent_rows
        )
        assert any(
            row.kind == "apply_deploy"
            and row.key == f"deploy:northwind:{DIGEST}"
            and row.status == "done"
            for row in intent_rows
        )

    assert {obj["kind"] for obj in fake.applied} == {"Deployment", "Service", "Ingress"}
    app_name = deploy_manifests.app_name("northwind")
    fake.mark_ready(app_name)
    probes = []
    monkeypatch.setattr(kube_runner, "_http_ok", lambda url: probes.append(url) or True)
    with SessionLocal() as db:
        runner.tick(db)
        req = db.get(Request, request["id"])
        deploy = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "deploy"
            )
        )
        assert req.status == transitions.DONE and req.stage == "done"
        assert deploy.status == "succeeded"
    assert probes == [
        f"http://{app_name}.{settings.KUBE_NAMESPACE}.svc:80/health"
    ]

    events = client.get("/api/events", params={"request_id": request["id"]}).json()
    finished = next(event for event in reversed(events) if event["title"].startswith("Merge approved"))
    assert finished["payload"]["digest"] == DIGEST
    assert finished["payload"]["url"] == f"http://northwind.{settings.APP_INGRESS_DOMAIN}"


def test_build_failure_escalates_with_capture(client, monkeypatch, tmp_path):
    request, approved, runner, fake = _to_merge_gate(
        client, monkeypatch, tmp_path, "B3 build failure"
    )
    assert approved["stage"] == "deploy"
    with SessionLocal() as db:
        runner.tick(db)
        build = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "build"
            )
        )
        build_name, build_uid = build.job_name, build.job_uid
    fake.finish(build_name, {}, phase="failed", logs="kaniko: push denied")

    with SessionLocal() as db:
        runner.tick(db)
        req = db.get(Request, request["id"])
        build = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "build"
            )
        )
        deploy = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "deploy"
            )
        )
        assert req.needs_human and "Build Job" in req.needs_human_reason
        assert build.status == "failed" and "push denied" in build.logs_tail
        assert deploy is None
    assert (build_name, build_uid) in fake.deletion_uids
    assert not fake.applied


def test_probe_failure_escalates_not_a_silent_half_deploy(
    client, monkeypatch, tmp_path
):
    monkeypatch.setattr(settings, "DEPLOY_WALL_CLOCK", -1)
    request, runner, fake, _build_name = _spawn_and_finish_build(
        client, monkeypatch, tmp_path, "B3 health probe failure"
    )
    fake.mark_ready(deploy_manifests.app_name("northwind"))
    monkeypatch.setattr(kube_runner, "_http_ok", lambda _url: False)

    with SessionLocal() as db:
        runner.tick(db)
        req = db.get(Request, request["id"])
        deploy = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "deploy"
            )
        )
        assert req.needs_human and req.stage == "deploy"
        assert "health probe" in req.needs_human_reason.lower()
        assert deploy.status == "timed_out"
    assert deploy_manifests.app_name("northwind") not in fake.observations


def test_cancel_during_deploy_tears_down_the_app(client, monkeypatch, tmp_path):
    request, runner, fake, build_name = _spawn_and_finish_build(
        client, monkeypatch, tmp_path, "B3 cancel teardown"
    )
    with SessionLocal() as db:
        build = db.scalar(
            select(StageJob).where(
                StageJob.request_id == request["id"], StageJob.role == "build"
            )
        )
        build_uid = build.job_uid
    deletion_count = fake.deletions.count(build_name)

    cancelled = client.post(
        f"/api/requests/{request['id']}/cancel", json={"operator_id": 1}
    ).json()
    assert cancelled["status"] == transitions.CANCELLED
    with SessionLocal() as db:
        runner.tick(db)
        runner.tick(db)  # teardown is safe to replay

    assert fake.deletions.count(build_name) >= deletion_count + 2
    assert (build_name, build_uid) in fake.deletion_uids
    assert fake.label_deletions[-2:] == [
        "sf/instance=northwind",
        "sf/instance=northwind",
    ]
    assert not fake.objects
