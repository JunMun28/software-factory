"""Factory-owned registry retention and rollback history (DEPLOY-02).

Manifest deletion is safe online; blob reclamation is deliberately left to the
suspended maintenance CronJob in deploy/base/registry.yaml. Protection is
fail-closed: DB, rollback-history, and cluster deployment reads must all finish
before any registry manifest is deleted.
"""

import json
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Protocol

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import settings
from .kube_client import KubeClient
from .models import App, LeaderEpoch, ProgressEvent, Request, StageJob, utcnow


class RollbackError(Exception):
    """Base class for an operator-visible rollback refusal."""


class RollbackNotFound(RollbackError):
    pass


class RollbackBusy(RollbackError):
    pass


class RollbackFenced(RollbackError):
    pass


class RollbackNeverLive(RollbackError):
    """A valid digest has no completed production-deploy witness for this app."""

    pass

_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_DURATION = re.compile(r"^(\d+)([smhdw])$")
_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}
_MANIFEST_ACCEPT = ", ".join(
    (
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
    )
)


@dataclass(frozen=True)
class RegistryManifest:
    repository: str
    digest: str
    pushed_at: datetime | None


@dataclass(frozen=True)
class GCResult:
    deleted: tuple[tuple[str, str], ...]
    protected: frozenset[str]
    skipped_reason: str | None = None


class RegistryClient(Protocol):
    def list_manifests(self) -> list[RegistryManifest]: ...

    def delete_manifest(self, repository: str, digest: str) -> None: ...


class RegistryHTTPClient:
    """Small Docker Registry HTTP API v2 client; domain decisions stay above it."""

    def __init__(self, registry: str = settings.REGISTRY):
        if not registry:
            raise ValueError("FACTORY_REGISTRY is not configured")
        self.base_url = (
            registry.rstrip("/")
            if registry.startswith(("http://", "https://"))
            else f"http://{registry.rstrip('/')}"
        )

    def _open(self, request: urllib.request.Request):
        return urllib.request.urlopen(request, timeout=settings.REGISTRY_HTTP_TIMEOUT)

    def _json(self, path: str) -> dict:
        request = urllib.request.Request(f"{self.base_url}{path}")
        with self._open(request) as response:
            return json.loads(response.read().decode("utf-8"))

    def list_manifests(self) -> list[RegistryManifest]:
        repositories = self._json("/v2/_catalog?n=10000").get("repositories") or []
        found: dict[tuple[str, str], RegistryManifest] = {}
        for repository in repositories:
            encoded = urllib.parse.quote(repository, safe="/")
            tags = self._json(f"/v2/{encoded}/tags/list?n=10000").get("tags") or []
            for tag in tags:
                request = urllib.request.Request(
                    f"{self.base_url}/v2/{encoded}/manifests/{urllib.parse.quote(tag)}",
                    method="HEAD",
                    headers={"Accept": _MANIFEST_ACCEPT},
                )
                with self._open(request) as response:
                    digest = response.headers.get("Docker-Content-Digest", "")
                    modified = response.headers.get("Last-Modified")
                if not _DIGEST.fullmatch(digest):
                    raise RuntimeError(
                        f"registry returned no valid digest for {repository}:{tag}"
                    )
                pushed_at = parsedate_to_datetime(modified) if modified else None
                if pushed_at is not None and pushed_at.tzinfo is None:
                    pushed_at = pushed_at.replace(tzinfo=timezone.utc)
                key = (repository, digest)
                prior = found.get(key)
                if prior is None or (
                    pushed_at is not None
                    and (prior.pushed_at is None or pushed_at > prior.pushed_at)
                ):
                    found[key] = RegistryManifest(repository, digest, pushed_at)
        return list(found.values())

    def delete_manifest(self, repository: str, digest: str) -> None:
        if not _DIGEST.fullmatch(digest):
            raise ValueError(f"refusing to delete malformed digest {digest!r}")
        encoded = urllib.parse.quote(repository, safe="/")
        request = urllib.request.Request(
            f"{self.base_url}/v2/{encoded}/manifests/{digest}",
            method="DELETE",
            headers={"Accept": _MANIFEST_ACCEPT},
        )
        with self._open(request):
            return


def parse_retention(value: str) -> timedelta:
    match = _DURATION.fullmatch(value.strip().lower())
    if match is None:
        raise ValueError(
            "FACTORY_REGISTRY_RETENTION must be an integer plus s/m/h/d/w (for example 7d)"
        )
    amount, unit = match.groups()
    return timedelta(seconds=int(amount) * _UNIT_SECONDS[unit])


def _digest(value) -> str | None:
    return value if isinstance(value, str) and _DIGEST.fullmatch(value) else None


