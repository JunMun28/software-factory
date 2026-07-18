"""Request lifecycle transitions: one declarative table + apply() (spec 2026-07-14 C1, D2-D5).

Every legal move of a Request's composite lifecycle state (status, stage, gate,
needs_human) is a named row in TABLE. apply() executes a row as ONE compare-and-swap
UPDATE whose WHERE carries the row's full composite-state precondition — generalizing
the cas_status pattern below — then, still uncommitted, appends the winner's
AuditEvent, the row's progress events, and an optional intent row. The CALLER owns
the transaction: commit on Win; a Loss has already rolled back. Sessions run
expire_on_commit=False, so apply() refreshes ``req`` after a win — callers read
fresh columns immediately. apply() flushes all pending session state before the CAS;
staged sibling writes survive a Win, while a Loss rolls them back. Callers must not
stage a write to a precondition column of the transition they are about to apply.
Callers that know the origin stage pass it through ``expected_stage``; ``params``
are transition effects/event data only and never add hidden CAS preconditions.

Fencing policy (leadership, spec §3.2):
- HUMAN-initiated transitions (HTTP endpoints) pass ``epoch=None``. They are raced
  against other humans by the composite-state precondition alone and are valid from
  ANY replica — a standby must not reject an operator's Cancel just because it is
  not the leader (its ``get_elector().epoch`` is 0/stale there).
- MACHINE-initiated transitions (tick loop, pipeline threads, startup rescue) pass
  ``epoch=get_elector().epoch``. The EXISTS guard on ``leader_epochs`` fences out a
  deposed leader's in-flight threads: after a new leader bumps the epoch, every
  fenced write from the old process quietly loses.

Post-commit side effects: a Win carries the row's notification as ``Win.notify()``;
call it AFTER ``db.commit()`` so an email can never announce state that rolled back.
"""
from dataclasses import dataclass, field
from typing import Callable

from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from . import intents, notifications
from .events import emit
from .models import (
    AuditEvent,
    Intent,
    LeaderEpoch,
    PreviewFeedback,
    ProgressEvent,
    Request,
    utcnow,
)

# ---------- lifecycle vocabulary (D5: the constants that kill the magic strings) ----------

DRAFT = "draft"
SUBMITTED = "submitted"
PENDING_APPROVAL = "pending_approval"
SENT_BACK = "sent_back"
APPROVED = "approved"
HUMAN_OWNED = "human_owned"
DONE = "done"
CANCELLED = "cancelled"

CLOSED = (DONE, CANCELLED)
PRE_APPROVAL = (DRAFT, SUBMITTED, PENDING_APPROVAL, SENT_BACK)

GATE_APPROVE_SPEC = "approve_spec"
GATE_APPROVE_ARCHITECTURE = "approve_architecture"
GATE_APPROVE_MERGE = "approve_merge"
GATE_APPROVE_DEPLOY = "approve_deploy"  # B4: the second human gate (spec §4.10)
GATE_ACCEPT_PREVIEW = "accept_preview"

# Typed categories for a human's gate reject (self-harness analysis 2026-07-16):
# the small fixed vocabulary that makes rejects bucketable instead of free-text
# noise. schemas.RejectGateIn mirrors this — test_reject_gate pins the parity.
GATE_REJECT_CODES = (
    "wrong_behavior",
    "spec_mismatch",
    "quality",
    "tests_inadequate",
    "security",
    "other",
)

# The audit actions a Loss resolves against (ADR 0006): the newest of these rows
# identifies the winner of a consumed precondition.
DECISIVE_ACTIONS = (
    "approved",
    "approved_architecture",
    "rejected_architecture",
    "merge_claimed",
    "approved_merge",
    "merge_approval_failed",
    "deploy_claimed",
    "approved_deploy",
    "deploy_approval_failed",
    "preview_accepted",
    "changes_requested",
    "rejected_merge",
    "rejected_deploy",
    "sent_back",
    "retried",
    "taken_over",
    "sent_back_to_stage",
    "cancelled",
)


@dataclass(frozen=True)
class Actor:
    """Who applies a transition. operator_id=None for submitters and the Factory."""
    name: str
    operator_id: int | None = None


FACTORY = Actor(name="Factory")


@dataclass(frozen=True)
class IntentSpec:
    """An intent row (spec §3.3) to open in the SAME transaction as the transition."""
    key: str
    kind: str
    payload: dict


# ---------- the table ----------

ANY = object()  # Pre.gate sentinel: "don't care" (None means "must be NULL")


@dataclass(frozen=True)
class Pre:
    """Composite-state precondition — compiled into the CAS UPDATE's WHERE."""
    status_in: tuple[str, ...] | None = None
    status_not_in: tuple[str, ...] | None = None
    gate: object = ANY
    needs_human: bool | None = None
    app_id: object = ANY


@dataclass(frozen=True)
class Transition:
    """One named, table-declared move of a Request's lifecycle state (CONTEXT.md)."""
    name: str
    pre: Pre
    effects: Callable[[dict], dict]                                # params -> UPDATE .values()
    events: Callable[[Session, Request, Actor, dict], None] | None = None
    audit_action: str | None = None
    audit_note: Callable[[dict], str | None] | None = None
    notify: Callable[[Session, Request], None] | None = None       # fired AFTER commit (Win.notify)
    replay_actions: tuple[str, ...] = ()
    conflict_detail: Callable[[Request], str] = field(default=lambda r: "Precondition consumed")


