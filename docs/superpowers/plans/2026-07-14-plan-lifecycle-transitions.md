# Lifecycle Transitions Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ~90 scattered lifecycle writes (magic-string statuses, 7 copies of CAS
loss-resolution, 3 `lifecycle.py` functions, ad-hoc ORM mutations) with one declarative
transition table + `apply()` in `api/app/transitions.py`, plus a derived
`supervision.classify()` read model — behavior-preserving (all existing HTTP/race tests pass
unchanged).

**Architecture:** Every legal move of a Request's composite lifecycle state
`(status, stage, gate, needs_human)` becomes a named row in a `TABLE` of `Transition`
dataclasses. `apply(db, req, name, *, actor, params, intent, epoch)` executes the row as one
compare-and-swap `UPDATE` whose `WHERE` carries the row's full composite precondition
(generalizing the Plan A `cas_status` pattern), then — still uncommitted — appends the
winner's `AuditEvent`, the row's `progress_event`s, and an optional intent row. The caller
owns the commit (same contract as `cas_status`). Losses resolve against the persisted winning
audit action (absorbing `_resolve_cas_loss` + `DECISIVE_ACTIONS`). Migration is staged:
core module → gates.py → requests.py → simulator.py → agent_runner.py (+ delete
lifecycle.py) → classify() adoption → docs, with the full pytest suite green after every stage.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy 2.0 (Core `update()` through the ORM
session), pytest. No new dependencies.

**Branch:** `lifecycle-transitions` off local `main` (spec D1: Plan A is already merged —
`api/app/transitions.py` with `cas_status`, `api/app/intents.py`, `api/app/leader.py` all
exist on main).

## Global Constraints

- **Binding design decisions:** `docs/superpowers/specs/2026-07-14-deepening-candidates-design.md`, Candidate 1, D1–D8.
- **ADR 0008:** never UPDATE or DELETE `progress_event` rows — the log is append-only.
- **Single uvicorn worker:** the tick loop and pipeline threads assume one process (AGENTS.md).
- **Caller-owned commit:** `apply()` (like `cas_status`) NEVER commits; the router/runner commits on `Win`, a `Loss` has already rolled back.
- **Behavior-preserving:** `tests/test_conflict_safe_actions.py`, `tests/test_hardening.py`, `tests/test_scoped_recovery.py`, `tests/test_supervision.py`, `tests/test_email_and_freshness.py`, `tests/test_agent_runner.py` must pass **UNCHANGED** (D7 — they are the integration coverage). Do not edit them.
- **Fencing policy (leadership):** HTTP-initiated (human) transitions pass `epoch=None` — fenced by the composite-state precondition only, valid on any replica. Machine transitions (tick loop, pipeline threads, startup rescue) pass `epoch=get_elector().epoch` — additionally fenced by the `leader_epochs` EXISTS guard. This is explicit in the module docstring and pinned by tests (Task 1).
- **Verify-green between migration stages (D3):** run `cd api && uv run pytest -q` and `cd api && uv run ruff check .` at the end of every task; `task verify` (repo root) at the end.
- **Lint:** ruff, py313, line-length 120, rules E/F/I/B (isort-clean imports).
- Existing `cas_status()` stays untouched (its regression tests in `test_transitions.py` and `test_intents.py` pin the caller-owned-commit contract; Plan B still targets it).
- Commit after every task. Every commit message ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- If an edge case forces a deviation, pick the conservative option and log it under `## Deviations` in `implementation-notes.md` (repo root); keep going.

## File Structure

| File | Change |
|---|---|
| `api/app/transitions.py` | ADD constants, `Actor`, `Pre`, `Transition`, `Win`/`Loss`, `IntentSpec`, `TABLE` (14 rows), `apply()`, `resolve_loss()`. `cas_status` stays. |
| `api/app/api_helpers.py` | ADD `conflict_response()` (the one HTTP mapping of a `Loss`). |
| `api/app/routers/gates.py` | All 7 endpoints go through `apply()`; DELETE `_resolve_cas_loss` + `DECISIVE_ACTIONS` (moved to transitions). |
| `api/app/routers/requests.py` | `submit` claim + spec-gate raise through `apply()`; constants in create/update/detail. |
| `api/app/simulator.py` | stage-advance, merge-gate raise, escalate, finish_done through `apply()` (epoch-fenced where machine-initiated). |
| `api/app/agent_runner.py` | `_advance`, `_escalate`, `_review` gate raise, `approve_merge` through `apply()`. |
| `api/app/startup.py` | `escalate_orphans` through `apply()`. |
| `api/app/lifecycle.py` | **DELETED** (its 3 functions become table rows). |
| `api/app/supervision.py` | ADD `classify()`; `in_flight()` derives from it. |
| `api/app/routers/mission.py`, `api/app/routers/events.py` | adopt `classify()` / constants. |
| `api/tests/test_transitions.py` | EXTEND with table/apply unit tests + race pairs. |
| `api/tests/test_supervision.py` — do NOT edit | new classify tests go in `api/tests/test_classify_phases.py`. |
| `CONTEXT.md` | ADD the **Transition** term (D8). |

---

### Task 1: The transitions module — constants, table, `apply()`

**Files:**
- Modify: `api/app/transitions.py` (currently only `cas_status`, 38 lines — keep it, add below it)
- Test: `api/tests/test_transitions.py` (extend; existing 4 `cas_status` tests stay untouched)

**Interfaces:**
- Consumes: `models.Request/AuditEvent/LeaderEpoch/utcnow/PIPELINE_STAGES`, `events.emit`, `intents.begin`, `notifications.notify_escalation/notify_gate_raised` (all exist on main).
- Produces (later tasks rely on these exact names):
  - Constants: `DRAFT, SUBMITTED, PENDING_APPROVAL, SENT_BACK, APPROVED, HUMAN_OWNED, DONE, CANCELLED, CLOSED, PRE_APPROVAL, GATE_APPROVE_SPEC, GATE_APPROVE_MERGE, DECISIVE_ACTIONS, ANY, FACTORY`
  - `Actor(name: str, operator_id: int | None = None)` (frozen dataclass)
  - `IntentSpec(key: str, kind: str, payload: dict)` (frozen dataclass)
  - `Win(transition: str, intent: Intent | None, _notify)` with method `.notify() -> None`
  - `Loss(transition: str, replay: bool, winner: AuditEvent | None, resulting_state: str, detail: str)`
  - `apply(db, req, transition: str, *, actor: Actor, params: dict | None = None, intent: IntentSpec | None = None, epoch: int | None = None) -> Win | Loss`
  - `resolve_loss(db, req, transition: str, actor: Actor) -> Loss`
  - `TABLE: dict[str, Transition]` with row names: `submit_claim, raise_spec_gate, approve_spec, claim_merge, finish_done, send_back, respond, cancel, retry, take_over, send_back_to_stage, escalate, raise_merge_gate, advance_stage`

- [ ] **Step 1: Write the failing unit tests**

Append the following to `api/tests/test_transitions.py` (keep the existing imports and the
four existing `cas_status` tests exactly as they are; add these imports at the top, merged
into the existing import block, isort-ordered):

