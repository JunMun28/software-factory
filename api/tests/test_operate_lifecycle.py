"""C8 operate lifecycle: registration, health incidents, and safe rollback."""

import hashlib
from datetime import timedelta
from types import SimpleNamespace

import pytest
from fake_kube import FakeKubeClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session

from app import deploy_manifests, kube_runner, registry, settings, transitions
from app.db import Base, SessionLocal
from app.kube_runner import KubeJobRunner
from app.models import (
    App,
    Intent,
    LeaderEpoch,
    ProgressEvent,
    Request,
    StageJob,
    utcnow,
)

OLD_DIGEST = "sha256:" + "1" * 64
NEW_DIGEST = "sha256:" + "2" * 64
NEXT_DIGEST = "sha256:" + "3" * 64


@pytest.fixture
def operate_db(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'operate.db'}")
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        db.add(LeaderEpoch(id=1, epoch=7))
        db.commit()
        monkeypatch.setattr(
            kube_runner, "get_elector", lambda: SimpleNamespace(epoch=7)
        )
        yield db
    engine.dispose()


def _request(
    ref: str,
    *,
    app: App | None = None,
    status: str = transitions.DONE,
    stage: str = "done",
    new_app_name: str | None = None,
) -> Request:
    return Request(
        ref=ref,
        title=new_app_name or f"Operate fixture {ref}",
        description="operate lifecycle fixture",
        type="new" if app is None else "enh",
        status=status,
        stage=stage,
        app=app,
        new_app_name=new_app_name,
    )


def _succeeded_deploy(
    request: Request, digest: str, *, completed_offset: int = 0
) -> StageJob:
    now = utcnow()
    return StageJob(
        request_id=request.id,
        stage="deploy",
        attempt=1,
        role="deploy",
        job_name=f"sf-app-{request.ref.lower()}",
        status="succeeded",
        deadline_at=now,
        completed_at=now + timedelta(seconds=completed_offset),
        envelope={"digest": digest, "image": f"registry/app@{digest}"},
    )


class RollingFakeKubeClient(FakeKubeClient):
    """Keeps the old serving image until a zero-unavailable rollout is ready."""

    def __init__(self):
        super().__init__()
        self.serving_images: dict[str, str] = {}
        self.pending_images: dict[str, str] = {}

    def apply(self, manifest: dict) -> None:
        if manifest["kind"] == "Deployment":
            name = manifest["metadata"]["name"]
            image = manifest["spec"]["template"]["spec"]["containers"][0]["image"]
            current = self.serving_images.get(name)
            if current is not None and current != image:
                assert manifest["spec"]["strategy"] == {
                    "type": "RollingUpdate",
                    "rollingUpdate": {"maxUnavailable": 0, "maxSurge": 1},
                }
                self.pending_images[name] = image
                self._ready.discard(name)
            else:
                self.serving_images[name] = image
        super().apply(manifest)

    def mark_ready(self, name: str) -> None:
        if name in self.pending_images:
            self.serving_images[name] = self.pending_images.pop(name)
        super().mark_ready(name)