def rollback_history(db: Session, app_id: int, *, limit: int | None = None) -> list[dict]:
    """Newest production deploys that the registry API makes rollback-reachable."""
    depth = settings.REGISTRY_ROLLBACK_DEPTH if limit is None else limit
    rows = db.execute(
        select(StageJob, Request)
        .join(Request, Request.id == StageJob.request_id)
        .where(
            Request.app_id == app_id,
            StageJob.role == "deploy",
            StageJob.status == "succeeded",
        )
        .order_by(StageJob.id.desc())
        .limit(depth)
    ).all()
    history: list[dict] = []
    for row, request in rows:
        digest = _digest((row.envelope or {}).get("digest"))
        if digest is None:
            raise RuntimeError(
                f"rollback history row {row.id} has no trustworthy image digest"
            )
        history.append(
            {
                "request_id": request.id,
                "request_ref": request.ref,
                "digest": digest,
                "image": (row.envelope or {}).get("image"),
                "deployed_at": (
                    row.completed_at.isoformat() if row.completed_at else None
                ),
            }
        )
    return history


def fleet_health(db: Session) -> list[dict]:
    """Additive registry view of produced-app liveness from durable evidence."""
    latest_deploy_ids = (
        select(
            Request.app_id.label("app_id"),
            func.max(StageJob.id).label("stage_job_id"),
        )
        .join(StageJob, StageJob.request_id == Request.id)
        .where(
            Request.app_id.is_not(None),
            StageJob.role == "deploy",
            StageJob.status == "succeeded",
        )
        .group_by(Request.app_id)
        .subquery()
    )
    latest_deploys = {
        app_id: row
        for app_id, row in db.execute(
            select(latest_deploy_ids.c.app_id, StageJob).join(
                StageJob, StageJob.id == latest_deploy_ids.c.stage_job_id
            )
        ).all()
    }

    health_status = ProgressEvent.payload["health_status"].as_string()
    latest_event_ids = (
        select(
            ProgressEvent.subject_id.label("app_id"),
            func.max(ProgressEvent.id).label("event_id"),
        )
        .where(
            ProgressEvent.subject_id.is_not(None),
            health_status.in_(("live", "degraded")),
        )
        .group_by(ProgressEvent.subject_id)
        .subquery()
    )
    latest_events = {
        app_id: row
        for app_id, row in db.execute(
            select(latest_event_ids.c.app_id, ProgressEvent).join(
                ProgressEvent, ProgressEvent.id == latest_event_ids.c.event_id
            )
        ).all()
    }

    output: list[dict] = []
    for app in db.scalars(select(App).order_by(App.id)).all():
        live = latest_deploys.get(app.id)
        event = latest_events.get(app.id)
        output.append(
            {
                "app_id": app.id,
                "key": app.key,
                "status": (
                    (event.payload or {})["health_status"]
                    if event is not None
                    else "live" if live is not None else "inactive"
                ),
                "digest": (
                    _digest((live.envelope or {}).get("digest"))
                    if live is not None
                    else None
                ),
                "checked_at": event.created_at.isoformat() if event else None,
            }
        )
    return output