```python
"""(additions — appended below the existing cas_status tests)"""
from sqlalchemy import select

from app import transitions
from app.models import AuditEvent, Intent, ProgressEvent
from app.transitions import (
    ANY,
    APPROVED,
    CANCELLED,
    DONE,
    DRAFT,
    FACTORY,
    GATE_APPROVE_MERGE,
    GATE_APPROVE_SPEC,
    HUMAN_OWNED,
    PENDING_APPROVAL,
    SENT_BACK,
    SUBMITTED,
    TABLE,
    Actor,
    IntentSpec,
    Loss,
    Win,
    apply,
)


def _request(db, **cols):
    """A Request in an arbitrary lifecycle state — the unit-test fixture."""
    defaults = dict(
        ref=f"REQ-{uuid.uuid4().hex[:8]}",
        title="Transition fixture",
        description="Exercise the transition table.",
        type="enh",
        status="draft",
        stage="intake",
    )
    defaults.update(cols)
    request = Request(**defaults)
    db.add(request)
    db.commit()
    return request


def _events(db, rid, kind=None):
    q = select(ProgressEvent).where(ProgressEvent.request_id == rid)
    rows = list(db.scalars(q.order_by(ProgressEvent.id)))
    return [e for e in rows if kind is None or e.kind == kind]


def _audits(db, rid, action):
    return list(db.scalars(select(AuditEvent).where(
        AuditEvent.request_id == rid, AuditEvent.action == action)))


RILEY = Actor(name="Riley Test", operator_id=None)

# (name, starting columns, params, expected columns after Win, expected audit action)
ROW_CASES = [
    ("submit_claim", dict(status=DRAFT), {},
     dict(status=PENDING_APPROVAL), None),
    ("raise_spec_gate", dict(status=PENDING_APPROVAL), {},
     dict(stage="spec", status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC), None),
    ("approve_spec", dict(status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC), {"repo": "micron/x"},
     dict(status=APPROVED, stage="architecture", gate=None, sim_step=0, stage2_fired=True), "approved"),
    ("claim_merge", dict(status=APPROVED, stage="review", gate=GATE_APPROVE_MERGE), {},
     dict(gate=None, status=APPROVED), "merge_claimed"),
    ("finish_done", dict(status=APPROVED, stage="review"),
     {"merge_note": "PR merged to main", "deploy_title": "Deployed — test"},
     dict(status=DONE, stage="done", gate=None), None),
    ("send_back", dict(status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC), {"note": "why?"},
     dict(status=SENT_BACK, gate=None, needs_human=False, send_back_question="why?", send_back_rounds=1),
     "sent_back"),
    ("respond", dict(status=SENT_BACK), {"note": "because"},
     dict(status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC, send_back_response="because"), "responded"),
    ("cancel", dict(status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC), {},
     dict(status=CANCELLED, gate=None, needs_human=False), "cancelled"),
    ("retry", dict(status=APPROVED, stage="build", needs_human=True, needs_human_reason="x"),
     {"status": APPROVED, "gate": None},
     dict(needs_human=False, needs_human_reason=None, status=APPROVED, sim_step=0), "retried"),
    ("take_over", dict(status=APPROVED, stage="build", needs_human=True), {},
     dict(status=HUMAN_OWNED, needs_human=False, gate=None), "taken_over"),
    ("send_back_to_stage", dict(status=APPROVED, stage="review", needs_human=True),
     {"stage": "build", "reason": "redo tests"},
     dict(stage="build", status=APPROVED, needs_human=False, sim_step=0), "sent_back_to_stage"),
    ("escalate", dict(status=APPROVED, stage="build"), {"reason": "runner stalled"},
     dict(needs_human=True, needs_human_reason="runner stalled"), None),
    ("raise_merge_gate", dict(status=APPROVED, stage="review"), {},
     dict(gate=GATE_APPROVE_MERGE, status=APPROVED), None),
    ("advance_stage", dict(status=APPROVED, stage="architecture"),
     {"stage": "build", "from_stage": "architecture", "announce": True},
     dict(stage="build", sim_step=0), None),
]


@pytest.mark.parametrize("name,start,params,expected,audit_action",
                         ROW_CASES, ids=[c[0] for c in ROW_CASES])
def test_every_row_wins_from_its_precondition_state(name, start, params, expected, audit_action):
    migrate()
    with SessionLocal() as db:
        req = _request(db, **start)
        res = apply(db, req, name, actor=RILEY, params=params)
        assert isinstance(res, Win), f"{name}: {res}"
        db.commit()
        for col, want in expected.items():
            assert getattr(req, col) == want, f"{name}.{col}"
        if audit_action:
            assert len(_audits(db, req.id, audit_action)) == 1
        res.notify()  # must never raise (no-op when the row has no notification)


def test_table_names_match_and_every_row_guards_composite_state():
    for name, row in TABLE.items():
        assert row.name == name
        pre = row.pre
        assert (pre.status_in or pre.status_not_in or pre.gate is not ANY
                or pre.needs_human is not None), f"{name} has no composite-state guard"


def test_loss_resolves_winner_conflict_and_self_replay():
    migrate()
    with SessionLocal() as db:
        req = _request(db, status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC)
        assert isinstance(apply(db, req, "cancel", actor=RILEY), Win)
        db.commit()
        # a different operator's approve loses with the winner identified
        loser = Actor(name="Morgan Test", operator_id=None)
        res = apply(db, req, "approve_spec", actor=loser, params={"repo": "micron/x"})
        assert isinstance(res, Loss)
        assert res.replay is False
        assert res.winner is not None and res.winner.action == "cancelled"
        assert res.resulting_state == CANCELLED
        assert res.detail == "Cannot approve from status 'cancelled'"
        # the winner replaying their own cancel is idempotent
        res2 = apply(db, req, "cancel", actor=RILEY)
        assert isinstance(res2, Loss) and res2.replay is True
        assert len(_audits(db, req.id, "cancelled")) == 1


def test_loss_with_no_decisive_winner_keeps_the_fallback_detail():
    migrate()
    with SessionLocal() as db:
        req = _request(db, status=DRAFT)  # never acted on
        res = apply(db, req, "retry", actor=RILEY)
        assert isinstance(res, Loss)
        assert res.winner is None
        assert res.detail == "Request is not escalated"


def test_race_pair_cancel_vs_approve_both_orders():
    migrate()
    with SessionLocal() as db:
        # approve first: cancel still wins afterwards (cancelling approved work is legal)
        a = _request(db, status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC)
        assert isinstance(apply(db, a, "approve_spec", actor=RILEY, params={"repo": "r"}), Win)
        db.commit()
        assert isinstance(apply(db, a, "cancel", actor=RILEY), Win)
        db.commit()
        assert a.status == CANCELLED
        # cancel first: approve loses
        b = _request(db, status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC)
        assert isinstance(apply(db, b, "cancel", actor=RILEY), Win)
        db.commit()
        assert isinstance(apply(db, b, "approve_spec", actor=RILEY, params={"repo": "r"}), Loss)


def test_race_pair_retry_vs_stale_escalate(make_elector):
    """After a human Retry, a deposed runner's escalate must be fenced out."""
    migrate()
    elector = make_elector()
    elector.try_acquire()
    stale = elector.epoch
    with SessionLocal() as db:
        req = _request(db, status=APPROVED, stage="build", needs_human=True)
        assert isinstance(
            apply(db, req, "retry", actor=RILEY, params={"status": APPROVED, "gate": None}), Win)
        db.commit()
        elector.release()
        elector.try_acquire()  # new leadership term — `stale` is now behind
        res = apply(db, req, "escalate", actor=FACTORY,
                    params={"reason": "late"}, epoch=stale)
        assert isinstance(res, Loss)
        assert req.needs_human is False
        res2 = apply(db, req, "escalate", actor=FACTORY,
                     params={"reason": "fresh"}, epoch=elector.epoch)
        assert isinstance(res2, Win)
        db.commit()
        assert req.needs_human is True


def test_http_transitions_are_not_epoch_fenced(make_elector):
    """A human Cancel is valid from any replica: epoch=None skips the fence."""
    migrate()
    elector = make_elector()
    elector.try_acquire()
    elector.release()
    elector.try_acquire()  # churn the table epoch
    with SessionLocal() as db:
        req = _request(db, status=PENDING_APPROVAL)
        res = apply(db, req, "cancel", actor=RILEY)  # no epoch passed
        assert isinstance(res, Win)
        db.commit()
        assert req.status == CANCELLED


def test_apply_is_not_durable_until_caller_commits():
    """The regression pin: apply() must never commit internally."""
    migrate()
    with SessionLocal() as db:
        req = _request(db, status=PENDING_APPROVAL)
        rid = req.id
        assert isinstance(apply(db, req, "cancel", actor=RILEY), Win)
        db.rollback()
    with SessionLocal() as db2:
        assert db2.get(Request, rid).status == PENDING_APPROVAL
        assert _audits(db2, rid, "cancelled") == []
        assert _events(db2, rid, "recovery_action") == []


def test_apply_emits_the_rows_events():
    migrate()
    with SessionLocal() as db:
        req = _request(db, status=PENDING_APPROVAL)
        apply(db, req, "cancel", actor=RILEY)
        db.commit()
        evs = _events(db, req.id, "recovery_action")
        assert len(evs) == 1
        assert evs[0].title == "Request cancelled by Riley Test"
        assert evs[0].actor == "Riley Test" and evs[0].bot is False
        assert evs[0].payload == {"Ref": req.ref}


def test_apply_attaches_intent_in_same_transaction():
    migrate()
    with SessionLocal() as db:
        req = _request(db, status=PENDING_APPROVAL)
        key = f"cancel:{req.id}:{uuid.uuid4().hex[:6]}"
        res = apply(db, req, "cancel", actor=RILEY,
                    intent=IntentSpec(key=key, kind="notify_submitter", payload={"why": "test"}))
        assert isinstance(res, Win) and res.intent is not None
        db.commit()
        assert db.get(Intent, key).status == "pending"


def test_win_notify_fires_after_commit(monkeypatch):
    migrate()
    pinged = []
    monkeypatch.setattr("app.notifications.notify_escalation",
                        lambda db, req: pinged.append(req.id))
    with SessionLocal() as db:
        req = _request(db, status=APPROVED, stage="build")
        res = apply(db, req, "escalate", actor=FACTORY, params={"reason": "stall"})
        assert isinstance(res, Win)
        assert pinged == [], "notification must not fire inside apply()"
        db.commit()
        res.notify()
        assert pinged == [req.id]
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd api && uv run pytest tests/test_transitions.py -q`
Expected: FAIL — `ImportError: cannot import name 'TABLE' from 'app.transitions'` (the 4
pre-existing `cas_status` tests still pass if collection is reached; the import error stops
collection, which is the expected red).