def test_first_deploy_registers_stable_app_and_failed_follow_up_preserves_it(
    operate_db, monkeypatch
):
    db = operate_db
    monkeypatch.setattr(settings, "REGISTRY", "sf-registry:5000")
    monkeypatch.setattr(kube_runner, "_http_ok", lambda _url: True)
    request_a = _request(
        "REQ-9101",
        status=transitions.APPROVED,
        stage="deploy",
        new_app_name="Ledger Hub",
    )
    db.add(request_a)
    db.flush()
    db.add(
        StageJob(
            request_id=request_a.id,
            stage="deploy",
            attempt=1,
            role="build",
            job_name="sf-req-9101-build",
            status="succeeded",
            deadline_at=utcnow(),
            completed_at=utcnow(),
            envelope={"digest": OLD_DIGEST, "sha": "a" * 40},
        )
    )
    db.commit()

    fake = RollingFakeKubeClient()
    runner = KubeJobRunner(client=fake)
    runner._drive_one_deploy(db, request_a, [])
    db.refresh(request_a)

    assert request_a.app_id is not None
    assert request_a.app.key == "ledger-hub"
    assert {item["metadata"]["name"] for item in fake.applied} == {
        "sf-app-ledger-hub"
    }
    deploy_a = db.scalar(
        select(StageJob).where(
            StageJob.request_id == request_a.id, StageJob.role == "deploy"
        )
    )
    assert deploy_a is not None and deploy_a.job_name == "sf-app-ledger-hub"

    fake.mark_ready("sf-app-ledger-hub")
    runner._drive_one_deploy(db, request_a, [])
    db.refresh(request_a)
    assert request_a.status == transitions.DONE
    assert deploy_a.status == "succeeded"

    request_b = _request(
        "REQ-9102",
        app=request_a.app,
        status=transitions.APPROVED,
        stage="deploy",
    )
    db.add(request_b)
    db.flush()
    db.add(
        StageJob(
            request_id=request_b.id,
            stage="deploy",
            attempt=1,
            role="build",
            job_name="sf-req-9102-build",
            status="succeeded",
            deadline_at=utcnow(),
            completed_at=utcnow(),
            envelope={"digest": NEW_DIGEST, "sha": "b" * 40},
        )
    )
    db.commit()

    runner._drive_one_deploy(db, request_b, [])
    failed_follow_up = db.scalar(
        select(StageJob).where(
            StageJob.request_id == request_b.id,
            StageJob.role == "deploy",
        )
    )
    assert failed_follow_up is not None
    failed_follow_up.deadline_at = utcnow() - timedelta(seconds=1)
    db.commit()
    runner._drive_one_deploy(db, request_b, [])
    db.refresh(request_b)
    db.refresh(failed_follow_up)

    assert failed_follow_up.status == "timed_out"
    assert request_b.needs_human is True
    assert "rollout was not ready" in request_b.needs_human_reason
    assert fake.serving_images["sf-app-ledger-hub"] == (
        f"sf-registry:5000/sf-app-ledger-hub@{OLD_DIGEST}"
    )
    assert fake.pending_images["sf-app-ledger-hub"] == (
        f"sf-registry:5000/sf-app-ledger-hub@{NEW_DIGEST}"
    )


def test_registration_collision_retries_with_deterministic_hash_suffix(
    operate_db, monkeypatch
):
    db = operate_db
    db.add(
        App(
            key="ledger-hub",
            name="Existing Ledger Hub",
            owner="qa",
            repo="micron/existing-ledger-hub",
        )
    )
    request = _request(
        "REQ-9110",
        status=transitions.APPROVED,
        stage="deploy",
        new_app_name="Ledger Hub",
    )
    db.add(request)
    db.commit()

    runner = KubeJobRunner(client=FakeKubeClient())
    monkeypatch.setattr(
        runner,
        "_stable_app_key",
        lambda _db, _req: "ledger-hub",
    )
    assert runner._register_produced_app(db, request)
    db.refresh(request)
    suffix = hashlib.sha256(request.ref.encode()).hexdigest()[:8]
    assert request.app.key == f"ledger-hub-{suffix}"


