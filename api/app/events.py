"""Helpers for writing to the one append-only progress_event log (ADR 0008)."""
from sqlalchemy.orm import Session

from .models import ProgressEvent, Request


def emit(
    db: Session,
    req: Request | None,
    kind: str,
    title: str,
    *,
    stage: str | None = None,
    actor: str = "Factory",
    bot: bool = True,
    broadcast: bool = False,
    body: str | None = None,
    payload: dict | None = None,
) -> ProgressEvent:
    ev = ProgressEvent(
        request_id=req.id if req else None,
        subject_id=req.app_id if req else None,
        kind=kind,
        stage=stage or (req.stage if req else "intake"),
        actor=actor,
        bot=bot,
        broadcast=broadcast,
        title=title,
        body=body,
        payload=payload or {},
    )
    db.add(ev)
    return ev
