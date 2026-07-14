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
from .models import AuditEvent, Intent, LeaderEpoch, Request, utcnow

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
GATE_APPROVE_MERGE = "approve_merge"

# The audit actions a Loss resolves against (ADR 0006): the newest of these rows
# identifies the winner of a consumed precondition.
DECISIVE_ACTIONS = (
    "approved",
    "merge_claimed",
    "approved_merge",
    "merge_approval_failed",
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


def _ev_escalate(db: Session, req: Request, actor: Actor, params: dict) -> None:
    reason = params["reason"]
    emit(db, req, "escalation", f"Escalated — needs a human ({reason[:140]})",
         broadcast=True, payload={"Ref": req.ref, "reason": reason[:300]})


def _ev_raise_merge_gate(db: Session, req: Request, actor: Actor, params: dict) -> None:
    emit(db, req, "gate_event", "Waiting at the merge gate — review passed, approval needed",
         broadcast=True, payload={"gate": GATE_APPROVE_MERGE, "Ref": req.ref})


def _ev_advance_stage(db: Session, req: Request, actor: Actor, params: dict) -> None:
    if not params.get("announce"):
        return  # the AgentRunner advances silently; only the simulator announces (feed parity)
    stage = params["stage"]
    emit(db, req, "milestone_summary", f"Stage advanced — now in {stage.capitalize()}",
         payload={"Stage": stage.capitalize(), "Ref": req.ref})


# late-binding wrappers so tests can monkeypatch app.notifications.*
def _notify_gate_raised(db: Session, req: Request) -> None:
    notifications.notify_gate_raised(db, req)


def _notify_escalation(db: Session, req: Request) -> None:
    notifications.notify_escalation(db, req)


TABLE: dict[str, Transition] = {
    # -------- intake / approval (HTTP-initiated: epoch=None) --------
    "submit_claim": Transition(
        name="submit_claim",
        pre=Pre(status_in=(DRAFT, SUBMITTED)),
        effects=lambda p: {"status": PENDING_APPROVAL},
        conflict_detail=lambda r: "Already submitted",
    ),
    "release_submit_claim": Transition(
        name="release_submit_claim",
        pre=Pre(status_in=(PENDING_APPROVAL,)),
        effects=lambda p: {"status": DRAFT},
        conflict_detail=lambda r: f"Cannot release submit claim from status '{r.status}'",
    ),
    "raise_spec_gate": Transition(
        name="raise_spec_gate",
        pre=Pre(status_in=(PENDING_APPROVAL,), gate=None),
        effects=lambda p: {"stage": "spec", "status": PENDING_APPROVAL,
                           "gate": GATE_APPROVE_SPEC, "stage_entered_at": utcnow()},
        events=_ev_raise_spec_gate,
        notify=_notify_gate_raised,
        conflict_detail=lambda r: f"Cannot raise the spec gate on a {r.status} request",
    ),
    "approve_spec": Transition(
        name="approve_spec",
        pre=Pre(status_in=(PENDING_APPROVAL,), gate=GATE_APPROVE_SPEC),
        effects=lambda p: {"status": APPROVED, "gate": None, "stage": "architecture",
                           "sim_step": 0, "stage2_fired": True, "stage_entered_at": utcnow()},
        events=_ev_approve_spec,
        audit_action="approved",
        audit_note=lambda p: "approved the spec — repo created, SPEC.md PR opened, Stage 2 fired",
        replay_actions=("approved",),
        conflict_detail=lambda r: f"Cannot approve from status '{r.status}'",
    ),
    "claim_merge": Transition(
        name="claim_merge",
        pre=Pre(status_in=(APPROVED,), gate=GATE_APPROVE_MERGE),
        effects=lambda p: {"gate": None},
        audit_action="merge_claimed",
        replay_actions=("merge_claimed", "approved_merge", "merge_approval_failed"),
        conflict_detail=lambda r: f"Cannot merge a {r.status} request",
    ),
    "finish_done": Transition(
        name="finish_done",
        pre=Pre(status_in=(APPROVED,)),
        effects=lambda p: {"gate": None, "stage": "done", "status": DONE,
                           "stage_entered_at": utcnow()},
        events=_ev_finish_done,
        conflict_detail=lambda r: f"Cannot finish a {r.status} request",
    ),
    "send_back": Transition(
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
    "respond": Transition(
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
    "cancel": Transition(
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
    "retry": Transition(
        name="retry",
        pre=Pre(needs_human=True),
        effects=lambda p: {"needs_human": False, "needs_human_reason": None,
                           "status": p["status"], "gate": p["gate"],
                           "sim_step": 0, "stage_entered_at": utcnow()},
        events=_ev_retry,
        audit_action="retried",
        audit_note=lambda p: p.get("note"),
        replay_actions=("retried",),
        conflict_detail=lambda r: "Request is not escalated",
    ),
    "take_over": Transition(
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
    "send_back_to_stage": Transition(
        name="send_back_to_stage",
        pre=Pre(needs_human=True),
        effects=lambda p: {"stage": p["stage"], "status": APPROVED, "gate": None,
                           "needs_human": False, "needs_human_reason": None,
                           "sim_step": 0, "stage_entered_at": utcnow()},
        events=_ev_send_back_to_stage,
        audit_action="sent_back_to_stage",
        audit_note=lambda p: p.get("reason"),
        replay_actions=("sent_back_to_stage",),
        conflict_detail=lambda r: "Request is not escalated",
    ),
    # -------- machine transitions (tick loop / pipeline threads: pass epoch=) --------
    "escalate": Transition(
        name="escalate",
        pre=Pre(status_not_in=CLOSED),
        effects=lambda p: {"needs_human": True, "needs_human_reason": p["reason"][:300]},
        events=_ev_escalate,
        notify=_notify_escalation,
        conflict_detail=lambda r: f"Cannot escalate a {r.status} request",
    ),
    "raise_merge_gate": Transition(
        name="raise_merge_gate",
        pre=Pre(status_in=(APPROVED,), gate=None),
        effects=lambda p: {"gate": GATE_APPROVE_MERGE, "stage_entered_at": utcnow()},
        events=_ev_raise_merge_gate,
        notify=_notify_gate_raised,
        conflict_detail=lambda r: f"Cannot raise the merge gate (status={r.status!r}, gate={r.gate!r})",
    ),
    "advance_stage": Transition(
        name="advance_stage",
        pre=Pre(status_in=(APPROVED,), needs_human=False),
        effects=lambda p: {"stage": p["stage"], "sim_step": 0, "stage_entered_at": utcnow()},
        events=_ev_advance_stage,
        conflict_detail=lambda r: f"Cannot advance (status={r.status!r}, needs_human={r.needs_human})",
    ),
}


# ---------- apply ----------

def _where(req_id: int, pre: Pre, params: dict) -> list:
    clauses = [Request.id == req_id]
    if pre.status_in is not None:
        clauses.append(Request.status.in_(pre.status_in))
    if pre.status_not_in is not None:
        clauses.append(Request.status.not_in(pre.status_not_in))
    if pre.gate is not ANY:
        clauses.append(Request.gate.is_(None) if pre.gate is None else Request.gate == pre.gate)
    if pre.needs_human is not None:
        clauses.append(Request.needs_human.is_(pre.needs_human))
    if "from_stage" in params:  # strict stage CAS where the caller knows the origin
        clauses.append(Request.stage == params["from_stage"])
    return clauses


def resolve_loss(db: Session, req: Request, transition: str, actor: Actor) -> Loss:
    """Resolve a consumed precondition against its persisted winning action (ADR 0006)."""
    row = TABLE[transition]
    db.rollback()
    db.refresh(req)
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
    return Loss(
        transition=transition,
        replay=replay,
        winner=winner,
        resulting_state=req.gate or req.status,
        detail=row.conflict_detail(req),
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
) -> Win | Loss:
    """Apply one named transition atomically: CAS claim + audit + events (+ intent).

    Wins are UNCOMMITTED — the caller commits, then calls ``Win.notify()``.
    Losses have already rolled back (including any pending session state).
    Staged sibling writes on any row are safe across ``apply()``: they are
    flushed before the CAS and survive a Win, while a Loss rolls them back.
    Callers must not stage a write to a precondition column of the transition
    they are about to apply.
    ``req`` must belong to ``db``; it is refreshed on both outcomes.
    """
    db.flush()
    row = TABLE[transition]
    params = params or {}
    clauses = _where(req.id, row.pre, params)
    if epoch is not None:  # machine actor — fence against a deposed leader (spec §3.2)
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
            return resolve_loss(db, req, transition, actor)
        raise
    claimed = db.execute(update(Request).where(*clauses).values(**effects)).rowcount
    if claimed != 1:
        return resolve_loss(db, req, transition, actor)
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
    # Under MSSQL READ COMMITTED/RCSI, a stale leader's in-flight statement can
    # commit just after an epoch bump. The status CAS still serializes conflicting
    # transitions; revisit with UPDLOCK/HOLDLOCK once cas_status carries production traffic.
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