@dataclass(frozen=True)
class Win:
    transition: str
    intent: Intent | None = None
    _notify: Callable[[], None] | None = None

    def notify(self) -> None:
        """The row's post-commit notification. Call after db.commit(); no-op otherwise."""
        if self._notify:
            self._notify()


@dataclass(frozen=True)
class Loss:
    transition: str
    replay: bool
    winner: AuditEvent | None
    resulting_state: str
    detail: str


# ---------- event appenders (exact text preserved from the pre-refactor call sites) ----------

def _ev_raise_spec_gate(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "gate_event", "Draft spec generated — 1 open question before it can be approved",
         broadcast=True,
         payload={"gate": GATE_APPROVE_SPEC,
                  "fields": {"Status": "Awaiting approval", "Assumptions": "1", "Ref": req.ref}})


def _ev_approve_spec(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "gate_event",
         f"Spec approved by {actor.name} — repo ready, SPEC.md PR open, Stage 2 started",
         actor=actor.name, bot=False, broadcast=True,
         payload={"gate": GATE_APPROVE_SPEC, "repo": params["repo"], "Ref": req.ref})


def newest_decisive(db: Session, req: Request) -> AuditEvent | None:
    """The most recent gate-family decision for this request (DECISIVE_ACTIONS,
    ADR 0006) — how both runners read back which way a consumed gate went."""
    return db.scalar(
        select(AuditEvent)
        .where(
            AuditEvent.request_id == req.id,
            AuditEvent.action.in_(DECISIVE_ACTIONS),
        )
        .order_by(AuditEvent.id.desc())
    )


def _ev_raise_architecture_gate(
    db: Session, req: Request, actor: Actor, params: dict
) -> None:
    plan = db.scalar(
        select(ProgressEvent)
        .where(
            ProgressEvent.request_id == req.id,
            ProgressEvent.kind == "architecture_plan",
        )
        .order_by(ProgressEvent.id.desc())
    )
    evidence = dict(plan.payload or {}) if plan is not None else {}
    emit(
        db,
        req,
        "gate_event",
        "Waiting at the architecture gate — spec and architecture plan need approval",
        broadcast=True,
        payload={
            **evidence,
            "gate": GATE_APPROVE_ARCHITECTURE,
            "Ref": req.ref,
            "plan_event_id": plan.id if plan is not None else None,
        },
    )


def _ev_reject_architecture_gate(
    db: Session, req: Request, actor: Actor, params: dict
) -> None:
    emit(
        db,
        req,
        "gate_event",
        f"Architecture rejected by {actor.name} — refining the plan",
        body=params["reason"],
        actor=actor.name,
        bot=False,
        broadcast=True,
        payload={
            "gate": GATE_APPROVE_ARCHITECTURE,
            "Ref": req.ref,
            "reason": params["reason"][:2000],
            "reason_code": params.get("reason_code"),
        },
    )


def _ev_raise_deploy_gate(db: Session, req: Request, actor: Actor, params: dict) -> None:
    preview = {
        key: params[key]
        for key in (
            "preview_url",
            "preview_round",
            "accepted_by",
            "preview_digest",
            "pr_url",
        )
        if params.get(key) is not None
    }
    emit(db, req, "gate_event",
         "Waiting at the deploy gate — merged to main, deploy needs approval",
         broadcast=True,
         payload={"gate": GATE_APPROVE_DEPLOY, "Ref": req.ref,
                  "sha": params.get("sha"), **preview})


def _ev_begin_deploy(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "milestone_summary",
         f"Deploy approved by {actor.name} — building and deploying the app",
         stage="deploy",
         payload={"Stage": "Deploy", "Ref": req.ref, "sha": params.get("sha")})


def _ev_finish_done(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "gate_event", f"Merge approved by {actor.name} — {params['merge_note']}",
         actor=actor.name, bot=False, broadcast=True,
         payload={"gate": GATE_APPROVE_MERGE, "Ref": req.ref, **(params.get("payload_extra") or {})})
    emit(db, req, "milestone_summary", params["deploy_title"],
         stage="done", payload={"Stage": "Done", "Ref": req.ref})


def _ev_send_back(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "gate_event", "Sent back to the submitter — one question is blocking the spec",
         actor=actor.name, bot=False, broadcast=True, payload={"gate": "send_back", "Ref": req.ref})


def _ev_respond(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "milestone_summary", "Submitter replied — back in the approval queue",
         actor=actor.name, bot=False, payload={"Ref": req.ref})


def _ev_cancel(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "recovery_action", f"Request cancelled by {actor.name}",
         actor=actor.name, bot=False, payload={"Ref": req.ref})


def _ev_retry(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "recovery_action", f"Retry — Stage re-run requested by {actor.name}",
         actor=actor.name, bot=False, payload={"Ref": req.ref, "note": params.get("note")})


def _ev_take_over(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "recovery_action", f"Taken over by {actor.name} — finishing by hand",
         actor=actor.name, bot=False, payload={"Ref": req.ref, "note": params.get("note")})


