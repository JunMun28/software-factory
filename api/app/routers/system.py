"""System / ops endpoints (ADR 0007).

Routes:
  GET  /api/health          — liveness + DB + brain/runner mode + agent CLI
  GET  /api/auth/config     — auth discovery for the SPAs (open; SEC-01)
  GET  /api/auth/me         — the authenticated operator, if any (SEC-01)
  POST /api/simulator/tick  — manual simulator advance (non-agent mode only)
"""

import logging

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from .. import heartbeat, settings, simulator
from ..agent_exec import agent_cli, brain_mode, runner_mode
from ..api_helpers import pipeline
from ..auth import current_operator_id
from ..db import get_db
from ..leader import get_elector
from ..models import Operator
from ..notifications import smtp_status

log = logging.getLogger("factory")

router = APIRouter()


@router.get("/api/health")
def health(db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))  # a green health check must mean the DB answers
    except Exception:
        log.exception("health check: database unavailable")
        from fastapi import HTTPException
        raise HTTPException(503, "database unavailable")
    elector = get_elector()
    tick_age = heartbeat.age_seconds()
    return {
        "status": "ok", "db": "ok", "brain": brain_mode(), "runner": runner_mode(),
        "cli": agent_cli(), "smtp": smtp_status(),
        "leader": elector.is_leader(), "epoch": elector.epoch,
        # None until the first completed leader pass; runner=agent has no tick loop.
        "tick_age_s": round(tick_age, 1) if tick_age is not None else None,
        "deploy_enabled": settings.app_deploy_enabled(),
    }


@router.get("/api/auth/config")
def auth_config():
    """SPA auth discovery (SEC-01). Open by design — client ids and the tenant
    id are PUBLIC identifiers, and serving them from the API env is how they
    stay out of the repo and the bundles. mode=off tells the SPA to skip MSAL
    entirely (dev/kind default)."""
    if settings.auth_mode() != "entra":
        return {"mode": "off"}
    return {
        "mode": "entra",
        "tenantId": settings.AZURE_TENANT_ID,
        "audience": settings.AZURE_API_AUDIENCE,
        "clientIds": {
            "console": settings.AZURE_CONSOLE_CLIENT_ID,
            "intake": settings.AZURE_INTAKE_CLIENT_ID,
        },
    }


@router.get("/api/auth/me")
def auth_me(db: Session = Depends(get_db)):
    """Who am I, per the middleware's resolution. operator=None means auth is
    off (pick-an-operator mode) or the token is submitter-only."""
    operator_id = current_operator_id()
    if operator_id is None:
        return {"mode": settings.auth_mode(), "operator": None}
    operator = db.get(Operator, operator_id)
    if operator is None:  # row deleted mid-session
        return {"mode": settings.auth_mode(), "operator": None}
    return {
        "mode": settings.auth_mode(),
        "operator": {
            "id": operator.id, "name": operator.name, "role": operator.role,
            "initials": operator.initials, "hue": operator.hue,
            "email": operator.email,
        },
    }


@router.post("/api/simulator/tick")
def sim_tick(db: Session = Depends(get_db)):
    if runner_mode() == "agent":
        return {"moved": [], "note": "runner=agent — the real agents drive the stages"}
    elector = get_elector()
    if not (elector.verify() or elector.try_acquire()):
        # a manual tick from a standby would advance state with a stale epoch's
        # un-fenced event appends — only the leader ticks (spec §3.2)
        return {"moved": [], "note": "not the leader — tick skipped"}
    if runner_mode() == "kube":
        return {"moved": pipeline().tick(db)}
    return {"moved": simulator.tick(db)}