- [ ] **Step 3: Implement the module**

Replace the entire contents of `api/app/transitions.py` with (the `cas_status` function is
carried over verbatim at the bottom):

```python
"""Request lifecycle transitions: one declarative table + apply() (spec 2026-07-14 C1, D2-D5).

Every legal move of a Request's composite lifecycle state (status, stage, gate,
needs_human) is a named row in TABLE. apply() executes a row as ONE compare-and-swap
UPDATE whose WHERE carries the row's full composite-state precondition — generalizing
the cas_status pattern below — then, still uncommitted, appends the winner's
AuditEvent, the row's progress events, and an optional intent row. The CALLER owns
the transaction: commit on Win; a Loss has already rolled back. Sessions run
expire_on_commit=False, so apply() refreshes ``req`` after a win — callers read
fresh columns immediately. The claim UPDATE autoflushes pending session state, so a
caller must only hold writes it is prepared to commit (or roll back) with the
transition.

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
    ``req`` must belong to ``db``; it is refreshed on both outcomes.
    """
    row = TABLE[transition]
    params = params or {}
    clauses = _where(req.id, row.pre, params)
    if epoch is not None:  # machine actor — fence against a deposed leader (spec §3.2)
        clauses.append(
            select(LeaderEpoch.id)
            .where(LeaderEpoch.id == 1, LeaderEpoch.epoch == epoch)
            .exists()
        )
    claimed = db.execute(update(Request).where(*clauses).values(**row.effects(params))).rowcount
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
```

Note the `notify` closure inside `apply()`: it deliberately shadows nothing and binds
`db`/`req` so `Win.notify()` works after the caller's commit (the session is still open —
same lifetime the pre-refactor `notify_gate_raised(db, r)` calls relied on).

- [ ] **Step 4: Run the transitions tests to verify they pass**

Run: `cd api && uv run pytest tests/test_transitions.py -q`
Expected: PASS — 4 pre-existing + 14 parametrized + 10 new = `28 passed`.

- [ ] **Step 5: Run the full suite and lint (nothing else changed — must stay green)**

Run: `cd api && uv run pytest -q && uv run ruff check .`
Expected: `all tests passed` (0 failures) and `All checks passed!`

- [ ] **Step 6: Commit**

```bash
git add api/app/transitions.py api/tests/test_transitions.py
git commit -m "feat(api): declarative lifecycle transition table + apply() in transitions.py

One CAS UPDATE per named transition over (status, stage, gate, needs_human),
audit + events + optional intent in the same caller-owned transaction; HTTP
transitions are human-raced (no epoch), machine transitions are epoch-fenced.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: gates.py — all seven endpoints through `apply()`

**Files:**
- Modify: `api/app/api_helpers.py` (add `conflict_response`)
- Modify: `api/app/routers/gates.py` (full rewrite of the endpoint bodies; delete `_resolve_cas_loss` and `DECISIVE_ACTIONS`)
- Test: existing `api/tests/test_conflict_safe_actions.py`, `api/tests/test_scoped_recovery.py`, `api/tests/test_hardening.py` (UNCHANGED — they are the harness, per D7)

**Interfaces:**
- Consumes: everything Task 1 produces (`apply`, `Actor`, `Loss`, `resolve_loss`, constants).
- Produces: `api_helpers.conflict_response(r, loss) -> RequestDetail | JSONResponse` (raises `HTTPException(409)` when no winner exists) — Task 3 reuses nothing from here; gates endpoints keep their routes and response models exactly.

- [ ] **Step 1: Green baseline (the refactor's "red" is any regression from this)**

Run: `cd api && uv run pytest tests/test_conflict_safe_actions.py tests/test_scoped_recovery.py tests/test_hardening.py -q`
Expected: PASS (record the count — it must be identical after the refactor).

- [ ] **Step 2: Add `conflict_response` to api_helpers**

In `api/app/api_helpers.py`, extend the imports:

```python
from fastapi import HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from .models import Request
from .schemas import ConflictOut, RequestDetail, RequestOut
```

(`HTTPException`, `Session`, `Request`, `RequestOut` are already imported — only add
`JSONResponse`, `ConflictOut`, `RequestDetail`.) Then add below `to_out`:

```python
def conflict_response(r: Request, loss) -> RequestDetail | JSONResponse:
    """Map a transitions.Loss to ADR 0006 HTTP semantics: the winner's own replay
    is an idempotent 200; a known other winner is a structured ConflictOut 409;
    a consumed precondition with no decisive winner is a plain 409."""
    if loss.replay:
        return to_out(r, RequestDetail)
    if loss.winner is None:
        raise HTTPException(409, loss.detail)
    conflict = ConflictOut(
        detail=f"Already acted on by {loss.winner.actor}",
        acted_by=loss.winner.actor,
        acted_at=loss.winner.created_at,
        resulting_state=loss.resulting_state,
    )
    return JSONResponse(status_code=409, content=conflict.model_dump(mode="json"))
