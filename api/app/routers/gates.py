"""Gate and recovery-action endpoints (ADR 0007, ADR 0006, ADR 0013).

Routes:
  POST /api/requests/{rid}/approve    — approve spec or merge gate
  POST /api/requests/{rid}/send-back  — send spec back to submitter
  POST /api/requests/{rid}/respond    — submitter reply after send-back
  POST /api/requests/{rid}/cancel     — cancel a request
  POST /api/requests/{rid}/retry      — retry a stranded pipeline stage
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import update
from sqlalchemy.orm import Session

from .. import simulator
from ..api_helpers import get_request, pipeline, prospective_repo, to_out
from ..claude_exec import runner_mode
from ..db import get_db
from ..events import emit
from ..models import PIPELINE_STAGES, AuditEvent, Request, SpecLine, utcnow
from ..schemas import Note, RequestDetail

router = APIRouter()


@router.post("/api/requests/{rid}/approve", response_model=RequestDetail)
def approve(rid: int, body: Note | None = None, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    actor = (body.actor if body else None) or "Kim P."
    if r.gate == "approve_merge":
        if r.status in ("cancelled", "done"):  # a stale gate must never merge dead work
            raise HTTPException(409, f"Cannot merge a {r.status} request")
        if runner_mode() == "claude":
            pipeline().approve_merge(db, r, actor)
        else:
            simulator.approve_merge(db, r, actor)
        if r.status == "done":  # the merge can escalate instead (honest deploy)
            db.add(AuditEvent(request_id=r.id, actor=actor, action="approved_merge"))
        db.commit()
        return to_out(r, RequestDetail)
    if r.status == "approved":
        return to_out(r, RequestDetail)  # idempotent replay (ADR 0006)
    if r.status != "pending_approval":
        raise HTTPException(409, f"Cannot approve from status '{r.status}'")
    # ordered, individually-persisted side-effect ledger (PRD hardening #3)
    if not r.repo_ready:
        r.repo_ready = True
        db.commit()
    if not r.spec_pr_open:
        r.spec_pr_open = True
        db.commit()
    # atomic claim: of two concurrent approves, exactly one wins this UPDATE —
    # the loser takes the idempotent-replay path and never double-starts a pipeline
    claimed = db.execute(
        update(Request)
        .where(Request.id == r.id, Request.status == "pending_approval")
        .values(status="approved", gate=None, stage="architecture", sim_step=0,
                stage2_fired=True, stage_entered_at=utcnow())
    ).rowcount
    if not claimed:
        db.commit()
        db.refresh(r)
        return to_out(r, RequestDetail)
    db.refresh(r)
    repo = r.app.repo if r.app else prospective_repo(r)
    emit(db, r, "gate_event", f"Spec approved by {actor} — repo ready, SPEC.md PR open, Stage 2 started",
         actor=actor, bot=False, broadcast=True,
         payload={"gate": "approve_spec", "repo": repo, "Ref": r.ref})
    db.add(AuditEvent(request_id=r.id, actor=actor, action="approved",
                      note="approved the spec — repo created, SPEC.md PR opened, Stage 2 fired"))
    db.commit()
    if runner_mode() == "claude":
        pipeline().start(r.id)  # Stage 2 fires for real: Claude Code in the Subject workspace
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/send-back", response_model=RequestDetail)
def send_back(rid: int, body: Note, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    if r.status not in ("pending_approval", "submitted"):
        raise HTTPException(409, f"Cannot send back from status '{r.status}'")
    r.status = "sent_back"
    r.gate = None
    # the send-back IS the recovery action resolving the escalation — clear it
    # like retry does, or the request stays in the 'stalled' band forever
    r.needs_human = False
    r.needs_human_reason = None
    r.send_back_question = body.note or "Could you add a bit more detail?"
    r.send_back_rounds += 1
    r.stage_entered_at = utcnow()
    emit(db, r, "gate_event", "Sent back to the submitter — one question is blocking the spec",
         actor=body.actor, bot=False, broadcast=True, payload={"gate": "send_back", "Ref": r.ref})
    db.add(AuditEvent(request_id=r.id, actor=body.actor, action="sent_back", note=body.note))
    db.commit()
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/respond", response_model=RequestDetail)
def respond(rid: int, body: Note, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    if r.status != "sent_back":
        raise HTTPException(409, "Nothing to respond to")
    r.send_back_response = body.note
    r.status = "pending_approval"
    r.gate = "approve_spec"
    r.stage_entered_at = utcnow()
    if r.send_back_question:
        db.add(SpecLine(request=r, order=len(r.spec_lines), text=body.note.strip().rstrip(".") + ".",
                        prov=f"reply {r.send_back_rounds}"))
    emit(db, r, "milestone_summary", "Submitter replied — back in the approval queue",
         actor=body.actor or r.reporter, bot=False, payload={"Ref": r.ref})
    db.add(AuditEvent(request_id=r.id, actor=body.actor or r.reporter, action="responded", note=body.note))
    db.commit()
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/cancel", response_model=RequestDetail)
def cancel(rid: int, body: Note | None = None, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    if r.status in ("done", "cancelled"):
        return to_out(r, RequestDetail)
    r.status = "cancelled"
    r.gate = None
    r.needs_human = False
    r.needs_human_reason = None
    actor = (body.actor if body else None) or "Kim P."
    emit(db, r, "recovery_action", f"Request cancelled by {actor}",
         actor=actor, bot=False, payload={"Ref": r.ref})
    db.add(AuditEvent(request_id=r.id, actor=actor, action="cancelled", note=body.note if body else None))
    db.commit()
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/retry", response_model=RequestDetail)
def retry(rid: int, body: Note | None = None, db: Session = Depends(get_db)):
    """Recovery action: re-run the stuck Stage fresh (CONTEXT.md: Retry)."""
    r = get_request(db, rid)
    if not r.needs_human:
        raise HTTPException(409, "Request is not escalated")
    actor = (body.actor if body else None) or "Kim P."
    r.needs_human = False
    r.needs_human_reason = None
    r.status = "pending_approval" if r.stage == "spec" else "approved"
    if r.stage == "spec":
        r.gate = "approve_spec"
    r.sim_step = 0
    r.stage_entered_at = utcnow()
    emit(db, r, "recovery_action", f"Retry — Stage re-run requested by {actor}",
         actor=actor, bot=False, payload={"Ref": r.ref, "note": body.note if body else None})
    db.add(AuditEvent(request_id=r.id, actor=actor, action="retried", note=body.note if body else None))
    db.commit()
    # Retry must actually re-drive the runner: in claude mode nothing else ever
    # picks an 'approved' request back up (the simulator stands down) — without
    # this, Retry silently dead-ends and the request is stranded forever (ADR 0013)
    if runner_mode() == "claude" and r.stage in PIPELINE_STAGES:
        pipeline().start(r.id)
    return to_out(r, RequestDetail)
