"""Gate and recovery-action endpoints (ADR 0007, ADR 0006, ADR 0013).

Routes:
  POST /api/requests/{rid}/approve    — approve spec or merge gate
  POST /api/requests/{rid}/send-back  — send spec back to submitter
  POST /api/requests/{rid}/respond    — submitter reply after send-back
  POST /api/requests/{rid}/cancel     — cancel a request
  POST /api/requests/{rid}/retry      — retry a stranded pipeline stage
"""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .. import simulator
from ..agent_exec import runner_mode
from ..api_helpers import get_request, pipeline, prospective_repo, to_out
from ..db import get_db
from ..events import emit
from ..models import PIPELINE_STAGES, AuditEvent, Request, SpecLine, utcnow
from ..schemas import ConflictOut, Note, OperatorNote, RequestDetail
from .operators import resolve_operator

router = APIRouter()

DECISIVE_ACTIONS = (
    "approved",
    "merge_claimed",
    "approved_merge",
    "merge_approval_failed",
    "sent_back",
    "retried",
    "cancelled",
)


def _resolve_cas_loss(
    db: Session,
    r: Request,
    operator_id: int,
    actor: str,
    replay_actions: tuple[str, ...],
    fallback_detail: str,
) -> RequestDetail | JSONResponse:
    """Resolve a consumed precondition against its persisted winning action."""
    db.rollback()
    db.refresh(r)
    winner = db.scalar(
        select(AuditEvent)
        .where(AuditEvent.request_id == r.id, AuditEvent.action.in_(DECISIVE_ACTIONS))
        .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
        .limit(1)
    )
    if winner is None:
        raise HTTPException(409, fallback_detail)
    # New decisive actions carry the stable operator pointer. Actor fallback
    # preserves ADR 0006 replay for pre-migration audit rows.
    same_operator = winner.operator_id == operator_id or (
        winner.operator_id is None and winner.actor == actor
    )
    if same_operator and winner.action in replay_actions:
        return to_out(r, RequestDetail)
    state = r.gate or r.status
    conflict = ConflictOut(
        detail=f"Already acted on by {winner.actor}",
        acted_by=winner.actor,
        acted_at=winner.created_at,
        resulting_state=state,
    )
    return JSONResponse(status_code=409, content=conflict.model_dump(mode="json"))