```

- [ ] **Step 3: Rewrite gates.py**

Replace the entire contents of `api/app/routers/gates.py` with:

```python
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
        if runner_mode() == "agent":
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
    retry_status = transitions.PENDING_APPROVAL if r.stage == "spec" else transitions.APPROVED
    retry_gate = transitions.GATE_APPROVE_SPEC if r.stage == "spec" else r.gate
    res = transitions.apply(db, r, "retry", actor=actor,
                            params={"status": retry_status, "gate": retry_gate, "note": body.note})
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
```

Notes for the implementer:
- `DECISIVE_ACTIONS` and `_resolve_cas_loss` are GONE from this file (they live in
  `transitions.py` now — `resolve_loss` is the surviving name). Nothing else imports
  either (verified by grep at planning time).
- The pre-refactor approve endpoint committed the spec claim in three steps
  (`repo_ready` commit, `spec_pr_open` commit, event commit). D2 collapses them into one
  transaction — the flags still exist and still guard replays; no test observes the
  intermediate commits (single-threaded test client).
- `retry` still computes `retry_status`/`retry_gate` from the CURRENT row before the claim,
  exactly as before.

- [ ] **Step 4: Run the harness suites**

Run: `cd api && uv run pytest tests/test_conflict_safe_actions.py tests/test_scoped_recovery.py tests/test_hardening.py tests/test_transitions.py -q`
Expected: PASS, same count as the Step 1 baseline plus the 28 transitions tests.

- [ ] **Step 5: Full suite + lint**

Run: `cd api && uv run pytest -q && uv run ruff check .`
Expected: all passed; `All checks passed!`

- [ ] **Step 6: Commit**

```bash
git add api/app/api_helpers.py api/app/routers/gates.py
git commit -m "refactor(api): gates endpoints go through transitions.apply()

_resolve_cas_loss + DECISIVE_ACTIONS collapse into apply()'s Loss path;
approve's three-step ledger commits collapse into one transaction (D2).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: requests.py — submit claim + spec-gate raise + constants

**Files:**
- Modify: `api/app/routers/requests.py` (functions `create_request`, `update_request`, `request_detail`, `submit`; imports)
- Test: existing `api/tests/test_api.py`, `api/tests/test_hardening.py`, `api/tests/test_email_and_freshness.py` (UNCHANGED)

**Interfaces:**
- Consumes: `transitions.apply`, `transitions.Actor`, `transitions.Loss`, constants `DRAFT, SUBMITTED, PRE_APPROVAL` and transition names `submit_claim`, `raise_spec_gate` (Task 1).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Green baseline**

Run: `cd api && uv run pytest tests/test_api.py tests/test_hardening.py tests/test_email_and_freshness.py -q`
Expected: PASS.

- [ ] **Step 2: Edit imports**

In `api/app/routers/requests.py`:
- Add `from .. import transitions` to the `from .. import interview_gen, prototype_gen, settings, summary_gen` line → `from .. import interview_gen, prototype_gen, settings, summary_gen, transitions`.
- Remove `update` from `from sqlalchemy import func, update` → `from sqlalchemy import func`.
- Remove the now-unused `from ..notifications import notify_gate_raised` line and `utcnow` from the models import → `from ..models import AuditEvent, InterviewTurn, ProgressEvent, PrototypeTurn, Request` (keep `utcnow` ONLY if something else in the file still uses it — grep the file; at planning time `submit` was the only user, so it goes).

- [ ] **Step 3: Replace `create_request`**

```python
@router.post("/api/requests", response_model=RequestDetail, status_code=201)
def create_request(body: RequestCreate, db: Session = Depends(get_db)):
    # persist-first (PRD hardening #4): the Request exists before anything else
    for attempt in (0, 1):
        r = Request(
            ref=next_ref(db), title=body.title or "(untitled request)", description=body.description,
            type=body.type, urgency=body.urgency, reach=body.reach,
            impact_metric=body.impact_metric, impact_value=body.impact_value, app_id=body.app_id,
            new_app_name=body.new_app_name, bug_where=body.bug_where,
            status=transitions.DRAFT, stage="intake",
            reporter=body.reporter, reporter_initials=body.reporter_initials,
        )
        db.add(r)
        try:
            db.commit()
            break
        except IntegrityError:  # a concurrent create raced us to the same ref — once is forgivable
            db.rollback()
            if attempt:
                raise
    return to_out(r, RequestDetail)
```

(Creation is an INSERT, not a Transition — the request has no prior lifecycle state to
CAS against. Only the constant changes.)

- [ ] **Step 4: Replace `update_request`'s guard line**

In `update_request`, change:

```python
    if r.status not in ("draft", "submitted"):
        raise HTTPException(409, "Request can no longer be edited")
```

to:

```python
    if r.status not in (transitions.DRAFT, transitions.SUBMITTED):
        raise HTTPException(409, "Request can no longer be edited")
```

- [ ] **Step 5: Replace `request_detail`'s duplicate-hint guard line**

In `request_detail`, change:

```python
    if r.app_id and r.status in ("draft", "submitted", "pending_approval", "sent_back"):
```

to:

```python
    if r.app_id and r.status in transitions.PRE_APPROVAL:
```

- [ ] **Step 6: Replace `submit`**

```python
@router.post("/api/requests/{rid}/submit", response_model=RequestDetail)
def submit(rid: int, extra: Note | None = None, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    if r.status not in (transitions.DRAFT, transitions.SUBMITTED):
        return to_out(r, RequestDetail)  # idempotent
    # atomic claim (mirrors approve), committed BEFORE the brain runs: of two
    # concurrent submits exactly one drafts the spec — the loser replays
    # idempotently. Committing first also means the write lock is never held
    # across a (possibly slow) brain call.
    reporter = transitions.Actor(name=r.reporter)
    res = transitions.apply(db, r, "submit_claim", actor=reporter)
    if isinstance(res, transitions.Loss):
        return to_out(r, RequestDetail)
    db.commit()
    try:
        if extra and extra.note:
            r.extra_detail = extra.note
        emit(db, r, "milestone_summary", f"New request filed in #{r.app_name}",
             payload={"fields": {"Type": r.type, "From": r.reporter, "Stage": "Triage"},
                      "context": f"Intake interview completed · {len(r.turns)} answers", "Ref": r.ref})
        db.add(AuditEvent(request_id=r.id, actor=r.reporter, action="submitted",
                          note="filed this request and completed intake"))
        # Stage 1 brain writes the grounded Draft spec, then the spec gate is raised
        lines, note = get_brain().draft_spec(r)
        db.add_all(lines)
        r.spec_open_note = note
        gate = transitions.apply(db, r, "raise_spec_gate", actor=reporter)
        if isinstance(gate, transitions.Loss):
            return to_out(r, RequestDetail)  # a Cancel raced the brain — it wins, spec discarded
        db.commit()
        gate.notify()
    except Exception:
        db.rollback()
        r.status = transitions.DRAFT  # hand the claim back — a failed brain must not strand the request
        db.commit()
        raise
    return to_out(r, RequestDetail)
```

Behavior notes (pin these when reviewing):
- The pre-refactor code briefly assigned `r.status = "submitted"` inside the try block; the
  value never reached the DB (it was overwritten to `pending_approval` before the commit)
  and nothing read it — it is dropped.
- `raise_spec_gate`'s event, gate columns, and `notify_gate_raised` are table-owned now; the
  notification fires AFTER the commit exactly as before.
- The `raise_spec_gate` Loss branch is new hardening: previously a Cancel racing the brain
  call was silently clobbered back to `pending_approval`. No existing test reaches it
  (single-threaded client); the conservative choice is to let the Cancel win.

- [ ] **Step 7: Run the suites**

