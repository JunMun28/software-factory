"""Shared lifecycle transitions (ADR 0013).

The simulator and the AgentRunner used to each own a copy of the merge-gate
raise and the done transition; the copies had already drifted apart in their
event text, and the Retry endpoint forked the same way (it only knew the
simulator's semantics). The state changes live here once — the runners keep
only what is genuinely theirs (the git merge, the per-stage scripts).
"""
from sqlalchemy.orm import Session

from .events import emit
from .models import Request, utcnow


def raise_merge_gate(db: Session, req: Request) -> None:
    """Review passed → wait for a human. The stage clock restarts at the gate."""
    req.gate = "approve_merge"
    req.stage_entered_at = utcnow()
    emit(db, req, "gate_event", "Waiting at the merge gate — review passed, approval needed",
         broadcast=True, payload={"gate": "approve_merge", "Ref": req.ref})


def finish_done(db: Session, req: Request, actor: str, *, merge_note: str,
                deploy_title: str, payload_extra: dict | None = None) -> None:
    """The one human-gated irreversible step: merge approved → done + Deployed."""
    req.gate = None
    req.stage = "done"
    req.status = "done"
    req.stage_entered_at = utcnow()
    emit(db, req, "gate_event", f"Merge approved by {actor} — {merge_note}",
         actor=actor, bot=False, broadcast=True,
         payload={"gate": "approve_merge", "Ref": req.ref, **(payload_extra or {})})
    emit(db, req, "milestone_summary", deploy_title,
         stage="done", payload={"Stage": "Done", "Ref": req.ref})
