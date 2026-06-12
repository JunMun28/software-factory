"""Derived run-state, steer-note bookkeeping, and gate evidence (ADR 0014).

Everything here is DERIVED from the append-only progress_event log (ADR 0008)
at read time — no mutable run columns exist, and the log is never UPDATEd.
A steer note is "consumed" when a later step_summary lists its id in
payload.acked_steer_ids; pending notes are computed, never flagged in place.
"""
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from . import settings
from .models import PIPELINE_STAGES, ProgressEvent, Request, utcnow
from .simulator import STEP_PLANS


def _aware(dt: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes; normalize before arithmetic."""
    if dt is None or dt.tzinfo:
        return dt
    return dt.replace(tzinfo=timezone.utc)


def in_flight(r: Request) -> bool:
    """Running autonomously right now: approved, in a pipeline stage, not
    parked at a gate, not escalated."""
    return (r.status == "approved" and r.stage in PIPELINE_STAGES
            and not r.needs_human and r.gate is None)


def run_state(db: Session, r: Request) -> dict | None:
    """{step, of, label, health, seconds_since_event} for an in-flight run,
    else None. health: healthy | slow | no_signal — never a false 'stalled'
    (stalled is the needs_human escalation, a different surface)."""
    if not in_flight(r):
        return None
    ev = (db.query(ProgressEvent)
          .filter(ProgressEvent.request_id == r.id,
                  ProgressEvent.kind == "step_summary",
                  ProgressEvent.stage == r.stage)
          .order_by(ProgressEvent.id.desc())
          .first())
    plan_len = len(STEP_PLANS.get(r.stage, []))
    last_at = _aware(ev.created_at) if ev else _aware(r.stage_entered_at)
    seconds = max(0, int((utcnow() - last_at).total_seconds())) if last_at else 0
    if ev is None:
        return {"step": 0, "of": plan_len, "label": None,
                "health": "no_signal", "seconds_since_event": seconds}
    p = ev.payload or {}
    health = "healthy" if seconds < settings.RUN_SLOW_AFTER_SECONDS else "slow"
    return {"step": p.get("step", 0), "of": p.get("of", plan_len),
            "label": p.get("label"), "health": health,
            "seconds_since_event": seconds}


def pending_steer_notes(db: Session, r: Request) -> list[ProgressEvent]:
    """Steer notes not yet acknowledged by a later step_summary."""
    rows = (db.query(ProgressEvent)
            .filter(ProgressEvent.request_id == r.id,
                    ProgressEvent.kind.in_(("steer_note", "step_summary")))
            .order_by(ProgressEvent.id)
            .all())
    acked: set[int] = set()
    for ev in rows:
        if ev.kind == "step_summary":
            acked.update((ev.payload or {}).get("acked_steer_ids") or [])
    return [ev for ev in rows if ev.kind == "steer_note" and ev.id not in acked]


def evidence(db: Session, r: Request) -> dict | None:
    """What the admin sees before approving (spec §6 'evidence strip').
    Spec gates derive from the grounded draft spec; merge gates read the
    latest verification event. None → the UI renders 'no evidence recorded'."""
    if r.gate == "approve_spec":
        lines = r.spec_lines
        return {"kind": "spec",
                "grounded_lines": sum(1 for ln in lines if ln.prov and not ln.assume),
                "total_lines": len(lines),
                "interview_count": sum(1 for t in r.turns if t.answer),
                "assumptions": [ln.text for ln in lines if ln.assume]}
    if r.gate == "approve_merge":
        ev = (db.query(ProgressEvent)
              .filter(ProgressEvent.request_id == r.id,
                      ProgressEvent.kind == "verification")
              .order_by(ProgressEvent.id.desc())
              .first())
        if not ev:
            return None
        p = ev.payload or {}
        return {"kind": "merge",
                "tests_passed": p.get("tests_passed"), "tests_total": p.get("tests_total"),
                "diff_added": p.get("diff_added"), "diff_removed": p.get("diff_removed"),
                "files_changed": p.get("files_changed"),
                "reviewer_verdict": p.get("reviewer_verdict"),
                "assumptions": p.get("assumptions") or []}
    return None
