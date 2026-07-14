"""App-registry endpoints (ADR 0007).

Routes:
  GET   /api/apps            — list all apps with live open-request counts
  POST  /api/apps            — register a new app
  PATCH /api/apps/{app_id}   — update app metadata
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import App, Request
from ..revision import bump_revision
from ..schemas import AppIn, AppOut

router = APIRouter()


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