def _ev_send_back_to_stage(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "recovery_action", f"Sent back to {params['stage'].capitalize()} by {actor.name}",
         body=params.get("reason"), actor=actor.name, bot=False,
         payload={"Ref": req.ref, "target_stage": params["stage"], "reason": params.get("reason")})


def _reject_gate_effects(p: dict) -> dict:
    """A human's structured NO at a gate: consume the gate, escalate with the
    typed reason, and — for the MERGE gate — stage the feedback for the next
    agent attempt. A deploy reject stages nothing: the work is already merged,
    so no agent attempt can ever consume it (send-back is pre-merge only);
    the reason still lives in the audit + gate_event evidence."""
    effects = {
        "gate": None,
        "needs_human": True,
        "needs_human_reason":
            f"{p['label'].capitalize()} gate rejected ({p['reason_code']}): {p['reason']}"[:300],
    }
    if p["label"] == "merge":
        effects["pending_feedback"] = (
            f"A human rejected the {p['label']} gate (category: {p['reason_code']}). "
            f"Their feedback:\n{p['reason']}"
        )
    return effects


def _ev_reject_gate(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "gate_event",
         f"{params['label'].capitalize()} rejected by {actor.name} — needs rework ({params['reason_code']})",
         body=params.get("reason"), actor=actor.name, bot=False, broadcast=True,
         payload={"gate": params["gate"], "Ref": req.ref,
                  "reason_code": params["reason_code"],
                  "reason": (params.get("reason") or "")[:2000]})


def _ev_escalate(db: Session, req: Request, actor: Actor, params: dict) -> None:
    reason = params["reason"]
    emit(db, req, "escalation", f"Escalated — needs a human ({reason[:140]})",
         broadcast=True, payload={"Ref": req.ref, "reason": reason[:300]})


def _ev_raise_merge_gate(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "gate_event", "Waiting at the merge gate — review passed, approval needed",
         broadcast=True, payload={"gate": GATE_APPROVE_MERGE, "Ref": req.ref})


