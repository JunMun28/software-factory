"""App-registry endpoints (ADR 0007) plus additive fleet reads.

Routes:
  GET   /api/apps                    — list apps with open counts + last deploy
  POST  /api/apps                    — register a new app
  PATCH /api/apps/{app_id}           — update app metadata
  GET   /api/apps/{app_id}/deploys   — append-only deploy history
  POST  /api/apps/{app_id}/rollback  — enqueue C8's fenced rollback
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import registry as registry_service
from .. import settings
from ..db import get_db
from ..leader import get_elector
from ..models import App, ProgressEvent, Request
from ..revision import bump_revision
from ..schemas import AppDeploy, AppIn, AppOut, RollbackIn
from .operators import require_approver

router = APIRouter()


# Deploy records ride the append-only event log: deploy-finished gate events
# and rollback recovery actions both carry {digest, url}. Reading those events
# is the console history; it does not create a second mutable source of truth.
_DEPLOY_KINDS = ("gate_event", "recovery_action", "milestone_summary")


def _app_deploys(db: Session, app_id: int, limit: int = 20) -> list[AppDeploy]:
    events = db.scalars(
        select(ProgressEvent)
        .where(
            ProgressEvent.subject_id == app_id,
            ProgressEvent.kind.in_(_DEPLOY_KINDS),
        )
        .order_by(ProgressEvent.id.desc())
        .limit(300)
    ).all()
    output: list[AppDeploy] = []
    for event in events:
        payload = event.payload or {}
        if not (payload.get("digest") and payload.get("url")):
            continue
        output.append(
            AppDeploy(
                digest=payload["digest"],
                url=payload["url"],
                at=event.created_at,
                ref=payload.get("Ref"),
                rollback=event.kind == "recovery_action",
            )
        )
        if len(output) >= limit:
            break
    return output


def _latest_deploys(db: Session, app_ids: list[int]) -> dict[int, AppDeploy]:
    """One bounded scan for the whole fleet list (avoids a per-app query)."""
    if not app_ids:
        return {}
    events = db.scalars(
        select(ProgressEvent)
        .where(
            ProgressEvent.subject_id.in_(app_ids),
            ProgressEvent.kind.in_(_DEPLOY_KINDS),
        )
        .order_by(ProgressEvent.id.desc())
        .limit(500)
    ).all()
    latest: dict[int, AppDeploy] = {}
    for event in events:
        payload = event.payload or {}
        if event.subject_id in latest or not (
            payload.get("digest") and payload.get("url")
        ):
            continue
        latest[event.subject_id] = AppDeploy(
            digest=payload["digest"],
            url=payload["url"],
            at=event.created_at,
            ref=payload.get("Ref"),
            rollback=event.kind == "recovery_action",
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
    deploys = _latest_deploys(db, [app.id for app in apps])
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


@router.get("/api/apps/health")
def app_health(db: Session = Depends(get_db)):
    return registry_service.fleet_health(db)


@router.get("/api/apps/{app_id}/deployments")
def deployment_history(app_id: int, db: Session = Depends(get_db)):
    if db.get(App, app_id) is None:
        raise HTTPException(404, "App not found")
    return registry_service.rollback_history(db, app_id)


@router.get("/api/apps/{app_id}/deploys", response_model=list[AppDeploy])
def app_deploys(app_id: int, db: Session = Depends(get_db)):
    if db.get(App, app_id) is None:
        raise HTTPException(404, "App not found")
    return _app_deploys(db, app_id)


@router.post("/api/apps/{app_id}/rollback", status_code=202)
def rollback_app(app_id: int, body: RollbackIn, db: Session = Depends(get_db)):
    operator = require_approver(db, body.operator_id)
    if not settings.app_deploy_enabled():
        raise HTTPException(409, "Deploys are not enabled on this factory")
    try:
        row = registry_service.enqueue_rollback(
            db,
            app_id,
            body.digest,
            epoch=get_elector().epoch,
            actor=operator.name,
        )
    except registry_service.RollbackNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except (
        registry_service.RollbackBusy,
        registry_service.RollbackFenced,
        registry_service.RollbackNeverLive,
    ) as exc:
        raise HTTPException(409, str(exc)) from exc
    return {
        "id": row.id,
        "status": row.status,
        "digest": (row.envelope or {}).get("digest"),
    }