def enqueue_rollback(
    db: Session,
    app_id: int,
    digest: str,
    *,
    epoch: int,
    actor: str = "Operator",
) -> StageJob:
    """Persist one rollback command; the leader tick owns every kube side effect."""
    from . import intents, transitions
    from .deploy_manifests import app_name

    if _digest(digest) is None:
        raise RollbackNotFound("Rollback target must be a sha256 image digest")
    current_epoch = db.scalar(
        select(LeaderEpoch.epoch).where(LeaderEpoch.id == 1)
    )
    if epoch <= 0 or current_epoch != epoch:
        raise RollbackFenced(
            f"Rollback enqueue fenced (mine={epoch}, current={current_epoch})"
        )

    app = db.get(App, app_id)
    if app is None:
        raise RollbackNotFound("App not found")

    deploys = db.execute(
        select(StageJob, Request)
        .join(Request, Request.id == StageJob.request_id)
        .where(
            Request.app_id == app.id,
            StageJob.role == "deploy",
            StageJob.status == "succeeded",
        )
        .order_by(StageJob.id.desc())
    ).all()
    target = next(
        (
            (row, request)
            for row, request in deploys
            if _digest((row.envelope or {}).get("digest")) == digest
        ),
        None,
    )
    if target is None:
        raise RollbackNeverLive(
            "Rollback target was never live for this app "
            "(no succeeded deploy witness)"
        )
    if target[1].status != transitions.DONE or target[1].stage != "done":
        raise RollbackNeverLive(
            "Rollback target has no completed request ownership record"
        )

    current = deploys[0] if deploys else None
    if current is None:
        raise RollbackNeverLive("App has no live deploy to roll back")
    if _digest((current[0].envelope or {}).get("digest")) == digest:
        return current[0]

    intent_key = f"rollback:{app.key}:{current[0].id}:{target[0].id}"
    now = utcnow()
    rollback = StageJob(
        request_id=target[1].id,
        stage="deploy",
        attempt=1,
        role="rollback",
        job_name=app_name(app.key),
        epoch=epoch,
        status="running",
        deadline_at=now + timedelta(seconds=settings.DEPLOY_WALL_CLOCK),
        envelope={
            "digest": digest,
            "image": f"{settings.REGISTRY}/sf-app-{app.key}@{digest}",
            "app_id": app.id,
            "app_key": app.key,
            "source_deploy_id": target[0].id,
            "current_deploy_id": current[0].id,
            "intent_key": intent_key,
            "applied": False,
        },
    )
    db.add(rollback)
    result = transitions.apply(
        db,
        target[1],
        "enqueue_rollback",
        actor=transitions.Actor(name=actor),
        params={"key": app.key, "digest": digest},
        intent=transitions.IntentSpec(
            key=intent_key,
            kind=intents.APPLY_DEPLOY,
            payload={
                "app": rollback.job_name,
                "digest": digest,
                "rollback": True,
            },
        ),
        epoch=epoch,
        expected_stage="done",
    )
    if isinstance(result, transitions.Loss):
        raise RollbackFenced(result.detail)
    if result.intent is None:
        db.rollback()
        existing = db.scalars(
            select(StageJob).where(
                StageJob.role == "rollback", StageJob.status == "running"
            )
        ).all()
        replay = next(
            (
                row
                for row in existing
                if (row.envelope or {}).get("intent_key") == intent_key
            ),
            None,
        )
        if replay is None:
            raise RollbackBusy("Rollback intent already exists without a running row")
        return replay
    db.commit()
    return rollback


def _rollback_digests(db: Session) -> set[str]:
    app_ids = db.scalars(
        select(Request.app_id)
        .where(Request.app_id.is_not(None))
        .distinct()
    ).all()
    return {
        item["digest"]
        for app_id in app_ids
        for item in rollback_history(db, app_id)
    }


def protected_digests(db: Session, kube: KubeClient) -> set[str]:
    """Union of in-flight DB references, live cluster images, and rollback history."""
    protected: set[str] = set()
    rows = db.scalars(
        select(StageJob)
        .join(Request, Request.id == StageJob.request_id)
        .where(
            Request.status.not_in(("done", "cancelled")),
            StageJob.role.in_(("build", "pbuild", "deploy", "pdeploy")),
        )
    ).all()
    for row in rows:
        raw = (row.envelope or {}).get("digest")
        digest = _digest(raw)
        if raw is not None and digest is None:
            raise RuntimeError(f"StageJob {row.id} contains a malformed digest")
        if row.role in ("deploy", "pdeploy") and digest is None:
            raise RuntimeError(f"live StageJob {row.id} has no deploy digest")
        if digest is not None:
            protected.add(digest)

    images = kube.list_deployment_images("sf/tier=app")
    for image in images:
        marker = image.rpartition("@")[2]
        digest = _digest(marker)
        if digest is None:
            raise RuntimeError(f"produced-app Deployment is not digest-pinned: {image}")
        protected.add(digest)

    protected.update(_rollback_digests(db))
    return protected


def gc_unreferenced(
    db: Session,
    kube: KubeClient,
    *,
    registry_client: RegistryClient | None = None,
    now: datetime | None = None,
) -> GCResult:
    """Delete old, unprotected manifests; never performs offline blob reclaim."""
    client = registry_client or RegistryHTTPClient()
    now = now or utcnow()
    try:
        retention = parse_retention(settings.REGISTRY_RETENTION)
        first_snapshot = protected_digests(db, kube)
        manifests = client.list_manifests()
        cutoff = now - retention
        candidates = [
            item
            for item in manifests
            if item.digest not in first_snapshot
            and item.pushed_at is not None
            and item.pushed_at <= cutoff
        ]
        # Re-read every protection source after registry enumeration and before
        # the first DELETE. The single-threaded tick cannot deploy/rollback
        # between this snapshot and the deletion loop.
        protected = first_snapshot | protected_digests(db, kube)
    except Exception as exc:
        return GCResult((), frozenset(), f"protection snapshot unavailable: {exc}")

    deleted: list[tuple[str, str]] = []
    try:
        for item in candidates:
            if item.digest in protected:
                continue
            client.delete_manifest(item.repository, item.digest)
            deleted.append((item.repository, item.digest))
    except Exception as exc:
        return GCResult(
            tuple(deleted),
            frozenset(protected),
            f"registry deletion stopped: {exc}",
        )
    return GCResult(tuple(deleted), frozenset(protected))