Run: `cd api && uv run pytest tests/test_api.py tests/test_hardening.py tests/test_email_and_freshness.py -q`
Expected: PASS — including `test_spec_gate_emails_exactly_subscribed_operators_with_dossier_link`.

- [ ] **Step 8: Full suite + lint**

Run: `cd api && uv run pytest -q && uv run ruff check .`
Expected: all passed; `All checks passed!`

- [ ] **Step 9: Commit**

```bash
git add api/app/routers/requests.py
git commit -m "refactor(api): submit goes through transitions.apply(); intake status constants

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: simulator.py — tick transitions through `apply()` (epoch-fenced)

**Files:**
- Modify: `api/app/simulator.py` (full rewrite below)
- Test: existing `api/tests/test_supervision.py`, `api/tests/test_hardening.py`, `api/tests/test_email_and_freshness.py`, `api/tests/test_conflict_safe_actions.py` (UNCHANGED)

**Interfaces:**
- Consumes: `transitions.apply/Win/Loss/FACTORY/Actor/GATE_APPROVE_MERGE`, transition names `advance_stage`, `raise_merge_gate`, `escalate`, `finish_done`; `leader.get_elector` (epoch source).
- Produces: `simulator.approve_merge(db, req, actor: str)` and `simulator.tick(db)` keep their exact signatures (gates.py and main.py call them).

- [ ] **Step 1: Green baseline**

Run: `cd api && uv run pytest tests/test_supervision.py tests/test_hardening.py tests/test_email_and_freshness.py -q`
Expected: PASS.

- [ ] **Step 2: Rewrite simulator.py**

Replace the entire contents of `api/app/simulator.py` with:

```python
"""Factory simulator — stands in for the Stage 2–6 CI agents.

Each tick advances every in-flight (approved) Work item one STEP through a
deterministic per-stage plan, emitting a step_summary (the trace heartbeat
the supervision UI reads) plus the same milestone summaries / gate events
the real agents would post as PR comments (ADR 0004, ADR 0014).
The Review→Done boundary is a human gate (approve_merge) — the simulator
emits its verification report, raises the gate, and waits for an Admin.

Lifecycle writes go through transitions.apply() as MACHINE transitions:
epoch-fenced, so a deposed leader's tick quietly loses (spec §3.2).
"""
import logging
from typing import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import transitions, verification
from .events import emit
from .leader import get_elector
from .models import PIPELINE_STAGES, STEP_PLANS, Request
from .supervision import pending_steer_notes
from .transitions import FACTORY, GATE_APPROVE_MERGE

log = logging.getLogger("factory.simulator")

# Legacy milestone summaries (feed content) — unchanged text, now fired at a
# fixed checkpoint: MILESTONE_AFTER[stage][sim_step reached] = script index.
STAGE_SCRIPTS: dict[str, list[tuple[str, dict]]] = {
    "architecture": [
        ("Architecture plan drafted — PLAN.md committed", {"Artifacts": "PLAN.md", "ADRs": "2 drafted"}),
        ("ADRs signed; plan validated against SPEC.md", {"Gate": "Sign ADRs · passed", "Next": "Test authoring"}),
    ],
    "build": [
        ("RED: 8 failing tests authored — fail for the right reason", {"Tests": "8 added, 8 failing", "Gate": "RED · passed"}),
        ("GREEN: all tests pass; implementer touched no test files", {"Tests": "8/8 passing", "Gate": "Test-isolation · passed"}),
    ],
    "review": [
        ("Review report posted — no blocking findings", {"Findings": "0 blocking · 2 nits", "Diff": "+412 −38"}),
    ],
}
MILESTONE_AFTER: dict[str, dict[int, int]] = {
    "architecture": {2: 0, 4: 1},
    "build": {3: 0, 6: 1},
    "review": {3: 0},
}
for _s in PIPELINE_STAGES:
    assert set(MILESTONE_AFTER[_s]) <= set(range(1, len(STEP_PLANS[_s]) + 1))
    assert all(i < len(STAGE_SCRIPTS[_s]) for i in MILESTONE_AFTER[_s].values())


def emit_verification(db: Session, req: Request) -> None:
    """The evidence the merge gate renders (spec §5) — fabricated by the sim
    matching the numbers its review script reports. Delegates to the single
    source of truth (verification.py): ws=None → the fabricated payload."""
    verification.emit_verification(db, req)


def _tick_request(db: Session, req: Request, moved: list[str],
                  after_commit: list[Callable[[], None]]) -> None:
    plan = STEP_PLANS[req.stage]
    step = req.sim_step
    if req.stage == "review" and step >= len(plan):
        # verification report, then raise the merge gate once, then wait for a human
        if req.gate != GATE_APPROVE_MERGE:
            emit_verification(db, req)
            res = transitions.apply(db, req, "raise_merge_gate", actor=FACTORY,
                                    epoch=get_elector().epoch)
            if isinstance(res, transitions.Win):
                moved.append(f"{req.ref}: merge gate raised")
                after_commit.append(res.notify)
        return
    if step < len(plan):
        label, why = plan[step]
        payload = {"step": step + 1, "of": len(plan), "label": label,
                   "why": why, "Ref": req.ref}
        notes = pending_steer_notes(db, req)
        if notes:
            payload["acked_steer_ids"] = [n.id for n in notes]
            payload["why"] = f"{why} — honoring note: {notes[-1].body[:80]}"
        emit(db, req, "step_summary", f"{label} ({step + 1}/{len(plan)})",
             payload=payload)
        req.sim_step += 1
        moved.append(f"{req.ref}: {req.stage} · {label}")
        mi = MILESTONE_AFTER[req.stage].get(req.sim_step)
        if mi is not None:
            title, fields = STAGE_SCRIPTS[req.stage][mi]
            emit(db, req, "milestone_summary", title,
                 payload={"fields": fields, "Ref": req.ref})
    if req.sim_step >= len(plan) and req.stage != "review":
        nxt = {"architecture": "build", "build": "review"}[req.stage]
        res = transitions.apply(db, req, "advance_stage", actor=FACTORY,
                                params={"stage": nxt, "from_stage": req.stage, "announce": True},
                                epoch=get_elector().epoch)
        if isinstance(res, transitions.Win):
            moved.append(f"{req.ref}: advanced to {nxt}")


def _escalate(db: Session, req: Request, reason: str) -> None:
    db.rollback()
    res = transitions.apply(db, req, "escalate", actor=FACTORY,
                            params={"reason": reason}, epoch=get_elector().epoch)
    if isinstance(res, transitions.Loss):
        return  # closed (or fenced) meanwhile — nothing to flag
    db.commit()
    res.notify()


def tick(db: Session) -> list[str]:
    """Advance each in-flight item; one broken simulation stalls only that item."""
    moved: list[str] = []
    items = db.scalars(
        select(Request)
        .where(Request.status == transitions.APPROVED, Request.needs_human.is_(False))
        .where(Request.stage.in_(PIPELINE_STAGES))
        .order_by(Request.id)
    ).all()
    for req in items:
        item_moved: list[str] = []
        after_commit: list[Callable[[], None]] = []
        try:
            _tick_request(db, req, item_moved, after_commit)
            db.commit()
            for notify in after_commit:  # emails only after the gate state is durable
                notify()
            moved.extend(item_moved)
        except Exception as exc:
            log.exception("simulator stalled for %s", req.ref)
            _escalate(db, req, f"Simulator stalled: {exc}")
            moved.append(f"{req.ref}: escalated — simulator stalled")
    return moved