def test_fleet_health_uses_bounded_queries_and_loads_only_latest_events(
    operate_db,
):
    db = operate_db
    for index in range(2):
        app = App(
            key=f"bounded-{index}",
            name=f"Bounded {index}",
            owner="qa",
            repo=f"micron/bounded-{index}",
        )
        request = _request(f"REQ-915{index}", app=app)
        db.add_all([app, request])
        db.flush()
        db.add(_succeeded_deploy(request, OLD_DIGEST))
        for event_index in range(25):
            db.add(
                ProgressEvent(
                    request_id=request.id,
                    subject_id=app.id,
                    kind="recovery_action",
                    stage="deploy",
                    title=f"health {event_index}",
                    payload={
                        "health_status": (
                            "degraded" if event_index % 2 else "live"
                        )
                    },
                )
            )
    db.commit()

    engine = db.get_bind()
    statements: list[str] = []
    loaded_events: list[int] = []

    def count_statement(_conn, _cursor, statement, _params, _context, _many):
        statements.append(statement)

    def count_loaded(_session, instance):
        if isinstance(instance, ProgressEvent):
            loaded_events.append(instance.id)

    event.listen(engine, "before_cursor_execute", count_statement)
    try:
        with Session(engine) as read_db:
            event.listen(read_db, "loaded_as_persistent", count_loaded)
            health = registry.fleet_health(read_db)
    finally:
        event.remove(engine, "before_cursor_execute", count_statement)

    assert {item["key"] for item in health} == {"bounded-0", "bounded-1"}
    assert len(statements) <= 3
    assert len(loaded_events) == 2


def test_dead_live_app_emits_one_incident_and_registry_surfaces_degraded(
    operate_db, monkeypatch
):
    db = operate_db
    monkeypatch.setattr(settings, "APP_HEALTH_INTERVAL", 0)
    monkeypatch.setattr(settings, "APP_HEALTH_FAILURES", 2)
    monkeypatch.setattr(kube_runner, "_http_ok", lambda _url: False)
    app = App(key="health-dead", name="Health Dead", owner="qa", repo="micron/dead")
    request = _request("REQ-9201", app=app)
    db.add_all([app, request])
    db.flush()
    db.add(_succeeded_deploy(request, NEW_DIGEST))
    db.commit()

    runner = KubeJobRunner(client=FakeKubeClient())
    runner._monitor_app_health(db, [])
    runner._monitor_app_health(db, [])
    runner._monitor_app_health(db, [])

    incidents = db.scalars(
        select(ProgressEvent).where(
            ProgressEvent.subject_id == app.id,
            ProgressEvent.kind == "escalation",
        )
    ).all()
    assert len(incidents) == 1
    assert incidents[0].payload["health_status"] == "degraded"
    health = {item["key"]: item for item in registry.fleet_health(db)}
    assert health["health-dead"]["status"] == "degraded"


def test_healthy_live_app_emits_no_incident(operate_db, monkeypatch):
    db = operate_db
    monkeypatch.setattr(settings, "APP_HEALTH_INTERVAL", 0)
    monkeypatch.setattr(settings, "APP_HEALTH_FAILURES", 2)
    monkeypatch.setattr(kube_runner, "_http_ok", lambda _url: True)
    app = App(key="health-ok", name="Health OK", owner="qa", repo="micron/ok")
    request = _request("REQ-9202", app=app)
    db.add_all([app, request])
    db.flush()
    db.add(_succeeded_deploy(request, NEW_DIGEST))
    db.commit()

    runner = KubeJobRunner(client=FakeKubeClient())
    runner._monitor_app_health(db, [])
    runner._monitor_app_health(db, [])

    incidents = db.scalars(
        select(ProgressEvent).where(
            ProgressEvent.subject_id == app.id,
            ProgressEvent.kind == "escalation",
        )
    ).all()
    assert incidents == []


def test_health_probe_requires_2xx(monkeypatch):
    class Redirect:
        status = 302

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(
        kube_runner.urllib.request, "urlopen", lambda *_a, **_k: Redirect()
    )
    assert kube_runner._http_ok("http://sf-app.example/health") is False


