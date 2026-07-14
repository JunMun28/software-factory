"""System / ops endpoints (ADR 0007).

Routes:
  GET  /api/health          — liveness + DB + brain/runner mode + agent CLI
  POST /api/simulator/tick  — manual simulator advance (non-agent mode only)
"""

import logging

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from .. import simulator
from ..agent_exec import agent_cli, brain_mode, runner_mode
from ..db import get_db
from ..leader import get_elector
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
    return {
        "status": "ok", "db": "ok", "brain": brain_mode(), "runner": runner_mode(),
        "cli": agent_cli(), "smtp": smtp_status(),
        "leader": get_elector().is_leader(), "epoch": get_elector().epoch,
    }


@router.post("/api/simulator/tick")
def sim_tick(db: Session = Depends(get_db)):
    if runner_mode() == "agent":
        return {"moved": [], "note": "runner=agent — the real agents drive the stages"}
    return {"moved": simulator.tick(db)}