@router.post("/api/requests/{rid}/approve", response_model=RequestDetail)
def approve(rid: int, body: OperatorNote, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    actor = resolve_operator(db, body.operator_id).name
    # A consumed merge gate has gate=None; stage/status retain enough context
    # to route a replay back to the merge action family.
    if r.gate == "approve_merge" or r.stage in ("review", "done"):
        claimed = db.execute(
            update(Request)
            .where(Request.id == r.id, Request.gate == "approve_merge", Request.status == "approved")
            .values(gate=None)
        ).rowcount
        if not claimed:
            return _resolve_cas_loss(
                db,
                r,
                body.operator_id,
                actor,
                ("merge_claimed", "approved_merge", "merge_approval_failed"),
                f"Cannot merge a {r.status} request",
            )
        db.refresh(r)
        # Flush the winner identity before entering the runner. AgentRunner may
        # commit internally after the git merge; that commit must include a
        # decisive audit so a waiting loser never observes a claim without its actor.
        db.add(AuditEvent(
            request_id=r.id,
            operator_id=body.operator_id,
            actor=actor,
            action="merge_claimed",
        ))
        db.flush()
        if runner_mode() == "agent":
            pipeline().approve_merge(db, r, actor)
        else:
            simulator.approve_merge(db, r, actor)
        if r.status == "done":  # the merge can escalate instead (honest deploy)
            db.add(AuditEvent(
                request_id=r.id, operator_id=body.operator_id, actor=actor, action="approved_merge"
            ))
        else:
            db.add(AuditEvent(
                request_id=r.id,
                operator_id=body.operator_id,
                actor=actor,
                action="merge_approval_failed",
            ))
        db.commit()
        return to_out(r, RequestDetail)
    # atomic claim: of two concurrent approves, exactly one wins this UPDATE —
    # the loser resolves against the persisted winning action
    claimed = db.execute(
        update(Request)
        .where(
            Request.id == r.id,
            Request.status == "pending_approval",
            Request.gate == "approve_spec",
        )
        .values(status="approved", gate=None, stage="architecture", sim_step=0,
                stage2_fired=True, stage_entered_at=utcnow())
    ).rowcount
    if not claimed:
        return _resolve_cas_loss(
            db,
            r,
            body.operator_id,
            actor,
            ("approved",),
            f"Cannot approve from status '{r.status}'",
        )
    db.refresh(r)
    # ordered, individually-persisted side-effect ledger (PRD hardening #3),
    # reached only by the CAS winner. Persist the decisive audit with the claim's
    # first ledger commit so a waiting loser can always identify the winner.
    db.add(AuditEvent(request_id=r.id, operator_id=body.operator_id, actor=actor, action="approved",
                      note="approved the spec — repo created, SPEC.md PR opened, Stage 2 fired"))
    if not r.repo_ready:
        r.repo_ready = True
        db.commit()
    if not r.spec_pr_open:
        r.spec_pr_open = True
        db.commit()
    repo = r.app.repo if r.app else prospective_repo(r)
    emit(db, r, "gate_event", f"Spec approved by {actor} — repo ready, SPEC.md PR open, Stage 2 started",
         actor=actor, bot=False, broadcast=True,
         payload={"gate": "approve_spec", "repo": repo, "Ref": r.ref})
    db.commit()
    if runner_mode() == "agent":
        pipeline().start(r.id)  # Stage 2 fires for real: the agent CLI in the Subject workspace
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/send-back", response_model=RequestDetail)
def send_back(rid: int, body: OperatorNote, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    actor = resolve_operator(db, body.operator_id).name
    claimed = db.execute(
        update(Request)
        .where(Request.id == r.id, Request.status.in_(("pending_approval", "submitted")))
        .values(
            status="sent_back",
            gate=None,
            needs_human=False,
            needs_human_reason=None,
            send_back_question=body.note or "Could you add a bit more detail?",
            send_back_rounds=Request.send_back_rounds + 1,
            stage_entered_at=utcnow(),
        )
    ).rowcount
    if not claimed:
        return _resolve_cas_loss(
            db,
            r,
            body.operator_id,
            actor,
            ("sent_back",),
            f"Cannot send back from status '{r.status}'",
        )
    db.refresh(r)
    emit(db, r, "gate_event", "Sent back to the submitter — one question is blocking the spec",
         actor=actor, bot=False, broadcast=True, payload={"gate": "send_back", "Ref": r.ref})
    db.add(AuditEvent(
        request_id=r.id,
        operator_id=body.operator_id,
        actor=actor,
        action="sent_back",
        note=body.note,
    ))
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
def cancel(rid: int, body: OperatorNote, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    actor = resolve_operator(db, body.operator_id).name
    claimed = db.execute(
        update(Request)
        .where(Request.id == r.id, Request.status.not_in(("done", "cancelled")))
        .values(status="cancelled", gate=None, needs_human=False, needs_human_reason=None)
    ).rowcount
    if not claimed:
        return _resolve_cas_loss(
            db,
            r,
            body.operator_id,
            actor,
            ("cancelled",),
            f"Cannot cancel a {r.status} request",
        )
    db.refresh(r)
    emit(db, r, "recovery_action", f"Request cancelled by {actor}",
         actor=actor, bot=False, payload={"Ref": r.ref})
    db.add(AuditEvent(
        request_id=r.id,
        operator_id=body.operator_id,
        actor=actor,
        action="cancelled",
        note=body.note,
    ))
    db.commit()
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/retry", response_model=RequestDetail)
def retry(rid: int, body: OperatorNote, db: Session = Depends(get_db)):
    """Recovery action: re-run the stuck Stage fresh (CONTEXT.md: Retry)."""
    r = get_request(db, rid)
    actor = resolve_operator(db, body.operator_id).name
    retry_status = "pending_approval" if r.stage == "spec" else "approved"
    retry_gate = "approve_spec" if r.stage == "spec" else r.gate
    claimed = db.execute(
        update(Request)
        .where(Request.id == r.id, Request.needs_human.is_(True))
        .values(
            needs_human=False,
            needs_human_reason=None,
            status=retry_status,
            gate=retry_gate,
            sim_step=0,
            stage_entered_at=utcnow(),
        )
    ).rowcount
    if not claimed:
        return _resolve_cas_loss(
            db, r, body.operator_id, actor, ("retried",), "Request is not escalated"
        )
    db.refresh(r)
    emit(db, r, "recovery_action", f"Retry — Stage re-run requested by {actor}",
         actor=actor, bot=False, payload={"Ref": r.ref, "note": body.note})
    db.add(AuditEvent(
        request_id=r.id,
        operator_id=body.operator_id,
        actor=actor,
        action="retried",
        note=body.note,
    ))
    db.commit()
    # Retry must actually re-drive the runner: in agent mode nothing else ever
    # picks an 'approved' request back up (the simulator stands down) — without
    # this, Retry silently dead-ends and the request is stranded forever (ADR 0013)
    if runner_mode() == "agent" and r.stage in PIPELINE_STAGES:
        pipeline().start(r.id)
    return to_out(r, RequestDetail)
