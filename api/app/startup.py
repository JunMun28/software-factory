"""One-shot startup chores — called from the lifespan in main.py, one named
function per concern so the boot sequence reads as a table of contents."""
import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

from . import transitions
from .db import engine
from .leader import get_elector
from .models import PIPELINE_STAGES, Comment, ProgressEvent, Request

log = logging.getLogger("factory")


def backfill_stage_clock() -> None:
    """stage_entered_at arrived after the first DBs shipped — derive it once."""
    with engine.connect() as conn:
        conn.execute(text("UPDATE requests SET stage_entered_at = updated_at WHERE stage_entered_at IS NULL"))
        conn.commit()


def backfill_comment_events(db: Session) -> None:
    """One-time backfill: comments ride the progress_event log (ADR 0012)."""
    if db.query(ProgressEvent).filter(ProgressEvent.kind == "comment").count():
        return
    for c in db.query(Comment).all():
        db.add(ProgressEvent(
            request_id=c.request_id, subject_id=c.request.app_id, kind="comment",
            stage=c.request.stage, actor=c.author, bot=False, broadcast=False,
            title=c.body[:300],
            payload={"comment_id": c.id, "initials": c.initials, "color": c.color, "body": c.body},
            created_at=c.created_at,
        ))
    db.commit()


def escalate_orphans(db: Session) -> None:
    """A restart kills the pipeline worker threads; anything left mid-stage is
    orphaned — escalate it so it is VISIBLE and Retry can re-drive it
    (stop + flag, never auto-rerun: CONTEXT.md escalation, ADR 0013).
    Runs right after this process acquired leadership, so the epoch is ours."""
    epoch = get_elector().epoch
    orphans = db.query(Request).filter(
        Request.status == transitions.APPROVED, Request.needs_human.is_(False),
        Request.gate.is_(None), Request.stage.in_(PIPELINE_STAGES),
    ).all()
    for r in orphans:
        res = transitions.apply(
            db, r, "escalate", actor=transitions.FACTORY,
            params={"reason": "Pipeline orphaned by a server restart — Retry re-runs the stage"},
            epoch=epoch,
        )
        if isinstance(res, transitions.Loss):
            continue
        db.commit()
        res.notify()
        log.warning("startup: %s was orphaned mid-%s — escalated for Retry", r.ref, r.stage)
