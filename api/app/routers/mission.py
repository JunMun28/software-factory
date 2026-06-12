"""Mission control aggregate (spec 2026-06-12 §5): the home surface polls
this one endpoint instead of five."""
from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from ..api_helpers import to_out
from ..db import get_db
from ..models import ProgressEvent, Request, utcnow
from ..schemas import EvidenceOut, MissionGate, MissionOut, MissionRun, RunStateOut
from ..supervision import evidence, run_state

router = APIRouter()

CLOSED = ("cancelled", "done")


@router.get("/api/mission", response_model=MissionOut)
def mission(db: Session = Depends(get_db)):
    live = (db.query(Request)
            .filter(Request.status.notin_(CLOSED))
            .order_by(Request.stage_entered_at)
            .all())
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
    recent_rows = (db.query(Request)
                   .filter(or_(and_(Request.status.in_(CLOSED), Request.updated_at >= week_ago),
                               Request.status == "sent_back"))
                   .order_by(Request.updated_at.desc())
                   .limit(10)
                   .all())
    recent = [to_out(r) for r in recent_rows]
    cursor = db.query(func.max(ProgressEvent.id)).scalar() or 0
    return MissionOut(gates=gates, runs=runs, stalled=stalled, recent=recent, cursor=cursor)
