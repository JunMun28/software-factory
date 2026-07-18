"""Gate and recovery-action endpoints (ADR 0007, ADR 0006, ADR 0013).

Routes:
  POST /api/requests/{rid}/approve     — approve spec, architecture, merge, or deploy gate
  POST /api/requests/{rid}/reject-gate — structured human NO at architecture/merge/deploy
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
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import acceptance, settings, simulator, transitions
from ..agent_exec import runner_mode
from ..api_helpers import conflict_response, get_request, pipeline, prospective_repo, to_out
from ..auth import current_identity
from ..db import get_db
from ..events import emit
from ..models import (
    PIPELINE_STAGES,
    AuditEvent,
    PreviewFeedback,
    ProgressEvent,
    SpecLine,
    SpecSnapshot,
    StageJob,
)
from ..schemas import (
    AcceptanceItem,
    AcceptanceOut,
    Note,
    OperatorNote,
    PreviewAcceptIn,
    PreviewChangesIn,
    PreviewFeedbackOut,
    PreviewStatusOut,
    RejectGateIn,
    RequestDetail,
    SendBackToStageIn,
)
from ..transitions import Actor
from .operators import require_approver

router = APIRouter()


def _operator_actor(db: Session, operator_id: int) -> Actor:
    # Every caller of this helper mutates lifecycle state — viewer roles stop here.
    operator = require_approver(db, operator_id)
    # operator.id, not the raw param: with FACTORY_AUTH=entra the token identity
    # overrides the body value, and the audit trail must record who really acted.
    return Actor(name=operator.name, operator_id=operator.id)


def _has_architecture_decision(db: Session, request_id: int) -> bool:
    return db.scalar(
        select(AuditEvent.id)
        .where(
            AuditEvent.request_id == request_id,
            AuditEvent.action.in_(
                ("approved_architecture", "rejected_architecture")
            ),
        )
        .limit(1)
    ) is not None


@router.get("/api/requests/{rid}/acceptance", response_model=AcceptanceOut)
def acceptance_contract(rid: int, db: Session = Depends(get_db)):
    request = get_request(db, rid)
    criteria = acceptance.active(db, request)
    snapshot = db.scalar(
        select(SpecSnapshot)
        .where(SpecSnapshot.request_id == request.id)
        .order_by(SpecSnapshot.version.desc())
    )
    coverage_events = db.scalars(
        select(ProgressEvent)
        .where(
            ProgressEvent.request_id == request.id,
            ProgressEvent.kind == "acceptance_coverage",
        )
        .order_by(ProgressEvent.id.desc())
    ).all()
    latest = next(
        (
            event
            for event in coverage_events
            if snapshot is not None
            and (event.payload or {}).get("version") == snapshot.version
        ),
        None,
    )
    return AcceptanceOut(
        version=snapshot.version if snapshot else 0,
        content_hash=snapshot.content_hash if snapshot else None,
        criteria=[
            AcceptanceItem(
                code=item.code,
                text=item.text,
                prov=item.prov,
                assume=item.assume,
            )
            for item in criteria
        ],
        coverage=latest.payload if latest else None,
    )


@router.get("/api/requests/{rid}/preview", response_model=PreviewStatusOut)
def preview_status(rid: int, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    rows = db.scalars(
        select(StageJob)
        .where(
            StageJob.request_id == r.id,
            StageJob.role.in_(("pbuild", "pdeploy")),
        )
        .order_by(StageJob.id)
    ).all()
    pbuild = next((row for row in reversed(rows) if row.role == "pbuild"), None)
    pdeploy = next((row for row in reversed(rows) if row.role == "pdeploy"), None)
    newest = db.scalar(
        select(AuditEvent)
        .where(
            AuditEvent.request_id == r.id,
            AuditEvent.action.in_(transitions.DECISIVE_ACTIONS),
        )
        .order_by(AuditEvent.id.desc())
    )
    if r.gate == transitions.GATE_ACCEPT_PREVIEW:
        state = "ready"
    elif newest is not None and newest.action == "preview_accepted":
        state = "accepted"
    elif pdeploy is not None and pdeploy.status == "running":
        state = "deploying"
    elif pbuild is not None and pbuild.status == "running":
        state = "building"
    else:
        state = "none"
    live = pdeploy is not None and pdeploy.status in ("running", "succeeded")
    envelope = (pdeploy.envelope if pdeploy else None) or (
        pbuild.envelope if pbuild else None
    ) or {}
    feedback = db.scalars(
        select(PreviewFeedback)
        .where(PreviewFeedback.request_id == r.id)
        .order_by(PreviewFeedback.round, PreviewFeedback.order, PreviewFeedback.id)
    ).all()
    slug = r.app.key if r.app else r.ref.lower()
    return PreviewStatusOut(
        round=r.preview_round + 1,
        url=(f"http://{slug}-preview.{settings.APP_INGRESS_DOMAIN}" if live else None),
        gate=r.gate if r.gate == transitions.GATE_ACCEPT_PREVIEW else None,
        sha=envelope.get("sha"),
        digest=envelope.get("digest"),
        state=state,
        feedback=[PreviewFeedbackOut.model_validate(item) for item in feedback],
    )


@router.post("/api/requests/{rid}/preview/accept", response_model=RequestDetail)
def accept_preview(rid: int, body: PreviewAcceptIn, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    actor = (
        _operator_actor(db, body.operator_id)
        if body.operator_id is not None
        else Actor(name=body.actor or r.reporter)
    )
    claimed = transitions.apply(db, r, "claim_accept", actor=actor)
    if isinstance(claimed, transitions.Loss):
        return conflict_response(r, claimed)
    raised = transitions.apply(db, r, "raise_merge_gate", actor=actor)
    if isinstance(raised, transitions.Loss):
        return conflict_response(r, raised)
    db.commit()
    raised.notify()
    return to_out(r, RequestDetail)


@router.post(
    "/api/requests/{rid}/preview/request-changes", response_model=RequestDetail
)
def request_preview_changes(
    rid: int, body: PreviewChangesIn, db: Session = Depends(get_db)
):
    r = get_request(db, rid)
    actor = (
        _operator_actor(db, body.operator_id)
        if body.operator_id is not None
        else Actor(name=body.actor or r.reporter)
    )
    at_cap = r.preview_round >= settings.PREVIEW_MAX_ROUNDS
    changed = transitions.apply(db, r, "request_changes", actor=actor)
    if isinstance(changed, transitions.Loss):
        return conflict_response(r, changed)
    new_round = r.preview_round
    db.add(
        PreviewFeedback(
            request_id=r.id,
            round=new_round,
            order=0,
            body=body.feedback,
            page_path=body.page_path,
            attachment_id=body.attachment_id,
            author=actor.name,
        )
    )
    db.add(
        SpecLine(
            request=r,
            order=len(r.spec_lines),
            text=body.feedback.strip().rstrip(".") + ".",
            prov=f"preview {new_round}",
        )
    )
    emit(
        db,
        r,
        "comment",
        body.feedback.splitlines()[0][:120],
        actor=actor.name,
        bot=False,
        payload={"round": new_round, "items": 1},
    )
    if at_cap:
        escalated = transitions.apply(
            db,
            r,
            "escalate",
            actor=actor,
            params={
                "reason": "Preview feedback rounds exhausted after "
                f"{settings.PREVIEW_MAX_ROUNDS} — operator decision needed"
            },
        )
        if isinstance(escalated, transitions.Loss):
            return conflict_response(r, escalated)
    acceptance.derive_and_snapshot(db, r)
    db.commit()
    changed.notify()
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/approve", response_model=RequestDetail)
def approve(rid: int, body: OperatorNote, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    actor = _operator_actor(db, body.operator_id)
    if r.gate == transitions.GATE_APPROVE_ARCHITECTURE or (
        r.gate is None
        and r.stage == "architecture"
        and _has_architecture_decision(db, r.id)
    ):
        res = transitions.apply(
            db,
            r,
            "approve_architecture",
            actor=actor,
            params={"note": body.note},
        )
        if isinstance(res, transitions.Loss):
            return conflict_response(r, res)
        db.commit()
        return to_out(r, RequestDetail)
    # B4: the deploy gate (spec §4.10). A live gate, OR a consumed gate whose
    # request still sits at stage=deploy (a replay while the build runs), is
    # the deploy family. stage=="deploy" only arises post-merge, so it never
    # collides with the merge/spec routing. A deploy replay that lands after
    # "done" falls through to the merge family and resolves as a clean 409.
    if r.gate == transitions.GATE_APPROVE_DEPLOY or (r.gate is None and r.stage == "deploy"):
        res = transitions.apply(db, r, "claim_deploy", actor=actor)
        if isinstance(res, transitions.Loss):
            return conflict_response(r, res)
        # release to the driver + record the approver in ONE transaction; the
        # begin_deploy milestone names the approver (spec §4.10 identity). A
        # cancel racing between claim and release makes begin_deploy Lose —
        # record the honest outcome, never "approved" on a closed request.
        released = transitions.apply(db, r, "begin_deploy", actor=actor, params={})
        outcome = ("approved_deploy" if isinstance(released, transitions.Win)
                   else "deploy_approval_failed")
        # the approver's note is evidence — keep it (it was dropped before)
        db.add(AuditEvent(request_id=r.id, operator_id=body.operator_id,
                          actor=actor.name, action=outcome,
                          note=body.note or None))
        db.commit()
        return to_out(r, RequestDetail)

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
        outcome = "merge_approval_failed" if r.needs_human else "approved_merge"
        db.add(AuditEvent(request_id=r.id, operator_id=body.operator_id,
                          actor=actor.name, action=outcome,
                          note=body.note or None))
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
    acceptance.derive_and_snapshot(db, r)
    db.commit()
    if runner_mode() == "agent":
        pipeline().start(r.id)  # Stage 2 fires for real: the agent CLI in the Subject workspace
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/reject-gate", response_model=RequestDetail)
def reject_gate(rid: int, body: RejectGateIn, db: Session = Depends(get_db)):
    """A human's structured gate rejection with required free-text evidence.

    Architecture rejection immediately queues an agent refinement. Merge and
    deploy rejection retain their existing needs-human recovery behavior.
    """
    r = get_request(db, rid)
    actor = _operator_actor(db, body.operator_id)
    if r.gate == transitions.GATE_APPROVE_ARCHITECTURE:
        name = "reject_architecture_gate"
        params = {"reason": body.reason, "reason_code": body.reason_code}
    elif r.gate == transitions.GATE_APPROVE_DEPLOY:
        name, label, gate = "reject_deploy_gate", "deploy", transitions.GATE_APPROVE_DEPLOY
        params = {
            "reason_code": body.reason_code,
            "reason": body.reason,
            "label": label,
            "gate": gate,
        }
    elif r.gate == transitions.GATE_APPROVE_MERGE:
        name, label, gate = "reject_merge_gate", "merge", transitions.GATE_APPROVE_MERGE
        params = {
            "reason_code": body.reason_code,
            "reason": body.reason,
            "label": label,
            "gate": gate,
        }
    else:
        # no live gate: resolve the consumed precondition against the decisive
        # winner (same family routing as approve — deploy context first)
        if r.stage == "architecture" and _has_architecture_decision(db, r.id):
            name = "reject_architecture_gate"
        else:
            name = "reject_deploy_gate" if r.stage == "deploy" else "reject_merge_gate"
        return conflict_response(r, transitions.resolve_loss(db, r, name, actor))
    res = transitions.apply(db, r, name, actor=actor, params=params)
    if isinstance(res, transitions.Loss):
        return conflict_response(r, res)
    db.commit()
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
    # SEC-01: authenticated caller's name wins over the client-sent actor.
    identity = current_identity()
    actor = Actor(name=identity["name"] if identity else (body.actor or r.reporter))
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