def approve_merge(db: Session, req: Request, actor: str) -> None:
    """The Stage 5/6 human gate: merge + deploy promotion (one protected-branch idea, ADR 0005).

    HTTP-initiated (called from the approve endpoint after claim_merge): no epoch.
    A Loss means the request closed between the claim and here — the endpoint
    records merge_approval_failed; nothing to do."""
    transitions.apply(db, req, "finish_done", actor=transitions.Actor(name=actor),
                      params={"merge_note": "PR merged to main",
                              "deploy_title": "Deployed — production promotion merged"})
```

Behavior notes:
- The merge-gate email (`notify_gate_raised`) used to fire INSIDE `_tick_request`, before
  the tick's commit. It now fires via `Win.notify()` after the commit — same recipients,
  same single send, but an email can no longer announce a gate that a failed commit rolled
  back. Log this under `## Deviations` in `implementation-notes.md` (deliberate, plan-approved).
- The stage-advance milestone ("Stage advanced — now in Build") is table-owned, gated by
  `announce=True` — only the simulator announces; the AgentRunner (Task 5) advances silently,
  exactly as before.

- [ ] **Step 3: Run the suites**

Run: `cd api && uv run pytest tests/test_supervision.py tests/test_hardening.py tests/test_email_and_freshness.py tests/test_conflict_safe_actions.py -q`
Expected: PASS — including `test_merge_gate_emails_subscribers_but_done_and_healthy_steps_do_not`, `test_simulator_failure_escalates_and_emails_subscribers`, `test_stage_clock_advances_with_stages`, `test_tick_ignores_cancelled_items`.

- [ ] **Step 4: Full suite + lint**

Run: `cd api && uv run pytest -q && uv run ruff check .`
Expected: all passed; `All checks passed!`

- [ ] **Step 5: Commit**

```bash
git add api/app/simulator.py
git commit -m "refactor(api): simulator tick drives lifecycle through epoch-fenced apply()

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: agent_runner.py + startup.py through `apply()`; delete lifecycle.py

**Files:**
- Modify: `api/app/agent_runner.py`
- Modify: `api/app/startup.py`
- Delete: `api/app/lifecycle.py`
- Test: existing `api/tests/test_agent_runner.py`, `api/tests/test_email_and_freshness.py` (UNCHANGED)

**Interfaces:**
- Consumes: `transitions.apply/Win/Loss/FACTORY/Actor`, names `advance_stage`, `escalate`, `raise_merge_gate`, `finish_done`; `leader.get_elector`.
- Produces: `AgentRunner._escalate(db, req, reason)` keeps its exact signature (test_email_and_freshness calls it directly). `AgentRunner._advance` changes return type `None -> bool` (internal only; grep confirmed no external caller).

- [ ] **Step 1: Green baseline**

Run: `cd api && uv run pytest tests/test_agent_runner.py tests/test_email_and_freshness.py -q`
Expected: PASS.

- [ ] **Step 2: Edit agent_runner.py imports**

Change:

```python
from . import lifecycle, settings
```

to:

```python
from . import settings, transitions
from .leader import get_elector
from .transitions import FACTORY
```

(keep every other import line as-is; ruff `I` will confirm ordering — `from .leader import get_elector` sorts between `.events` and `.models` imports, and `.transitions` after `.supervision`.)

- [ ] **Step 3: Replace `_advance` and `_escalate`**

```python
    def _advance(self, db: Session, req: Request, stage: str) -> bool:
        """Machine transition: epoch-fenced so a deposed leader's thread stops here."""
        res = transitions.apply(db, req, "advance_stage", actor=FACTORY,
                                params={"stage": stage}, epoch=get_elector().epoch)
        if isinstance(res, transitions.Loss):
            log.info("%s: advance to %s lost (%s) — pipeline stops", req.ref, stage, res.detail)
            return False
        db.commit()
        return True

    def _escalate(self, db: Session, req: Request, reason: str) -> None:
        res = transitions.apply(db, req, "escalate", actor=FACTORY,
                                params={"reason": reason}, epoch=get_elector().epoch)
        if isinstance(res, transitions.Loss):  # a Cancel raced us — it wins, nothing to flag
            log.info("escalation for %s dropped — request is %s", req.ref, req.status)
            return
        db.commit()
        res.notify()
        log.error("escalated %s: %s", req.ref, reason)
```

- [ ] **Step 4: Update the three `_advance` call sites**

In `_architecture`, change `self._advance(db, req, "architecture")` (first line of the method
body) to:

```python
        if not self._advance(db, req, "architecture"):
            return False
```

In `_red`, change `self._advance(db, req, "build")` to:

```python
        if not self._advance(db, req, "build"):
            return False
```

In `_review`, change `self._advance(db, req, "review")` to:

```python
        if not self._advance(db, req, "review"):
            return False
```

- [ ] **Step 5: Replace the `_review` tail (gate raise)**

Change the last lines of `_review` from:

```python
        emit_verification(db, req, ws, payload=vpayload)
        lifecycle.raise_merge_gate(db, req)
        db.commit()
        log.info("%s: review committed, verification emitted, merge gate raised", req.ref)
        return True
```

to:

```python
        emit_verification(db, req, ws, payload=vpayload)
        res = transitions.apply(db, req, "raise_merge_gate", actor=FACTORY,
                                epoch=get_elector().epoch)
        if isinstance(res, transitions.Loss):
            log.info("%s: merge gate raise lost (%s)", req.ref, res.detail)
            return False
        db.commit()
        res.notify()
        log.info("%s: review committed, verification emitted, merge gate raised", req.ref)
        return True
```

- [ ] **Step 6: Replace the `approve_merge` tail**

Change the last lines of `AgentRunner.approve_merge` from:

```python
        lifecycle.finish_done(db, req, actor,
                              merge_note="work branch merged to main",
                              deploy_title="Deployed — main updated in the Subject workspace",
                              payload_extra={"merged": True, "workspace": str(ws)})
        db.commit()
        log.info("%s merged to main by %s", req.ref, actor)
```

to:

```python
        res = transitions.apply(db, req, "finish_done", actor=transitions.Actor(name=actor),
                                params={"merge_note": "work branch merged to main",
                                        "deploy_title": "Deployed — main updated in the Subject workspace",
                                        "payload_extra": {"merged": True, "workspace": str(ws)}})
        if isinstance(res, transitions.Loss):  # closed between claim and merge — endpoint records the failure
            log.info("%s: finish_done lost (%s)", req.ref, res.detail)
            return
        db.commit()
        log.info("%s merged to main by %s", req.ref, actor)
```

(`finish_done` here is HUMAN-initiated — it runs inside the approve endpoint's request — so
no epoch, per the fencing policy.)

- [ ] **Step 7: Rewrite startup.py's escalate_orphans**

Replace the entire contents of `api/app/startup.py` with:

```python
"""One-shot startup chores — called from the lifespan in main.py, one named
function per concern so the boot sequence reads as a table of contents."""
import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

from . import transitions
from .db import engine
from .leader import get_elector
from .models import PIPELINE_STAGES, Comment, ProgressEvent, Request

log = logging.getLogger("factory")


def backfill_stage_clock() -> None:
    """stage_entered_at arrived after the first DBs shipped — derive it once."""
    with engine.connect() as conn:
        conn.execute(text("UPDATE requests SET stage_entered_at = updated_at WHERE stage_entered_at IS NULL"))
        conn.commit()


def backfill_comment_events(db: Session) -> None:
    """One-time backfill: comments ride the progress_event log (ADR 0012)."""
    if db.query(ProgressEvent).filter(ProgressEvent.kind == "comment").count():
        return
    for c in db.query(Comment).all():
        db.add(ProgressEvent(
            request_id=c.request_id, subject_id=c.request.app_id, kind="comment",
            stage=c.request.stage, actor=c.author, bot=False, broadcast=False,
            title=c.body[:300],
            payload={"comment_id": c.id, "initials": c.initials, "color": c.color, "body": c.body},
            created_at=c.created_at,
        ))
    db.commit()


