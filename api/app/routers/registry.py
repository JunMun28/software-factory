"""App-registry endpoints (ADR 0007) + the fleet surface (console gap #5).

Routes:
  GET   /api/apps                    — list all apps with open counts + last deploy
  POST  /api/apps                    — register a new app
  PATCH /api/apps/{app_id}           — update app metadata
  GET   /api/apps/{app_id}/deploys   — deploy history (digests that were live)
  POST  /api/apps/{app_id}/rollback  — re-apply a previously-live digest
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import api_helpers, deploy_manifests, settings
from ..db import get_db
from ..models import App, ProgressEvent, Request
from ..revision import bump_revision
from ..schemas import AppDeploy, AppIn, AppOut, RollbackIn
from .operators import require_approver

router = APIRouter()

# Deploy records ride the append-only log: the deploy-finished gate_event and any
# rollback recovery_action both carry {digest, url} in their payload (kube_runner
# _probe_and_finish / rollback below). Reading them back IS the deploy history —
# no new table, no second source of truth.
_DEPLOY_KINDS = ("gate_event", "recovery_action", "milestone_summary")


def _app_deploys(db: Session, app_id: int, limit: int = 20) -> list[AppDeploy]:
    events = db.scalars(
        select(ProgressEvent)
        .where(ProgressEvent.subject_id == app_id, ProgressEvent.kind.in_(_DEPLOY_KINDS))
        .order_by(ProgressEvent.id.desc())
        .limit(300)
    ).all()
    out: list[AppDeploy] = []
    for ev in events:
        p = ev.payload or {}
        if not (p.get("digest") and p.get("url")):
            continue
        out.append(AppDeploy(
            digest=p["digest"], url=p["url"], at=ev.created_at,
            ref=p.get("Ref"), rollback=ev.kind == "recovery_action",
        ))
        if len(out) >= limit:
            break
    return out


def _latest_deploys(db: Session, app_ids: list[int]) -> dict[int, AppDeploy]:
    """One bounded scan for the whole fleet list (avoids a per-app query)."""
    if not app_ids:
        return {}
    events = db.scalars(
        select(ProgressEvent)
        .where(ProgressEvent.subject_id.in_(app_ids), ProgressEvent.kind.in_(_DEPLOY_KINDS))
        .order_by(ProgressEvent.id.desc())
        .limit(500)
    ).all()
    latest: dict[int, AppDeploy] = {}
    for ev in events:
        p = ev.payload or {}
        if ev.subject_id in latest or not (p.get("digest") and p.get("url")):
            continue
        latest[ev.subject_id] = AppDeploy(
            digest=p["digest"], url=p["url"], at=ev.created_at,
            ref=p.get("Ref"), rollback=ev.kind == "recovery_action",
        )
    return latest


@router.get("/api/apps", response_model=list[AppOut])
def list_apps(db: Session = Depends(get_db)):
    # one grouped COUNT instead of lazy-loading every request row per app
    counts = dict(
        db.query(Request.app_id, func.count())
        .filter(Request.app_id.isnot(None), Request.status.notin_(("done", "cancelled")))
        .group_by(Request.app_id).all()
    )
    apps = db.query(App).order_by(App.id).all()
    deploys = _latest_deploys(db, [a.id for a in apps])
    out = []
    for a in apps:
        o = AppOut.model_validate(a, from_attributes=True)
        o.open_requests = counts.get(a.id, 0)
        o.unread = o.open_requests > 0 and not a.muted
        o.last_deploy = deploys.get(a.id)
        out.append(o)
    return out


@router.post("/api/apps", response_model=AppOut)
def create_app_entry(body: AppIn, db: Session = Depends(get_db)):
    key = body.name.lower().replace(" ", "-")[:40]
    if db.query(App).filter(App.key == key).first():
        raise HTTPException(409, "App already registered")
    a = App(key=key, name=body.name, owner=body.owner, repo=body.repo, provisioning=body.provisioning, muted=body.muted)
    db.add(a)
    db.commit()
    bump_revision()
    return AppOut.model_validate(a, from_attributes=True)


@router.patch("/api/apps/{app_id}", response_model=AppOut)
def update_app(app_id: int, body: AppIn, db: Session = Depends(get_db)):
    a = db.get(App, app_id)
    if not a:
        raise HTTPException(404, "App not found")
    values = (body.name, body.owner, body.repo, body.provisioning, body.muted)
    changed = values != (a.name, a.owner, a.repo, a.provisioning, a.muted)
    if changed:
        a.name, a.owner, a.repo, a.provisioning, a.muted = values
        db.commit()
        bump_revision()
    return AppOut.model_validate(a, from_attributes=True)


@router.get("/api/apps/{app_id}/deploys", response_model=list[AppDeploy])
def app_deploys(app_id: int, db: Session = Depends(get_db)):
    if not db.get(App, app_id):
        raise HTTPException(404, "App not found")
    return _app_deploys(db, app_id)


@router.post("/api/apps/{app_id}/rollback", response_model=AppDeploy)
def rollback_app(app_id: int, body: RollbackIn, db: Session = Depends(get_db)):
    """Re-apply the app's manifests pinned to a digest that was previously live.

    Deploys are digest-pinned (B3), so rollback is the same server-side apply
    as a deploy — no build, no new subsystem. Only digests found in the app's
    own deploy history are accepted: rollback can never ship an image the
    factory did not already run."""
    app = db.get(App, app_id)
    if not app:
        raise HTTPException(404, "App not found")
    operator = require_approver(db, body.operator_id)
    if not settings.app_deploy_enabled():
        raise HTTPException(409, "Deploys are not enabled on this factory")
    history = _app_deploys(db, app_id, limit=50)
    target = next((d for d in history if d.digest == body.digest), None)
    if target is None:
        raise HTTPException(409, "That digest was never live for this app")
    runner = api_helpers.pipeline()
    client = getattr(runner, "client", None)
    if client is None:
        raise HTTPException(409, "No kube runner is active — cannot touch the cluster")
    for manifest in deploy_manifests.app_deploy_manifests(app.key, body.digest, 1):
        client.apply(manifest)
    ev = ProgressEvent(
        request_id=None, subject_id=app.id, kind="recovery_action", stage="deploy",
        actor=operator.name, bot=False, broadcast=True,
        title=f"Rolled back {app.name} to a previous image",
        payload={"digest": body.digest, "url": target.url, "App": app.name,
                 "rolled_back_from": history[0].digest if history else None},
    )
    db.add(ev)
    db.commit()
    bump_revision()
    return AppDeploy(digest=body.digest, url=target.url, at=ev.created_at, rollback=True)
