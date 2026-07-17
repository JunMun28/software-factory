"""Fleet reads plus the C8 fenced, tick-driven rollback contract."""
from uuid import uuid4

from fake_kube import FakeKubeClient

from app import api_helpers, deploy_manifests, kube_runner, settings, transitions
from app.db import SessionLocal
from app.kube_runner import KubeJobRunner
from app.models import App, ProgressEvent, Request, StageJob, utcnow

OLD_DIGEST = "sha256:" + "a" * 64
NEW_DIGEST = "sha256:" + "b" * 64


def _record_deploy(app_id: int, digest: str, url: str, ref: str = "REQ-1"):
    with SessionLocal() as db:
        db.add(ProgressEvent(
            request_id=None, subject_id=app_id, kind="gate_event", stage="deploy",
            actor="Factory", bot=True, broadcast=True,
            title=f"Deployed — {url} is live",
            payload={"digest": digest, "url": url, "Ref": ref},
        ))
        db.commit()


def _record_deploy_witness(app_id: int, digest: str) -> None:
    """Create the durable succeeded-deploy witness required by C8 rollback."""
    with SessionLocal() as db:
        request = Request(
            ref=f"RB-{uuid4().hex[:8]}",
            title="Fleet rollback witness",
            description="Previously verified production deploy",
            type="enh",
            app_id=app_id,
            status=transitions.DONE,
            stage="done",
        )
        db.add(request)
        db.flush()
        db.add(
            StageJob(
                request_id=request.id,
                stage="deploy",
                attempt=1,
                role="deploy",
                job_name=f"fleet-deploy-{request.ref.lower()}",
                status="succeeded",
                deadline_at=utcnow(),
                completed_at=utcnow(),
                envelope={"digest": digest, "image": f"registry/app@{digest}"},
            )
        )
        db.commit()


def _first_app_id(client) -> int:
    return client.get("/api/apps").json()[0]["id"]


def test_fleet_reports_the_latest_live_digest(client):
    app_id = _first_app_id(client)
    _record_deploy(app_id, OLD_DIGEST, "http://northwind.localtest.me")
    _record_deploy(app_id, NEW_DIGEST, "http://northwind.localtest.me")
    app = next(a for a in client.get("/api/apps").json() if a["id"] == app_id)
    assert app["last_deploy"]["digest"] == NEW_DIGEST
    assert app["last_deploy"]["url"] == "http://northwind.localtest.me"
    assert app["last_deploy"]["rollback"] is False


def test_deploy_history_lists_newest_first(client):
    app_id = _first_app_id(client)
    _record_deploy(app_id, OLD_DIGEST, "http://app.localtest.me")
    _record_deploy(app_id, NEW_DIGEST, "http://app.localtest.me")
    history = client.get(f"/api/apps/{app_id}/deploys").json()
    digests = [d["digest"] for d in history]
    assert digests.index(NEW_DIGEST) < digests.index(OLD_DIGEST)


def test_rollback_refused_when_deploys_are_disabled(client):
    app_id = _first_app_id(client)
    _record_deploy(app_id, OLD_DIGEST, "http://app.localtest.me")
    resp = client.post(f"/api/apps/{app_id}/rollback",
                       json={"digest": OLD_DIGEST, "operator_id": 1})
    assert resp.status_code == 409
    assert "not enabled" in resp.json()["detail"]


def test_rollback_refuses_a_digest_that_was_never_live(client, monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "REGISTRY", "sf-registry:5000")
    monkeypatch.setattr(settings, "APP_DEPLOY", True)
    app_id = _first_app_id(client)
    resp = client.post(f"/api/apps/{app_id}/rollback",
                       json={"digest": "sha256:" + "f" * 64, "operator_id": 1})
    assert resp.status_code == 409
    assert "never live" in resp.json()["detail"]


def test_rollback_reapplies_the_previous_digest(client, monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "REGISTRY", "sf-registry:5000")
    monkeypatch.setattr(settings, "APP_DEPLOY", True)
    app_id = _first_app_id(client)
    with SessionLocal() as db:
        slug = db.get(App, app_id).key
    url = f"http://{slug}.localtest.me"
    _record_deploy(app_id, OLD_DIGEST, url)
    _record_deploy(app_id, NEW_DIGEST, url)
    _record_deploy_witness(app_id, OLD_DIGEST)
    _record_deploy_witness(app_id, NEW_DIGEST)

    fake = FakeKubeClient()
    fake.mark_ready(deploy_manifests.app_name(slug))
    monkeypatch.setattr(kube_runner, "_http_ok", lambda _url: True)
    old_pipeline = api_helpers.pipeline()
    runner = KubeJobRunner(client=fake)
    api_helpers.set_pipeline(runner)
    try:
        resp = client.post(f"/api/apps/{app_id}/rollback",
                           json={"digest": OLD_DIGEST, "operator_id": 1})
        assert resp.status_code == 202, resp.text
        assert resp.json()["digest"] == OLD_DIGEST
        assert resp.json()["status"] == "running"

        # Enqueue is side-effect free. The leader tick applies, then verifies
        # rollout + health + the exact live digest before recording success.
        with SessionLocal() as db:
            runner.tick(db)
            runner.tick(db)

        # the cluster got the full manifest set, image pinned at the OLD digest
        kinds = [m["kind"] for m in fake.applied]
        assert {"Deployment", "Service", "Ingress"} <= set(kinds)
        deployment = next(m for m in fake.applied if m["kind"] == "Deployment")
        image = deployment["spec"]["template"]["spec"]["containers"][0]["image"]
        assert image.endswith(f"@{OLD_DIGEST}")

        # the fleet now reports the rolled-back digest as live, marked as a rollback
        app = next(a for a in client.get("/api/apps").json() if a["id"] == app_id)
        assert app["last_deploy"]["digest"] == OLD_DIGEST
        assert app["last_deploy"]["rollback"] is True
    finally:
        api_helpers.set_pipeline(old_pipeline)
