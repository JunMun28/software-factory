"""App-registry endpoints (ADR 0007).

Routes:
  GET   /api/apps            — list all apps with live open-request counts
  POST  /api/apps            — register a new app
  PATCH /api/apps/{app_id}   — update app metadata
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import registry as registry_service
from ..db import get_db
from ..leader import get_elector
from ..models import App, Request
from ..revision import bump_revision
from ..schemas import AppIn, AppOut

router = APIRouter()


class RollbackIn(BaseModel):
    digest: str


@router.get("/api/apps", response_model=list[AppOut])
def list_apps(db: Session = Depends(get_db)):
    # one grouped COUNT instead of lazy-loading every request row per app
    counts = dict(
        db.query(Request.app_id, func.count())
        .filter(Request.app_id.isnot(None), Request.status.notin_(("done", "cancelled")))
        .group_by(Request.app_id).all()
    )
    out = []
    for a in db.query(App).order_by(App.id).all():
        o = AppOut.model_validate(a, from_attributes=True)
        o.open_requests = counts.get(a.id, 0)
        o.unread = o.open_requests > 0 and not a.muted
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


@router.post("/api/apps/{app_id}/rollback", status_code=202)
def rollback_app(app_id: int, body: RollbackIn, db: Session = Depends(get_db)):
    try:
        row = registry_service.enqueue_rollback(
            db,
            app_id,
            body.digest,
            epoch=get_elector().epoch,
        )
    except registry_service.RollbackNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except (registry_service.RollbackBusy, registry_service.RollbackFenced) as exc:
        raise HTTPException(409, str(exc)) from exc
    return {
        "id": row.id,
        "status": row.status,
        "digest": (row.envelope or {}).get("digest"),
    }
