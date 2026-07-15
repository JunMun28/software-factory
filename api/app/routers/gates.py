"""Gate and recovery-action endpoints (ADR 0007, ADR 0006, ADR 0013).

Routes:
  POST /api/requests/{rid}/approve    — approve spec or merge gate
  POST /api/requests/{rid}/send-back  — send spec back to submitter
  POST /api/requests/{rid}/respond    — submitter reply after send-back
  POST /api/requests/{rid}/cancel     — cancel a request
  POST /api/requests/{rid}/retry      — retry a stranded pipeline stage
  POST /api/requests/{rid}/take-over  — stop automation for human completion
  POST /api/requests/{rid}/send-back-to-stage — redo an earlier runner stage

Every state change goes through transitions.apply() (the one CAS + audit +
event seam); losses resolve through api_helpers.conflict_response. These are
HUMAN-initiated transitions: no epoch fence — valid from any replica.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import simulator, transitions
from ..agent_exec import runner_mode
from ..api_helpers import conflict_response, get_request, pipeline, prospective_repo, to_out
from ..db import get_db
from ..models import PIPELINE_STAGES, AuditEvent, SpecLine
from ..schemas import Note, OperatorNote, RequestDetail, SendBackToStageIn
from ..transitions import Actor
from .operators import resolve_operator

router = APIRouter()


def _operator_actor(db: Session, operator_id: int) -> Actor:
    return Actor(name=resolve_operator(db, operator_id).name, operator_id=operator_id)


@router.post("/api/requests/{rid}/approve", response_model=RequestDetail)
def approve(rid: int, body: OperatorNote, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    actor = _operator_actor(db, body.operator_id)
    # A consumed merge gate has gate=None; stage/status retain enough context
    # to route a replay back to the merge action family.
    if r.gate == transitions.GATE_APPROVE_MERGE or r.stage in ("review", "done"):
        res = transitions.apply(db, r, "claim_merge", actor=actor)
        if isinstance(res, transitions.Loss):
            return conflict_response(r, res)
        # apply() flushed the merge_claimed audit: AgentRunner may commit internally
        # after the git merge, and that commit must include the winner's identity.
        if runner_mode() in ("agent", "kube"):
            pipeline().approve_merge(db, r, actor.name)
        else:
            simulator.approve_merge(db, r, actor.name)
        outcome = ("approved_merge" if r.status == transitions.DONE  # the merge can escalate instead
                   else "merge_approval_failed")
        db.add(AuditEvent(request_id=r.id, operator_id=body.operator_id,
                          actor=actor.name, action=outcome))
        db.commit()
        return to_out(r, RequestDetail)
    repo = r.app.repo if r.app else prospective_repo(r)
    res = transitions.apply(db, r, "approve_spec", actor=actor, params={"repo": repo})
    if isinstance(res, transitions.Loss):
        return conflict_response(r, res)
    # Approve's side-effect ledger (PRD hardening #3): the flags land atomically
    # with the claim + audit + gate event in the caller's ONE transaction (D2);
    # the flags themselves keep a replayed approve from double-firing.
    r.repo_ready = True
    r.spec_pr_open = True
    db.commit()
    if runner_mode() == "agent":
        pipeline().start(r.id)  # Stage 2 fires for real: the agent CLI in the Subject workspace
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/send-back", response_model=RequestDetail)
def send_back(rid: int, body: OperatorNote, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    actor = _operator_actor(db, body.operator_id)
    res = transitions.apply(db, r, "send_back", actor=actor, params={"note": body.note})
    if isinstance(res, transitions.Loss):
        return conflict_response(r, res)
    db.commit()
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/respond", response_model=RequestDetail)
def respond(rid: int, body: Note, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    actor = Actor(name=body.actor or r.reporter)
    res = transitions.apply(db, r, "respond", actor=actor, params={"note": body.note})
    if isinstance(res, transitions.Loss):
        raise HTTPException(409, "Nothing to respond to")
    if r.send_back_question:
        db.add(SpecLine(request=r, order=len(r.spec_lines),
                        text=body.note.strip().rstrip(".") + ".",
                        prov=f"reply {r.send_back_rounds}"))
    db.commit()
    res.notify()
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/cancel", response_model=RequestDetail)
def cancel(rid: int, body: OperatorNote, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    actor = _operator_actor(db, body.operator_id)
    res = transitions.apply(db, r, "cancel", actor=actor, params={"note": body.note})
    if isinstance(res, transitions.Loss):
        return conflict_response(r, res)
    db.commit()
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/retry", response_model=RequestDetail)
def retry(rid: int, body: OperatorNote, db: Session = Depends(get_db)):
    """Recovery action: re-run the stuck Stage fresh (CONTEXT.md: Retry)."""
    r = get_request(db, rid)
    actor = _operator_actor(db, body.operator_id)
    retry_transition = "retry_spec" if r.stage == "spec" else "retry_pipeline"
    res = transitions.apply(db, r, retry_transition, actor=actor,
                            params={"note": body.note})
    if isinstance(res, transitions.Loss):
        return conflict_response(r, res)
    db.commit()
    # Retry must actually re-drive the runner: in agent mode nothing else ever
    # picks an 'approved' request back up (the simulator stands down) — without
    # this, Retry silently dead-ends and the request is stranded forever (ADR 0013)
    if runner_mode() == "agent" and r.stage in PIPELINE_STAGES:
        pipeline().start(r.id)
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/take-over", response_model=RequestDetail)
def take_over(rid: int, body: OperatorNote, db: Session = Depends(get_db)):
    """Recovery action: stop runner work so a named operator can finish in the PR."""
    r = get_request(db, rid)
    actor = _operator_actor(db, body.operator_id)
    res = transitions.apply(db, r, "take_over", actor=actor, params={"note": body.note})
    if isinstance(res, transitions.Loss):
        return conflict_response(r, res)
    db.commit()
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/send-back-to-stage", response_model=RequestDetail)
def send_back_to_stage(rid: int, body: SendBackToStageIn, db: Session = Depends(get_db)):
    """Recovery action: discard later runner work and re-enter an earlier Stage."""
    r = get_request(db, rid)
    actor = _operator_actor(db, body.operator_id)
    # A replay sees the already-rewound stage, so resolve the consumed recovery
    # precondition before validating the original target against current state.
    if not r.needs_human:
        return conflict_response(r, transitions.resolve_loss(db, r, "send_back_to_stage", actor))
    if body.stage not in PIPELINE_STAGES or r.stage not in PIPELINE_STAGES:
        raise HTTPException(400, "Target must be an earlier pipeline stage")
    if PIPELINE_STAGES.index(body.stage) >= PIPELINE_STAGES.index(r.stage):
        raise HTTPException(400, "Target stage must be strictly earlier than the current stage")
    res = transitions.apply(db, r, "send_back_to_stage", actor=actor,
                            params={"stage": body.stage, "reason": body.reason})
    if isinstance(res, transitions.Loss):
        return conflict_response(r, res)
    db.commit()
    if runner_mode() == "agent" and r.stage in PIPELINE_STAGES:
        pipeline().start(r.id)
    return to_out(r, RequestDetail)