def _ev_begin_preview(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(
        db,
        req,
        "milestone_summary",
        f"Review passed — building preview round {req.preview_round + 1}",
        stage="preview",
        payload={"Stage": "Preview", "Ref": req.ref},
    )
    db.execute(
        update(PreviewFeedback)
        .where(
            PreviewFeedback.request_id == req.id,
            PreviewFeedback.round <= req.preview_round,
            PreviewFeedback.disposition == "open",
        )
        .values(disposition="addressed")
    )


def _ev_raise_accept_gate(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(
        db,
        req,
        "gate_event",
        f"Preview round {params['round']} live — {params['url']}",
        broadcast=True,
        payload={
            "gate": GATE_ACCEPT_PREVIEW,
            "url": params["url"],
            "round": params["round"],
            "sha": params.get("sha"),
            "digest": params["digest"],
        },
    )


def _ev_request_changes(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(
        db,
        req,
        "gate_event",
        f"Changes requested — round {req.preview_round} recorded",
        actor=actor.name,
        bot=False,
        payload={"gate": GATE_ACCEPT_PREVIEW, "round": req.preview_round, "Ref": req.ref},
    )


def _ev_advance_stage(db: Session, req: Request, actor: Actor, params: dict) -> None:
    if not params.get("announce"):
        return  # the AgentRunner advances silently; only the simulator announces (feed parity)
    stage = params["stage"]
    emit(db, req, "milestone_summary", f"Stage advanced — now in {stage.capitalize()}",
         payload={"Stage": stage.capitalize(), "Ref": req.ref})


def _ev_register_produced_app(
    db: Session, req: Request, actor: Actor, params: dict
) -> None:
    emit(
        db,
        req,
        "milestone_summary",
        f"Produced app registered — {params['name']} joins the fleet",
        stage="deploy",
        payload={"Ref": req.ref, "app_id": req.app_id, "app_key": params["key"]},
    )


def _ev_app_health(db: Session, req: Request, actor: Actor, params: dict) -> None:
    degraded = params["status"] == "degraded"
    emit(
        db,
        req,
        "escalation" if degraded else "recovery_action",
        (
            f"App health incident — {params['key']} stopped answering /health"
            if degraded
            else f"App health recovered — {params['key']} is answering /health"
        ),
        stage="deploy",
        broadcast=degraded,
        payload={
            "Ref": req.ref,
            "app_key": params["key"],
            "health_status": params["status"],
            "failures": params.get("failures", 0),
            "url": params["url"],
        },
    )


def _ev_enqueue_rollback(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(
        db,
        req,
        "recovery_action",
        f"Rollback queued — {params['key']} to {params['digest'][:19]}",
        actor=actor.name,
        bot=False,
        stage="deploy",
        payload={"Ref": req.ref, "app_key": params["key"], "digest": params["digest"]},
    )


def _ev_finish_rollback(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(
        db,
        req,
        "recovery_action",
        f"Rollback verified — {params['key']} is live at {params['digest'][:19]}",
        stage="deploy",
        broadcast=True,
        payload={
            "Ref": req.ref,
            "app_key": params["key"],
            "digest": params["digest"],
            "url": params["url"],
            "health_status": "live",
        },
    )


def _ev_fail_rollback(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(
        db,
        req,
        "escalation",
        f"Rollback failed — {params['key']} was not verified live",
        stage="deploy",
        broadcast=True,
        body=params["error"],
        payload={
            "Ref": req.ref,
            "app_key": params["key"],
            "digest": params["digest"],
            "error": params["error"],
            "health_status": "degraded",
        },
    )


# late-binding wrappers so tests can monkeypatch app.notifications.*
def _notify_gate_raised(db: Session, req: Request) -> None:
    notifications.notify_gate_raised(db, req)


def _notify_escalation(db: Session, req: Request) -> None:
    notifications.notify_escalation(db, req)


TABLE: dict[str, Transition] = {t.name: t for t in (
    # -------- intake / approval (HTTP-initiated: epoch=None) --------
    Transition(
        name="submit_claim",
        pre=Pre(status_in=(DRAFT, SUBMITTED)),
        effects=lambda p: {"status": PENDING_APPROVAL},
        conflict_detail=lambda r: "Already submitted",
    ),
    Transition(
        name="release_submit_claim",
        pre=Pre(status_in=(PENDING_APPROVAL,)),
        effects=lambda p: {"status": DRAFT, "gate": None},
        conflict_detail=lambda r: f"Cannot release submit claim from status '{r.status}'",
    ),
    Transition(
        name="raise_spec_gate",
        pre=Pre(status_in=(PENDING_APPROVAL,), gate=None),
        effects=lambda p: {"stage": "spec", "status": PENDING_APPROVAL,
                           "gate": GATE_APPROVE_SPEC, "stage_entered_at": utcnow()},
        events=_ev_raise_spec_gate,
        notify=_notify_gate_raised,
        conflict_detail=lambda r: f"Cannot raise the spec gate on a {r.status} request",
    ),
    Transition(
        name="approve_spec",
        pre=Pre(status_in=(PENDING_APPROVAL,), gate=GATE_APPROVE_SPEC),
        effects=lambda p: {"status": APPROVED, "gate": None, "stage": "architecture",
                           "sim_step": 0, "stage2_fired": True, "stage_entered_at": utcnow()},
        events=_ev_approve_spec,
        audit_action="approved",
        audit_note=lambda p: p.get("audit_note")
        or "approved the spec — repo created, SPEC.md PR opened, Stage 2 fired",
        replay_actions=("approved",),
        conflict_detail=lambda r: f"Cannot approve from status '{r.status}'",
    ),
    Transition(
        name="approve_architecture",
        pre=Pre(status_in=(APPROVED,), gate=GATE_APPROVE_ARCHITECTURE),
        effects=lambda p: {"gate": None},
        audit_action="approved_architecture",
        audit_note=lambda p: p.get("note"),
        replay_actions=("approved_architecture",),
        conflict_detail=lambda r: (
            "Cannot approve the architecture gate "
            f"(status={r.status!r}, gate={r.gate!r})"
        ),
    ),
    Transition(
        name="reject_architecture_gate",
        pre=Pre(status_in=(APPROVED,), gate=GATE_APPROVE_ARCHITECTURE),
        effects=lambda p: {
            "gate": None,
            "status": APPROVED,
            "stage": "architecture",
            "sim_step": 0,  # simulator refine round walks the stage again
            "pending_feedback": (
                "An admin reviewed the architecture and asked for changes:\n"
                f"{p['reason']}"
            ),
        },
        events=_ev_reject_architecture_gate,
        audit_action="rejected_architecture",
        audit_note=lambda p: p["reason"],
        replay_actions=("rejected_architecture",),
        conflict_detail=lambda r: (
            "Cannot reject the architecture gate "
            f"(status={r.status!r}, gate={r.gate!r})"
        ),
    ),
    Transition(
        name="claim_merge",
        pre=Pre(status_in=(APPROVED,), gate=GATE_APPROVE_MERGE),
        effects=lambda p: {"gate": None},
        audit_action="merge_claimed",
        replay_actions=("merge_claimed", "approved_merge", "merge_approval_failed"),
        conflict_detail=lambda r: f"Cannot merge a {r.status} request",
    ),
    Transition(
        name="claim_accept",
        pre=Pre(status_in=(APPROVED,), gate=GATE_ACCEPT_PREVIEW),
        effects=lambda p: {"gate": None, "needs_human": False,
                           "needs_human_reason": None},
        audit_action="preview_accepted",
        replay_actions=("preview_accepted",),
        conflict_detail=lambda r: f"Cannot accept preview on a {r.status} request",
    ),
    Transition(
        name="request_changes",
        pre=Pre(status_in=(APPROVED,), gate=GATE_ACCEPT_PREVIEW),
        effects=lambda p: {
            "gate": None,
            "stage": "architecture",
            "preview_round": Request.preview_round + 1,
            "sim_step": 0,
            "stage_entered_at": utcnow(),
            "needs_human": False,
            "needs_human_reason": None,
        },
        events=_ev_request_changes,
        audit_action="changes_requested",
        replay_actions=("changes_requested",),
        conflict_detail=lambda r: f"Cannot request changes on a {r.status} request",
    ),
    Transition(
        # A human's structured "no" at the merge gate (self-harness analysis
        # 2026-07-16): consumes the gate like claim_merge would, escalates with
        # a typed reason_code, and stages pending_feedback so the reason
        # reaches the next agent attempt like gate feedback does.
        name="reject_merge_gate",
        pre=Pre(status_in=(APPROVED,), gate=GATE_APPROVE_MERGE),
        effects=_reject_gate_effects,
        events=_ev_reject_gate,
        audit_action="rejected_merge",
        audit_note=lambda p: f"({p['reason_code']}) {p['reason']}",
        replay_actions=("rejected_merge",),
        conflict_detail=lambda r: f"Cannot reject the merge gate (status={r.status!r}, gate={r.gate!r})",
    ),
    Transition(
        # The deploy-gate twin. kube_runner._deploy_rejected shields the deploy
        # driver afterwards: a Retry re-raises this gate, never a silent deploy.
        name="reject_deploy_gate",
        pre=Pre(status_in=(APPROVED,), gate=GATE_APPROVE_DEPLOY),
        effects=_reject_gate_effects,
        events=_ev_reject_gate,
        audit_action="rejected_deploy",
        audit_note=lambda p: f"({p['reason_code']}) {p['reason']}",
        replay_actions=("rejected_deploy",),
        conflict_detail=lambda r: f"Cannot reject the deploy gate (status={r.status!r}, gate={r.gate!r})",
    ),
    Transition(
        # B4 (machine, epoch-fenced by the caller): after a real merge, the
        # request WAITS at the deploy gate instead of auto-building (spec §4.10).
        # Stamps stage=deploy WITH the gate set, so _drive_deploys' gate-IS-NULL
        # guard holds it until a human approves.
        name="raise_deploy_gate",
        pre=Pre(status_in=(APPROVED,), gate=None),
        effects=lambda p: {"gate": GATE_APPROVE_DEPLOY, "stage": "deploy",
                           "stage_entered_at": utcnow()},
        events=_ev_raise_deploy_gate,
        notify=_notify_gate_raised,
        conflict_detail=lambda r: f"Cannot raise the deploy gate (status={r.status!r}, gate={r.gate!r})",
    ),
    Transition(
        # B4 (HTTP): the human claims the deploy gate, mirroring claim_merge.
        name="claim_deploy",
        pre=Pre(status_in=(APPROVED,), gate=GATE_APPROVE_DEPLOY),
        effects=lambda p: {"gate": None},
        audit_action="deploy_claimed",
        replay_actions=("deploy_claimed", "approved_deploy", "deploy_approval_failed"),
        conflict_detail=lambda r: f"Cannot approve deploy on a {r.status} request",
    ),
    Transition(
        # Plan B3 (reworked by B4): the RELEASE step the approve endpoint applies
        # after claim_deploy — idempotent effects, approver-attributed milestone.
        # When app_deploy_enabled() is false, approve_merge still goes straight
        # to finish_done (B2 behavior) and neither deploy transition fires.
        name="begin_deploy",
        pre=Pre(status_in=(APPROVED,)),
        effects=lambda p: {"gate": None, "stage": "deploy", "status": APPROVED,
                           "stage_entered_at": utcnow()},
        events=_ev_begin_deploy,
        conflict_detail=lambda r: f"Cannot begin deploy from status '{r.status}'",
    ),
    Transition(
        name="finish_done",
        pre=Pre(status_in=(APPROVED,)),
        effects=lambda p: {"gate": None, "stage": "done", "status": DONE,
                           "stage_entered_at": utcnow()},
        events=_ev_finish_done,
        conflict_detail=lambda r: f"Cannot finish a {r.status} request",
    ),
    Transition(
        name="send_back",
        pre=Pre(status_in=(PENDING_APPROVAL, SUBMITTED)),
        effects=lambda p: {"status": SENT_BACK, "gate": None,
                           "needs_human": False, "needs_human_reason": None,
                           "send_back_question": p.get("note") or "Could you add a bit more detail?",
                           "send_back_rounds": Request.send_back_rounds + 1,
                           "stage_entered_at": utcnow()},
        events=_ev_send_back,
        audit_action="sent_back",
        audit_note=lambda p: p.get("note"),
        replay_actions=("sent_back",),
        conflict_detail=lambda r: f"Cannot send back from status '{r.status}'",
    ),
    Transition(
        name="respond",
        pre=Pre(status_in=(SENT_BACK,)),
        effects=lambda p: {"send_back_response": p["note"], "status": PENDING_APPROVAL,
                           "gate": GATE_APPROVE_SPEC, "stage_entered_at": utcnow()},
        events=_ev_respond,
        audit_action="responded",
        audit_note=lambda p: p.get("note"),
        notify=_notify_gate_raised,
        conflict_detail=lambda r: "Nothing to respond to",
    ),
    Transition(
        name="cancel",
        pre=Pre(status_not_in=CLOSED),
        effects=lambda p: {"status": CANCELLED, "gate": None,
                           "needs_human": False, "needs_human_reason": None},
        events=_ev_cancel,
        audit_action="cancelled",
        audit_note=lambda p: p.get("note"),
        replay_actions=("cancelled",),
        conflict_detail=lambda r: f"Cannot cancel a {r.status} request",
    ),
    # -------- recovery actions (HTTP-initiated: epoch=None) --------
    Transition(
        name="retry_spec",
        pre=Pre(needs_human=True),
        effects=lambda p: {"needs_human": False, "needs_human_reason": None,
                           "status": PENDING_APPROVAL, "gate": GATE_APPROVE_SPEC,
                           "sim_step": 0, "stage_entered_at": utcnow()},
        events=_ev_retry,
        audit_action="retried",
        audit_note=lambda p: p.get("note"),
        replay_actions=("retried",),
        conflict_detail=lambda r: "Request is not escalated",
    ),
    Transition(
        name="retry_pipeline",
        pre=Pre(needs_human=True),
        effects=lambda p: {"needs_human": False, "needs_human_reason": None,
                           "status": APPROVED, "gate": None,
                           "sim_step": 0, "stage_entered_at": utcnow()},
        events=_ev_retry,
        audit_action="retried",
        audit_note=lambda p: p.get("note"),
        replay_actions=("retried",),
        conflict_detail=lambda r: "Request is not escalated",
    ),
    Transition(
        name="take_over",
        pre=Pre(needs_human=True),
        effects=lambda p: {"status": HUMAN_OWNED, "needs_human": False,
                           "needs_human_reason": None, "gate": None},
        events=_ev_take_over,
        audit_action="taken_over",
        audit_note=lambda p: p.get("note"),
        replay_actions=("taken_over",),
        conflict_detail=lambda r: "Request is not escalated",
    ),
    Transition(
        name="send_back_to_stage",
        pre=Pre(needs_human=True),
        # the operator's reason now reaches the re-run agent as pending_feedback
        # (it was recorded but never injected before); a newer reason replaces
        # an earlier staged one — the latest human instruction wins
        effects=lambda p: {"stage": p["stage"], "status": APPROVED, "gate": None,
                           "needs_human": False, "needs_human_reason": None,
                           "sim_step": 0, "stage_entered_at": utcnow(),
                           **({"pending_feedback":
                               f"A human sent this work back to the {p['stage']} stage. "
                               f"Their reason:\n{p['reason']}"}
                              if p.get("reason") else {})},
        events=_ev_send_back_to_stage,
        audit_action="sent_back_to_stage",
        audit_note=lambda p: p.get("reason"),
        replay_actions=("sent_back_to_stage",),
        conflict_detail=lambda r: "Request is not escalated",
    ),
    # -------- machine transitions (tick loop / pipeline threads: pass epoch=) --------
    Transition(
        # E2E-4: the reviewer's REQUEST-CHANGES sends the work BACK TO THE
        # IMPLEMENTER with the review as feedback (re-reviewing unchanged code
        # is honest but useless — proven live). Bounded in the runner; the
        # global REQUEST_ATTEMPT_BUDGET still caps everything.
        name="review_rework",
        pre=Pre(status_in=(APPROVED,), gate=None),
        effects=lambda p: {
            "stage": "build",
            "sim_step": 0,
            "stage_entered_at": utcnow(),
            "pending_feedback": p["feedback"],
        },
        events=lambda db, req, actor, params: emit(
            db, req, "milestone_summary",
            "Reviewer requested changes — sending the work back to the implementer",
            payload={"Ref": req.ref, "stage": "review",
                     "reason": params["feedback"][:300]},
        ),
        audit_action="review_rework",
        conflict_detail=lambda r: f"Cannot rework review on a {r.status} request",
    ),
    Transition(
        name="escalate",
        pre=Pre(status_not_in=CLOSED),
        effects=lambda p: {"needs_human": True, "needs_human_reason": p["reason"][:300]},
        events=_ev_escalate,
        notify=_notify_escalation,
        conflict_detail=lambda r: f"Cannot escalate a {r.status} request",
    ),
    Transition(
        name="begin_preview",
        pre=Pre(status_in=(APPROVED,), gate=None),
        effects=lambda p: {"stage": "preview", "stage_entered_at": utcnow()},
        events=_ev_begin_preview,
        conflict_detail=lambda r: f"Cannot begin preview on a {r.status} request",
    ),
    Transition(
        name="raise_accept_gate",
        pre=Pre(status_in=(APPROVED,), gate=None),
        effects=lambda p: {"gate": GATE_ACCEPT_PREVIEW, "stage_entered_at": utcnow()},
        events=_ev_raise_accept_gate,
        notify=_notify_gate_raised,
        conflict_detail=lambda r: f"Cannot raise preview acceptance gate on a {r.status} request",
    ),
    Transition(
        name="raise_architecture_gate",
        pre=Pre(status_in=(APPROVED,), gate=None),
        effects=lambda p: {
            "gate": GATE_APPROVE_ARCHITECTURE,
            "stage_entered_at": utcnow(),
        },
        events=_ev_raise_architecture_gate,
        notify=_notify_gate_raised,
        conflict_detail=lambda r: (
            "Cannot raise the architecture gate "
            f"(status={r.status!r}, gate={r.gate!r})"
        ),
    ),
    Transition(
        name="raise_merge_gate",
        pre=Pre(status_in=(APPROVED,), gate=None),
        effects=lambda p: {"gate": GATE_APPROVE_MERGE, "stage_entered_at": utcnow()},
        events=_ev_raise_merge_gate,
        notify=_notify_gate_raised,
        conflict_detail=lambda r: f"Cannot raise the merge gate (status={r.status!r}, gate={r.gate!r})",
    ),
    Transition(
        name="advance_stage",
        pre=Pre(status_in=(APPROVED,), needs_human=False),
        effects=lambda p: {"stage": p["stage"], "sim_step": 0, "stage_entered_at": utcnow()},
        events=_ev_advance_stage,
        conflict_detail=lambda r: f"Cannot advance (status={r.status!r}, needs_human={r.needs_human})",
    ),
    Transition(
        name="register_produced_app",
        pre=Pre(status_in=(APPROVED,), gate=None, needs_human=False, app_id=None),
        effects=lambda p: {"app_id": p["app_id"], "updated_at": utcnow()},
        events=_ev_register_produced_app,
        conflict_detail=lambda r: "Produced app registration precondition was consumed",
    ),
    Transition(
        name="record_app_health",
        pre=Pre(status_in=(DONE,)),
        effects=lambda p: {"updated_at": utcnow()},
        events=_ev_app_health,
        conflict_detail=lambda r: f"Cannot record app health on a {r.status} request",
    ),
    Transition(
        name="enqueue_rollback",
        pre=Pre(status_in=(DONE,)),
        effects=lambda p: {"updated_at": utcnow()},
        events=_ev_enqueue_rollback,
        audit_action="rollback_requested",
        audit_note=lambda p: f"rollback {p['key']} to {p['digest']}",
        conflict_detail=lambda r: f"Cannot enqueue rollback on a {r.status} request",
    ),
    Transition(
        name="drive_rollback",
        pre=Pre(status_in=(DONE,)),
        effects=lambda p: {"updated_at": utcnow()},
        conflict_detail=lambda r: f"Cannot drive rollback on a {r.status} request",
    ),
    Transition(
        name="record_rollback_applied",
        pre=Pre(status_in=(DONE,)),
        effects=lambda p: {"updated_at": utcnow()},
        conflict_detail=lambda r: f"Cannot record rollback apply on a {r.status} request",
    ),
    Transition(
        name="finish_rollback",
        pre=Pre(status_in=(DONE,)),
        effects=lambda p: {"updated_at": utcnow()},
        events=_ev_finish_rollback,
        conflict_detail=lambda r: f"Cannot finish rollback on a {r.status} request",
    ),
    Transition(
        name="fail_rollback",
        pre=Pre(status_in=(DONE,)),
        effects=lambda p: {"updated_at": utcnow()},
        events=_ev_fail_rollback,
        conflict_detail=lambda r: f"Cannot fail rollback on a {r.status} request",
    ),
)}


# ---------- apply ----------

def _where(req_id: int, pre: Pre, expected_stage: str | None) -> list:
    clauses = [Request.id == req_id]
    if pre.status_in is not None:
        clauses.append(Request.status.in_(pre.status_in))
    if pre.status_not_in is not None:
        clauses.append(Request.status.not_in(pre.status_not_in))
    if pre.gate is not ANY:
        clauses.append(Request.gate.is_(None) if pre.gate is None else Request.gate == pre.gate)
    if pre.needs_human is not None:
        # truthiness, not .is_(bool): SQLAlchemy renders `IS 0/1` on mssql (invalid T-SQL)
        clauses.append(Request.needs_human if pre.needs_human else ~Request.needs_human)
    if pre.app_id is not ANY:
        clauses.append(
            Request.app_id.is_(None) if pre.app_id is None else Request.app_id == pre.app_id
        )
    if expected_stage is not None:
        clauses.append(Request.stage == expected_stage)
    return clauses


def resolve_loss(
    db: Session,
    req: Request,
    transition: str,
    actor: Actor,
    *,
    epoch: int | None = None,
) -> Loss:
    """Resolve a consumed precondition against its persisted winning action (ADR 0006)."""
    row = TABLE[transition]
    db.rollback()
    db.refresh(req)
    current_epoch = None
    if epoch is not None:
        current_epoch = db.scalar(select(LeaderEpoch.epoch).where(LeaderEpoch.id == 1))
    winner = db.scalar(
        select(AuditEvent)
        .where(AuditEvent.request_id == req.id, AuditEvent.action.in_(DECISIVE_ACTIONS))
        .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
        .limit(1)
    )
    replay = False
    if winner is not None:
        # New decisive actions carry the stable operator pointer. Actor fallback
        # preserves ADR 0006 replay for audit rows without one (pre-migration rows
        # and submitter-actor transitions) — two None ids are NOT the same operator.
        same_operator = (
            winner.operator_id is not None and winner.operator_id == actor.operator_id
        ) or (winner.operator_id is None and winner.actor == actor.name)
        replay = same_operator and winner.action in row.replay_actions
    detail = (
        f"fenced: stale leader epoch (mine={epoch}, current={current_epoch})"
        if epoch is not None and epoch != current_epoch
        else row.conflict_detail(req)
    )
    return Loss(
        transition=transition,
        replay=replay,
        winner=winner,
        resulting_state=req.gate or req.status,
        detail=detail,
    )


def apply(
    db: Session,
    req: Request,
    transition: str,
    *,
    actor: Actor,
    params: dict | None = None,
    intent: IntentSpec | None = None,
    epoch: int | None = None,
    expected_stage: str | None = None,
) -> Win | Loss:
    """Apply one named transition atomically: CAS claim + audit + events (+ intent).

    Wins are UNCOMMITTED — the caller commits, then calls ``Win.notify()``.
    Losses have already rolled back (including any pending session state).
    Staged sibling writes on any row are safe across ``apply()``: they are
    flushed before the CAS and survive a Win, while a Loss rolls them back.
    Callers must not stage a write to a precondition column of the transition
    they are about to apply. Pass ``expected_stage`` for a first-class stage
    precondition; ``params`` never changes the CAS predicate.
    ``req`` must belong to ``db``; it is refreshed on both outcomes.
    """
    db.flush()
    row = TABLE[transition]
    params = params or {}
    clauses = _where(req.id, row.pre, expected_stage)
    if epoch is not None:  # machine actor — fence against a deposed leader (spec §3.2)
        if db.get_bind().dialect.name == "mssql":
            current_epoch = db.scalar(
                text(
                    "SELECT epoch FROM leader_epochs WITH (UPDLOCK, HOLDLOCK) "
                    "WHERE id = 1 AND epoch = :epoch"
                ),
                {"epoch": epoch},
            )
        else:
            current_epoch = db.scalar(
                select(LeaderEpoch.epoch).where(LeaderEpoch.id == 1)
            )
        if current_epoch != epoch:
            return resolve_loss(db, req, transition, actor, epoch=epoch)
        clauses.append(
            select(LeaderEpoch.id)
            .where(LeaderEpoch.id == 1, LeaderEpoch.epoch == epoch)
            .exists()
        )
    try:
        effects = row.effects(params)
    except KeyError:
        # A consumed precondition is a Loss even when the winning transition's
        # effects require params the losing caller did not need to provide.
        if db.scalar(select(Request.id).where(*clauses).limit(1)) is None:
            return resolve_loss(db, req, transition, actor, epoch=epoch)
        raise
    claimed = db.execute(update(Request).where(*clauses).values(**effects)).rowcount
    if claimed != 1:
        return resolve_loss(db, req, transition, actor, epoch=epoch)
    db.refresh(req)
    if row.audit_action:
        db.add(AuditEvent(
            request_id=req.id,
            operator_id=actor.operator_id,
            actor=actor.name,
            action=row.audit_action,
            note=row.audit_note(params) if row.audit_note else None,
        ))
        db.flush()  # the winner identity must be queryable before any internal commit
    if row.events:
        row.events(db, req, actor, params)
    intent_row = None
    if intent is not None:
        intent_row = intents.begin(db, intent.key, intent.kind, req.id, intent.payload)
    notify = None
    if row.notify is not None:
        _bound_notify, _bound_req = row.notify, req

        def notify() -> None:
            _bound_notify(db, _bound_req)

    return Win(transition=transition, intent=intent_row, _notify=notify)


def apply_committed(
    db: Session,
    req: Request,
    transition: str,
    *,
    actor: Actor,
    params: dict | None = None,
    intent: IntentSpec | None = None,
    epoch: int | None = None,
    expected_stage: str | None = None,
) -> Win | Loss:
    """apply() for MACHINE callers that own no larger transaction: a Win is
    committed and its post-commit notification fired before returning; a Loss
    has already rolled back. Staged sibling writes ride the same commit.
    Callers composing a bigger transaction keep using apply() directly."""
    res = apply(db, req, transition, actor=actor, params=params, intent=intent,
                epoch=epoch, expected_stage=expected_stage)
    if isinstance(res, Win):
        db.commit()
        res.notify()
    return res


# ---------- the Plan A primitive (unchanged; Plan B wires pipeline jobs through it) ----------

def cas_status(
    db: Session,
    request_id: int,
    expected: str,
    new: str,
    epoch: int,
) -> bool:
    """Move one request only when its status and the leader epoch still match.

    The caller owns the transaction: commit on ``True`` and roll back on
    ``False`` so intent rows, event appends, and this CAS land atomically or not
    at all. Because sessions use ``expire_on_commit=False``, callers must call
    ``db.refresh(obj)`` to see the new status on already-loaded objects.
    """
    # MSSQL commonly runs READ_COMMITTED_SNAPSHOT: without a locking read, this
    # transaction can observe the old epoch from its snapshot and commit after a
    # successor bumps the fence. UPDLOCK + HOLDLOCK serializes this CAS with the
    # epoch bump until the caller commits/rolls back. SQLite stays on the original
    # one-statement path and never sees MSSQL-only syntax.
    if db.get_bind().dialect.name == "mssql":
        locked_epoch = db.scalar(
            text(
                "SELECT epoch FROM leader_epochs WITH (UPDLOCK, HOLDLOCK) "
                "WHERE id = 1 AND epoch = :epoch"
            ),
            {"epoch": epoch},
        )
        if locked_epoch != epoch:
            return False
    result = db.execute(
        text(
            "UPDATE requests SET status = :new "
            "WHERE id = :rid AND status = :expected "
            "AND EXISTS (SELECT 1 FROM leader_epochs "
            "WHERE id = 1 AND epoch = :epoch)"
        ),
        {
            "new": new,
            "rid": request_id,
            "expected": expected,
            "epoch": epoch,
        },
    )
    return result.rowcount == 1
