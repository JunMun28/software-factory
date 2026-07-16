"""DEPLOY-02: registry retention is conservative and rollback-safe."""

from dataclasses import dataclass
from datetime import timedelta
from uuid import uuid4

import pytest
from fake_kube import FakeKubeClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import registry, settings
from app.db import Base, SessionLocal
from app.models import App, Request, StageJob, utcnow

LIVE = "sha256:" + "1" * 64
CLUSTER_LIVE = "sha256:" + "2" * 64
ROLLBACK = "sha256:" + "3" * 64
ORPHAN = "sha256:" + "4" * 64


@pytest.fixture
def isolated_db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'registry-gc.db'}")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        yield db
    engine.dispose()


@dataclass
class FakeRegistryClient:
    manifests: list[registry.RegistryManifest]

    def __post_init__(self):
        self.deleted: list[tuple[str, str]] = []

    def list_manifests(self) -> list[registry.RegistryManifest]:
        return self.manifests

    def delete_manifest(self, repository: str, digest: str) -> None:
        self.deleted.append((repository, digest))


def _request(*, app: App, status: str, ref: str) -> Request:
    return Request(
        ref=ref,
        title=f"GC fixture {ref}",
        description="registry retention fixture",
        type="enh",
        status=status,
        stage="deploy" if status != "done" else "done",
        app=app,
    )


def test_gc_never_deletes_live_cluster_or_rollback_digest_and_deletes_old_orphan(
    monkeypatch, isolated_db
):
    monkeypatch.setattr(settings, "REGISTRY_RETENTION", "7d")
    monkeypatch.setattr(settings, "REGISTRY_ROLLBACK_DEPTH", 5)
    suffix = uuid4().hex[:8]
    now = utcnow()
    db = isolated_db
    try:
        app = App(
            key=f"gc-{suffix}",
            name=f"GC {suffix}",
            owner="qa",
            repo=f"sf-app-gc-{suffix}",
        )
        live = _request(app=app, status="approved", ref=f"REQ-{suffix[:6]}")
        done = _request(app=app, status="done", ref=f"REQ-{suffix[2:8]}")
        db.add_all([app, live, done])
        db.flush()
        db.add_all(
            [
                StageJob(
                    request_id=live.id,
                    stage="deploy",
                    attempt=1,
                    role="deploy",
                    job_name=f"sf-{live.ref.lower()}-deploy",
                    status="running",
                    deadline_at=now + timedelta(minutes=5),
                    envelope={"digest": LIVE},
                ),
                StageJob(
                    request_id=done.id,
                    stage="deploy",
                    attempt=1,
                    role="deploy",
                    job_name=f"sf-{done.ref.lower()}-deploy",
                    status="succeeded",
                    deadline_at=now,
                    completed_at=now,
                    envelope={"digest": ROLLBACK},
                ),
            ]
        )
        db.commit()

        kube = FakeKubeClient()
        kube.apply(
            {
                "kind": "Deployment",
                "metadata": {
                    "name": "sf-app-cluster-live",
                    "labels": {"sf/tier": "app"},
                },
                "spec": {
                    "template": {
                        "spec": {
                            "containers": [
                                {"image": f"sf-registry:5000/sf-app-live@{CLUSTER_LIVE}"}
                            ]
                        }
                    }
                },
            }
        )
        old = now - timedelta(days=8)
        registry_client = FakeRegistryClient(
            [
                registry.RegistryManifest("sf-app-live", LIVE, old),
                registry.RegistryManifest("sf-app-cluster", CLUSTER_LIVE, old),
                registry.RegistryManifest("sf-app-rollback", ROLLBACK, old),
                registry.RegistryManifest("sf-app-unused", ORPHAN, old),
            ]
        )

        result = registry.gc_unreferenced(db, kube, registry_client=registry_client, now=now)
    finally:
        db.rollback()

    assert result.deleted == (("sf-app-unused", ORPHAN),)
    assert registry_client.deleted == [("sf-app-unused", ORPHAN)]
    assert {LIVE, CLUSTER_LIVE, ROLLBACK}.issubset(result.protected)


def test_gc_fails_closed_when_any_protection_source_is_unavailable(
    monkeypatch, isolated_db
):
    monkeypatch.setattr(settings, "REGISTRY_RETENTION", "7d")

    class BrokenKube:
        def list_deployment_images(self, selector: str) -> list[str]:
            raise RuntimeError("cluster list unavailable")

    now = utcnow()
    registry_client = FakeRegistryClient(
        [
            registry.RegistryManifest(
                "sf-app-unused", ORPHAN, now - timedelta(days=30)
            )
        ]
    )
    result = registry.gc_unreferenced(
        isolated_db, BrokenKube(), registry_client=registry_client, now=now
    )

    assert result.deleted == ()
    assert "cluster list unavailable" in (result.skipped_reason or "")
    assert registry_client.deleted == []


def test_rollback_history_is_bounded_and_exposed_by_the_registry_router(
    client, monkeypatch
):
    monkeypatch.setattr(settings, "REGISTRY_ROLLBACK_DEPTH", 1)
    suffix = uuid4().hex[:8]
    now = utcnow()
    with SessionLocal() as db:
        app = App(
            key=f"history-{suffix}",
            name=f"History {suffix}",
            owner="qa",
            repo=f"sf-app-history-{suffix}",
        )
        first = _request(app=app, status="done", ref=f"REQ-{suffix[:6]}")
        second = _request(app=app, status="done", ref=f"REQ-{suffix[2:8]}")
        db.add_all([app, first, second])
        db.flush()
        for index, (request, digest) in enumerate(
            ((first, ROLLBACK), (second, LIVE)), start=1
        ):
            db.add(
                StageJob(
                    request_id=request.id,
                    stage="deploy",
                    attempt=1,
                    role="deploy",
                    job_name=f"sf-{request.ref.lower()}-deploy-{index}",
                    status="succeeded",
                    deadline_at=now,
                    completed_at=now + timedelta(seconds=index),
                    envelope={"digest": digest},
                )
            )
        db.commit()
        app_id = app.id

    response = client.get(f"/api/apps/{app_id}/deployments")
    assert response.status_code == 200, response.text
    assert [item["digest"] for item in response.json()] == [LIVE]
