"""Mission control aggregate (spec 2026-06-12 §5): the home surface polls
this one endpoint instead of five."""
from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..api_helpers import to_out
from ..db import get_db
from ..models import AuditEvent, ProgressEvent, Request, utcnow
from ..schemas import EvidenceOut, MissionGate, MissionOut, MissionRecent, MissionRun, RunStateOut
from ..supervision import evidence, run_state

router = APIRouter()

CLOSED = ("cancelled", "done")


@router.get("/api/mission", response_model=MissionOut)
def mission(db: Session = Depends(get_db)):
    live = db.scalars(
        select(Request).where(Request.status.notin_(CLOSED)).order_by(Request.stage_entered_at)
    ).all()
    gates = []
    for r in live:
        if r.gate and not r.needs_human:
            ev = evidence(db, r)
            gates.append(MissionGate(
                request=to_out(r),
                evidence=EvidenceOut(**ev) if ev is not None else None,
            ))
    runs = []
    for r in live:
        rs = run_state(db, r)
        if rs:
            runs.append(MissionRun(request=to_out(r), run=RunStateOut(**rs)))
    stalled = [to_out(r) for r in live if r.needs_human]
    week_ago = utcnow() - timedelta(days=7)
    recent = []
    outcomes = db.execute(
        select(AuditEvent, Request)
        .join(Request, AuditEvent.request_id == Request.id)
        .where(AuditEvent.action.in_(("approved", "approved_merge", "sent_back", "cancelled")),
               AuditEvent.created_at >= week_ago)
        .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
        .limit(10)
    ).all()
    for decision, request in outcomes:
        recent.append(MissionRecent(request=to_out(request), outcome=decision.action,
                                    decided_by=decision.actor, decided_at=decision.created_at))
    cursor = db.query(func.max(ProgressEvent.id)).scalar() or 0
    return MissionOut(gates=gates, runs=runs, stalled=stalled, recent=recent, cursor=cursor)
