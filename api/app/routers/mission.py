"""Mission control aggregate (spec 2026-06-12 §5): the home surface polls
this one endpoint instead of five. Bands derive from supervision.classify()."""
from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import transitions
from ..api_helpers import to_out
from ..db import get_db
from ..models import AuditEvent, ProgressEvent, Request, utcnow
from ..schemas import (
    EvidenceOut,
    MissionGate,
    MissionHumanOwned,
    MissionOut,
    MissionRecent,
    MissionRun,
    MissionStats,
    RunStateOut,
    SteerStateOut,
)
from ..supervision import classify, evidence, run_state, steer_state

router = APIRouter()


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def _stats(db: Session, live: list[Request]) -> MissionStats:
    """The factory's gauges, computed from what the log already records.
    Kept to bounded queries (recent slices) — this rides the home poll."""
    now = utcnow()
    week_ago = now - timedelta(days=7)

    # Cycle time: request created → done, over the last 10 shipped.
    done = db.scalars(
        select(Request).where(Request.status == "done")
        .order_by(Request.updated_at.desc()).limit(10)
    ).all()
    cycle = _median([
        (r.updated_at - r.created_at).total_seconds() / 3600 for r in done
    ])

    # Gate wait: the latest gate_event before each recent human decision.
    decisions = db.scalars(
        select(AuditEvent)
        .where(AuditEvent.action.in_(("approved", "approved_merge", "approved_deploy", "sent_back")),
               AuditEvent.created_at >= week_ago)
        .order_by(AuditEvent.created_at.desc()).limit(20)
    ).all()
    waits: list[float] = []
    for decision in decisions:
        raised = db.scalar(
            select(ProgressEvent)
            .where(ProgressEvent.request_id == decision.request_id,
                   ProgressEvent.kind == "gate_event",
                   ProgressEvent.created_at <= decision.created_at)
            .order_by(ProgressEvent.id.desc()).limit(1)
        )
        if raised:
            waits.append((decision.created_at - raised.created_at).total_seconds() / 3600)

    shipped_7d = db.scalar(
        select(func.count(Request.id))
        .where(Request.status == "done", Request.updated_at >= week_ago)
    ) or 0

    gate_ages = [
        (now - r.stage_entered_at).total_seconds() / 3600
        for r in live if r.gate and r.stage_entered_at
    ]
    return MissionStats(
        cycle_median_h=round(cycle, 1) if cycle is not None else None,
        gate_wait_median_h=round(_median(waits), 1) if waits else None,
        shipped_7d=shipped_7d,
        oldest_gate_h=round(max(gate_ages), 1) if gate_ages else None,
    )

@router.get("/api/mission", response_model=MissionOut)
def mission(db: Session = Depends(get_db)):
    live = db.scalars(
        select(Request)
        .where(Request.status.notin_(transitions.CLOSED))
        .order_by(Request.stage_entered_at)
    ).all()
    gates = []
    for r in live:
        if classify(r)["at_gate"]:
            ev = evidence(db, r)
            gates.append(MissionGate(
                request=to_out(r),
                evidence=EvidenceOut(**ev) if ev is not None else None,
            ))
    runs = []
    for r in live:
        rs = run_state(db, r)
        if rs:
            steer = steer_state(db, r)
            runs.append(MissionRun(
                request=to_out(r),
                run=RunStateOut(**rs),
                steer=SteerStateOut(**steer) if steer is not None else None,
            ))
    stalled = [to_out(r) for r in live if classify(r)["stalled"]]
    human_owned = []
    for r in live:
        if classify(r)["phase"] != "human_owned":
            continue
        takeover = db.scalar(
            select(AuditEvent)
            .where(AuditEvent.request_id == r.id, AuditEvent.action == "taken_over")
            .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
            .limit(1)
        )
        if takeover:
            human_owned.append(MissionHumanOwned(
                request=to_out(r),
                taken_over_by=takeover.actor,
                taken_over_at=takeover.created_at,
            ))
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
    return MissionOut(
        gates=gates,
        runs=runs,
        stalled=stalled,
        human_owned=human_owned,
        recent=recent,
        stats=_stats(db, live),
        cursor=cursor,
    )