def test_rollback_is_idempotent_fenced_and_succeeds_only_after_verification(
    operate_db, monkeypatch
):
    db = operate_db
    monkeypatch.setattr(settings, "REGISTRY", "sf-registry:5000")
    app = App(key="rollback-app", name="Rollback App", owner="qa", repo="micron/rb")
    old_request = _request("REQ-9301", app=app)
    current_request = _request("REQ-9302", app=app)
    db.add_all([app, old_request, current_request])
    db.flush()
    db.add_all(
        [
            _succeeded_deploy(old_request, OLD_DIGEST, completed_offset=1),
            _succeeded_deploy(current_request, NEW_DIGEST, completed_offset=2),
        ]
    )
    db.commit()

    rollback = registry.enqueue_rollback(db, app.id, OLD_DIGEST, epoch=7)
    replay = registry.enqueue_rollback(db, app.id, OLD_DIGEST, epoch=7)
    assert replay.id == rollback.id
    assert rollback.role == "rollback" and rollback.status == "running"
    intent = db.get(Intent, rollback.envelope["intent_key"])
    assert intent is not None and intent.status == "pending"

    fake = FakeKubeClient()
    runner = KubeJobRunner(client=fake)
    monkeypatch.setattr(kube_runner, "_http_ok", lambda _url: False)
    runner._drive_rollbacks(db, [])
    db.refresh(rollback)
    assert rollback.status == "running"
    assert db.get(Intent, rollback.envelope["intent_key"]).status == "pending"
    assert db.scalar(
        select(StageJob).where(
            StageJob.role == "deploy",
            StageJob.request_id == old_request.id,
            StageJob.envelope["source"].as_string() == "rollback",
        )
    ) is None

    fake.mark_ready(deploy_manifests.app_name(app.key))
    runner._drive_rollbacks(db, [])
    db.refresh(rollback)
    assert rollback.status == "running", "health failure must not record live"

    monkeypatch.setattr(kube_runner, "_http_ok", lambda _url: True)
    deployment = fake.objects[f"Deployment/{deploy_manifests.app_name(app.key)}"]
    deployment["spec"]["template"]["spec"]["containers"][0]["image"] = (
        f"sf-registry:5000/sf-app-{app.key}@{NEW_DIGEST}"
    )
    runner._drive_rollbacks(db, [])
    db.refresh(rollback)
    assert rollback.status == "running", "wrong live digest must not record success"
    assert db.get(Intent, rollback.envelope["intent_key"]).status == "pending"
    deployment["spec"]["template"]["spec"]["containers"][0]["image"] = (
        rollback.envelope["image"]
    )
    runner._drive_rollbacks(db, [])
    db.refresh(rollback)
    assert rollback.status == "succeeded"
    witness = db.scalar(
        select(StageJob)
        .where(
            StageJob.role == "deploy",
            StageJob.status == "succeeded",
            StageJob.request_id == old_request.id,
        )
        .order_by(StageJob.id.desc())
    )
    assert witness.envelope["digest"] == OLD_DIGEST
    assert witness.envelope["source"] == "rollback"
    assert db.get(Intent, rollback.envelope["intent_key"]).status == "done"

    with pytest.raises(registry.RollbackFenced):
        registry.enqueue_rollback(db, app.id, NEW_DIGEST, epoch=6)


def test_tick_defers_enqueued_rollback_while_same_app_deploy_is_running(
    operate_db, monkeypatch
):
    db = operate_db
    monkeypatch.setattr(settings, "REGISTRY", "sf-registry:5000")
    app = App(key="rollback-busy", name="Rollback Busy", owner="qa", repo="micron/busy")
    old_request = _request("REQ-9311", app=app)
    current_request = _request("REQ-9312", app=app)
    active_request = _request(
        "REQ-9313", app=app, status=transitions.APPROVED, stage="deploy"
    )
    db.add_all([app, old_request, current_request, active_request])
    db.flush()
    active_deploy = StageJob(
        request_id=active_request.id,
        stage="deploy",
        attempt=1,
        role="deploy",
        job_name="sf-app-rollback-busy",
        status="running",
        deadline_at=utcnow() + timedelta(minutes=5),
        envelope={"digest": NEXT_DIGEST},
    )
    db.add_all(
        [
            _succeeded_deploy(old_request, OLD_DIGEST, completed_offset=1),
            _succeeded_deploy(current_request, NEW_DIGEST, completed_offset=2),
            active_deploy,
        ]
    )
    db.commit()

    rollback = registry.enqueue_rollback(db, app.id, OLD_DIGEST, epoch=7)
    fake = FakeKubeClient()
    runner = KubeJobRunner(client=fake)
    runner._drive_rollbacks(db, [])
    db.refresh(rollback)

    assert rollback.status == "running"
    assert rollback.envelope["applied"] is False
    assert fake.applied == []
    assert db.get(Intent, rollback.envelope["intent_key"]).status == "pending"

    active_deploy.status = "succeeded"
    active_deploy.completed_at = utcnow()
    db.commit()
    runner._drive_rollbacks(db, [])
    db.refresh(rollback)
    assert rollback.envelope["applied"] is True
    assert fake.applied