def escalate_orphans(db: Session) -> None:
    """A restart kills the pipeline worker threads; anything left mid-stage is
    orphaned — escalate it so it is VISIBLE and Retry can re-drive it
    (stop + flag, never auto-rerun: CONTEXT.md escalation, ADR 0013).
    Runs right after this process acquired leadership, so the epoch is ours."""
    epoch = get_elector().epoch
    orphans = db.query(Request).filter(
        Request.status == transitions.APPROVED, Request.needs_human.is_(False),
        Request.gate.is_(None), Request.stage.in_(PIPELINE_STAGES),
    ).all()
    for r in orphans:
        res = transitions.apply(
            db, r, "escalate", actor=transitions.FACTORY,
            params={"reason": "Pipeline orphaned by a server restart — Retry re-runs the stage"},
            epoch=epoch,
        )
        if isinstance(res, transitions.Loss):
            continue
        db.commit()
        res.notify()
        log.warning("startup: %s was orphaned mid-%s — escalated for Retry", r.ref, r.stage)
```

- [ ] **Step 8: Delete lifecycle.py and verify nothing imports it**

```bash
rm api/app/lifecycle.py
grep -rn "lifecycle" api/app api/tests --include="*.py"
```

Expected: the grep returns ONLY prose matches (docstrings in `summary_gen.py`,
`interview_gen.py`, `prototype_gen.py` mention "smoke lifecycle" — those are comments, not
imports). Zero `import lifecycle` / `from . import lifecycle` / `lifecycle.` call sites.

- [ ] **Step 9: Run the suites**

Run: `cd api && uv run pytest tests/test_agent_runner.py tests/test_email_and_freshness.py tests/test_escalation.py -q`
Expected: PASS — including `test_escalation_emails_subscribers` (which calls
`AgentRunner()._escalate` directly: the in-process elector holds the current epoch under the
`client` fixture, so the fenced escalate wins and the email sends post-commit).

- [ ] **Step 10: Full suite + lint**

Run: `cd api && uv run pytest -q && uv run ruff check .`
Expected: all passed; `All checks passed!`

- [ ] **Step 11: Commit**

```bash
git add -A api/app/agent_runner.py api/app/startup.py api/app/lifecycle.py
git commit -m "refactor(api): AgentRunner + startup rescue through apply(); delete lifecycle.py

Its 3 functions are table rows now: escalate, raise_merge_gate, finish_done (D4).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `supervision.classify()` + adoption (mission, inbox, detail)

**Files:**
- Modify: `api/app/supervision.py` (add `classify`; rewrite `in_flight` to derive from it)
- Modify: `api/app/routers/mission.py`
- Modify: `api/app/routers/events.py` (the `inbox` endpoint only)
- Create: `api/tests/test_classify_phases.py`
- Test: existing `api/tests/test_supervision.py`, `api/tests/test_scoped_recovery.py` (UNCHANGED)

**Interfaces:**
- Consumes: `transitions` constants (`APPROVED, HUMAN_OWNED, CLOSED`), `PIPELINE_STAGES`.
- Produces: `supervision.classify(r: Request) -> dict` with keys `phase` (one of `"closed" | "human_owned" | "stalled" | "at_gate" | "in_flight" | "intake"`), `at_gate: bool`, `in_flight: bool`, `stalled: bool`. `in_flight(r)` keeps its signature (steer endpoint and `run_state` use it).

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_classify_phases.py`:

```python
"""classify(): the one derivation of a Request's supervision phase (spec D6)."""

from app import transitions as t
from app.models import Request
from app.supervision import classify, in_flight


def _req(**kw):
    base = dict(ref="REQ-1", title="x", type="enh",
                status=t.APPROVED, stage="build", gate=None, needs_human=False)
    base.update(kw)
    return Request(**base)


def test_in_flight_phase():
    c = classify(_req())
    assert c == {"phase": "in_flight", "at_gate": False, "in_flight": True, "stalled": False}
    assert in_flight(_req()) is True


def test_at_gate_phase():
    c = classify(_req(status=t.PENDING_APPROVAL, stage="spec", gate=t.GATE_APPROVE_SPEC))
    assert c["phase"] == "at_gate" and c["at_gate"] is True and c["in_flight"] is False
    c = classify(_req(stage="review", gate=t.GATE_APPROVE_MERGE))
    assert c["phase"] == "at_gate"
    assert in_flight(_req(stage="review", gate=t.GATE_APPROVE_MERGE)) is False


def test_stalled_beats_gate():
    c = classify(_req(needs_human=True, gate=t.GATE_APPROVE_SPEC, status=t.PENDING_APPROVAL))
    assert c["phase"] == "stalled" and c["stalled"] is True and c["at_gate"] is False


def test_human_owned_phase_keeps_the_stalled_flag_independent():
    c = classify(_req(status=t.HUMAN_OWNED))
    assert c["phase"] == "human_owned" and c["in_flight"] is False
    c = classify(_req(status=t.HUMAN_OWNED, needs_human=True))
    assert c["phase"] == "human_owned" and c["stalled"] is True  # bands read flags, not phase


def test_closed_phases():
    assert classify(_req(status=t.DONE, stage="done"))["phase"] == "closed"
    assert classify(_req(status=t.CANCELLED))["phase"] == "closed"


def test_intake_phase():
    c = classify(_req(status=t.DRAFT, stage="intake"))
    assert c == {"phase": "intake", "at_gate": False, "in_flight": False, "stalled": False}
    assert classify(_req(status=t.SENT_BACK, stage="spec"))["phase"] == "intake"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && uv run pytest tests/test_classify_phases.py -q`
Expected: FAIL — `ImportError: cannot import name 'classify' from 'app.supervision'`.

- [ ] **Step 3: Implement classify in supervision.py**

In `api/app/supervision.py`, add to the imports:

```python
from . import settings, transitions
```

(replacing `from . import settings`). Then replace the existing `in_flight` function with:

```python
def classify(r: Request) -> dict:
    """The ONE derivation of a Request's supervision phase from its composite
    lifecycle state (spec 2026-07-14 D6) — the read-side twin of transitions.TABLE.
    phase: closed | human_owned | stalled | at_gate | in_flight | intake.
    The flags are independent of phase precedence (mission bands read the flags)."""
    stalled = bool(r.needs_human)
    at_gate = r.gate is not None and not stalled
    flight = (r.status == transitions.APPROVED and r.stage in PIPELINE_STAGES
              and not stalled and r.gate is None)
    if r.status in transitions.CLOSED:
        phase = "closed"
    elif r.status == transitions.HUMAN_OWNED:
        phase = "human_owned"
    elif stalled:
        phase = "stalled"
    elif at_gate:
        phase = "at_gate"
    elif flight:
        phase = "in_flight"
    else:
        phase = "intake"
    return {"phase": phase, "at_gate": at_gate, "in_flight": flight, "stalled": stalled}


def in_flight(r: Request) -> bool:
    """Running autonomously right now: approved, in a pipeline stage, not
    parked at a gate, not escalated. Derived from classify()."""
    return classify(r)["in_flight"]
```

(The `request_detail` endpoint and the steer 409 guard adopt classify transitively — they
already call `run_state`/`in_flight`, which now derive from it.)

- [ ] **Step 4: Run the classify tests**

Run: `cd api && uv run pytest tests/test_classify_phases.py tests/test_supervision.py -q`
Expected: PASS.

- [ ] **Step 5: Adopt classify in mission.py**

Replace the entire contents of `api/app/routers/mission.py` with:

```python
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
    RunStateOut,
    SteerStateOut,
)
from ..supervision import classify, evidence, run_state, steer_state

router = APIRouter()


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
        cursor=cursor,
    )
```

(The module-level `CLOSED = ("cancelled", "done")` tuple is gone — `transitions.CLOSED` is
the one definition. Band membership is unchanged: `at_gate` ≡ the old
`r.gate and not r.needs_human`; `stalled` ≡ the old `r.needs_human`; `human_owned` phase ≡
the old `r.status == "human_owned"` given the closed filter.)

- [ ] **Step 6: Adopt classify in the inbox endpoint**

In `api/app/routers/events.py`, add the imports:

```python
from .. import transitions
from ..supervision import classify
```

(merge into the existing `from ..` import block, isort-ordered), then replace the `inbox`
endpoint (currently the last function, ~lines 139–148) with:

```python
@router.get("/api/inbox", response_model=list[RequestOut])
def inbox(db: Session = Depends(get_db)):
    # classify() is the source of truth for "needs a human"; the SQL clauses are
    # its index-friendly prefilter (identical set — pinned by the Python filter).
    rows = (
        db.query(Request)
        .filter(or_(Request.gate.isnot(None), Request.needs_human.is_(True)))
        .filter(Request.status.notin_(transitions.CLOSED))  # a stale gate never resurrects dead work
        .order_by(Request.needs_human.desc(), Request.created_at.desc())
        .all()
    )
    return [to_out(r) for r in rows if (c := classify(r))["at_gate"] or c["stalled"]]
```

- [ ] **Step 7: Run the adoption suites**

Run: `cd api && uv run pytest tests/test_supervision.py tests/test_scoped_recovery.py tests/test_hardening.py tests/test_api.py -q`
Expected: PASS — including `test_mission_aggregate`, `test_take_over_wins_stops_tick_and_remains_visible_on_floor`, `test_cancel_clears_gate_and_leaves_inbox`.

- [ ] **Step 8: Full suite + lint**

Run: `cd api && uv run pytest -q && uv run ruff check .`
Expected: all passed; `All checks passed!`

- [ ] **Step 9: Commit**

```bash
git add api/app/supervision.py api/app/routers/mission.py api/app/routers/events.py api/tests/test_classify_phases.py
git commit -m "feat(api): supervision.classify() — one phase derivation; mission/inbox adopt it

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: CONTEXT.md "Transition" term + final full verify

**Files:**
- Modify: `CONTEXT.md` (Language section)

- [ ] **Step 1: Add the term (D8)**

In `CONTEXT.md`, in the `## Language` section, insert the following block immediately AFTER
the **Gate** entry (the block ending `_Avoid_: approval (only one kind of gate), check (too
generic).`) and before **Merge gate**:

```markdown
**Transition**:
A named, table-declared move of a Request's lifecycle state — the composite
`(status, stage, gate, needs_human)` — applied atomically with its audit and event
record via `transitions.apply()`; the only legal way to mutate lifecycle columns.
Human-initiated Transitions are raced by their state precondition; machine-initiated
ones (tick loop, pipeline threads) are additionally fenced by the leader epoch.
_Avoid_: status change, state update (ad-hoc ORM writes are exactly what this term forbids).
```

- [ ] **Step 2: Full repo verify**

Run from the repo root (Node 24.15.0 active per `.nvmrc`):

```bash
task verify
```

Expected output ends with:

```
✓ VERIFY PASSED — tests, build, and smoke all green
```

(If a frontend test fails, it is unrelated to this backend-only branch — investigate before
proceeding, do not skip; the smoke test drives the full submit → approve → tick → merge
lifecycle through the refactored transitions and MUST be green.)

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md
git commit -m "docs: add the Transition term to CONTEXT.md (D8)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Update implementation-notes.md**

Append a short entry to `implementation-notes.md` (repo root): branch name, the seven
commits, verify result, and any `## Deviations` entries accumulated during execution (at
minimum the notify-after-commit ordering note from Task 4 if not already logged).

```bash
git add implementation-notes.md
git commit -m "docs: implementation notes for the lifecycle-transitions branch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Design decisions locked by this plan (do not re-litigate during execution)

1. **Epoch fencing (the leadership note):** `apply(epoch=None)` for every HTTP endpoint
   (human-raced by the composite precondition; valid on any replica — a standby's
   `get_elector().epoch` is 0/stale and would wrongly fence out operators).
   `apply(epoch=get_elector().epoch)` for the tick loop, pipeline threads, and startup
   rescue (machine-raced against a deposed leader). `/api/simulator/tick` inherits the
   in-process elector's epoch — on a standby it correctly no-ops.
2. **Notifications:** `Win.notify()` fires at the call site AFTER `db.commit()`. This moves
   the runner/sim merge-gate email from before-commit to after-commit (strictly safer, test-
   invisible: notifications are log-only/patched-transport in tests and remain exactly-once).
3. **Approve ledger:** the three-commit `repo_ready`/`spec_pr_open` ledger collapses into
   apply()'s ONE transaction (D2). The flag columns stay and still make replays inert.
4. **`finish_done` and `raise_spec_gate` gained CAS preconditions** (they were unconditional
   ORM writes): a Cancel that races the brain call or the merge now wins instead of being
   clobbered. Unreachable by the single-threaded test client; strictly safer.
5. **`advance_stage` is ONE parameterized row** with an `announce` param: the simulator emits
   the "Stage advanced" milestone, the AgentRunner does not — exactly the pre-refactor split.
6. **`respond` keeps its plain `409 "Nothing to respond to"`** on any Loss (its pre-refactor
   shape) instead of the ConflictOut body; the other six gates endpoints share
   `conflict_response`.
7. **Merge OUTCOME audits (`approved_merge`/`merge_approval_failed`) stay endpoint-side**:
   they record the result of the git merge, not a precondition claim — only the
   `merge_claimed` winner audit is table-owned.
8. **`cas_status` survives untouched** (Plan B contract + its regression tests).

## Self-review (done at planning time)

- **Spec coverage:** D1 branch-on-main ✓ (header); D2 one-transaction apply + optional
  intent ✓ (Task 1, `test_apply_attaches_intent_in_same_transaction`); D3 one table,
  parameterized stage-advance, staged migration routers→simulator→agent_runner with
  verify-green between ✓ (Tasks 2–5, full pytest per task); D4 module location + lifecycle.py
  deleted + loss-resolution collapse ✓ (Tasks 1, 2, 5); D5 interface + constants ✓ (Task 1,
  adopted in Tasks 2–6); D6 classify + mission/inbox/detail ✓ (Task 6); D7 per-row unit
  tests + race pairs + HTTP tests unchanged ✓ (Task 1 tests, Global Constraints); D8
  CONTEXT.md term ✓ (Task 7).
- **Placeholder scan:** no TBD/TODO/"similar to Task N"; every endpoint/function body is
  complete; every test has full code; every command has expected output.
- **Type consistency:** `apply(db, req, name, *, actor: Actor, params: dict|None,
  intent: IntentSpec|None, epoch: int|None) -> Win | Loss` is used identically in Tasks
  2–5; `Win.notify()` (method, no args) everywhere; `Loss.detail/.replay/.winner/
  .resulting_state` match `conflict_response`; `classify()` keys match Task 6 tests;
  transition names in call sites all exist as TABLE keys (`submit_claim, raise_spec_gate,
  approve_spec, claim_merge, finish_done, send_back, respond, cancel, retry, take_over,
  send_back_to_stage, escalate, raise_merge_gate, advance_stage` — 14/14).