def test_rollback_apply_failure_records_error_without_live_witness(
    operate_db, monkeypatch
):
    db = operate_db
    monkeypatch.setattr(settings, "REGISTRY", "sf-registry:5000")
    app = App(key="rollback-fail", name="Rollback Fail", owner="qa", repo="micron/fail")
    old_request = _request("REQ-9321", app=app)
    current_request = _request("REQ-9322", app=app)
    db.add_all([app, old_request, current_request])
    db.flush()
    db.add_all(
        [
            _succeeded_deploy(old_request, OLD_DIGEST, completed_offset=1),
            _succeeded_deploy(current_request, NEW_DIGEST, completed_offset=2),
        ]
    )
    db.commit()
    rollback = registry.enqueue_rollback(db, app.id, OLD_DIGEST, epoch=7)
    fake = FakeKubeClient()

    def fail_apply(_manifest):
        raise RuntimeError("apiserver refused rollback")

    fake.apply = fail_apply
    KubeJobRunner(client=fake)._drive_rollbacks(db, [])
    db.refresh(rollback)

    assert rollback.status == "failed"
    assert "apiserver refused rollback" in rollback.envelope["error"]
    assert db.get(Intent, rollback.envelope["intent_key"]).status == "pending"
    witnesses = db.scalars(
        select(StageJob).where(
            StageJob.role == "deploy",
            StageJob.request_id == old_request.id,
        )
    ).all()
    assert len(witnesses) == 1
    incidents = db.scalars(
        select(ProgressEvent).where(
            ProgressEvent.subject_id == app.id,
            ProgressEvent.kind == "escalation",
        )
    ).all()
    assert len(incidents) == 1
    assert "apiserver refused rollback" in incidents[0].payload["error"]


def test_registry_rollback_endpoint_only_enqueues(client):
    suffix = "9401"
    with SessionLocal() as db:
        app = App(
            key=f"route-{suffix}",
            name="Route Rollback",
            owner="qa",
            repo=f"micron/route-{suffix}",
        )
        old_request = _request(f"REQ-{suffix}", app=app)
        current_request = _request(f"REQ-{int(suffix) + 1}", app=app)
        db.add_all([app, old_request, current_request])
        db.flush()
        db.add_all(
            [
                _succeeded_deploy(old_request, OLD_DIGEST, completed_offset=1),
                _succeeded_deploy(current_request, NEW_DIGEST, completed_offset=2),
            ]
        )
        db.commit()
        app_id = app.id

    response = client.post(
        f"/api/apps/{app_id}/rollback", json={"digest": OLD_DIGEST}
    )
    assert response.status_code == 202, response.text
    with SessionLocal() as db:
        row = db.get(StageJob, response.json()["id"])
        assert row.role == "rollback" and row.status == "running"
        assert row.envelope["applied"] is False
        assert db.get(Intent, row.envelope["intent_key"]).status == "pending"

    health = client.get("/api/apps/health")
    assert health.status_code == 200, health.text
    route_status = next(item for item in health.json() if item["app_id"] == app_id)
    assert route_status["status"] == "live"

    # The app-wide test DB is shared across modules; close this queued fixture so
    # later scheduler tests do not correctly treat it as an active rollback lane.
    with SessionLocal() as db:
        row = db.get(StageJob, response.json()["id"])
        row.status = "failed"
        row.completed_at = utcnow()
        db.commit()
