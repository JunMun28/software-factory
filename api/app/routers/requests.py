"""Request CRUD, intake interview, and submit endpoints (ADR 0007).

Routes:
  GET   /api/requests                    — list requests (excludes drafts)
  POST  /api/requests                    — create a new draft request
  GET   /api/requests/{rid}              — detail view (with duplicate hint)
  PATCH /api/requests/{rid}              — update a draft/submitted request
  GET   /api/requests/{rid}/interview    — current interview state
  POST  /api/requests/{rid}/interview    — answer / skip the current question
  POST  /api/requests/{rid}/submit       — submit after Review step
"""

import asyncio
import json
import logging
import threading
import time
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import exists, func, null, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import (
    acceptance,
    brain_streams,
    classify_gen,
    interview_gen,
    knowledge,
    prototype_gen,
    settings,
    summary_gen,
    transitions,
)
from ..agent_brain import META_MARKER, PROTO_MARKER
from ..agent_exec import runner_mode
from ..api_helpers import get_request, next_ref, pipeline, prospective_repo, to_out
from ..auth import current_identity
from ..brain_calls import (
    active_call,
    budget_degraded,
    claim_call,
    finish_call,
    model_for_kind,
    prompt_fingerprint,
    record_budget_call,
)
from ..db import SessionLocal, get_db
from ..events import emit
from ..interview import (
    DONE_SENTINEL,
    Question,
    ScriptedBrain,
    answered_count,
    get_brain,
    is_stop_signal,
    pending_payload,
    question_budget,
    question_ceiling,
)
from ..models import (
    AuditEvent,
    BrainCall,
    InterviewTurn,
    ProgressEvent,
    PrototypeTurn,
    Request,
    utcnow,
)
from ..schemas import (
    ClassifyIn,
    ClassifyOut,
    EscalateIn,
    EvidenceOut,
    InterviewAnswer,
    InterviewState,
    Note,
    PrototypeInstruction,
    PrototypeRestore,
    PrototypeState,
    PrototypeTurnOut,
    RequestCreate,
    RequestDetail,
    RequestOut,
    RequestUpdate,
    ReviewSummary,
    RunStateOut,
    SteerIn,
)
from ..supervision import evidence, in_flight, run_state

router = APIRouter()
log = logging.getLogger("factory.interview")


# ---------- interview helpers (module-local, no side-effects beyond DB) ----------

def _answered_turn_count(rid: int):
    """SQL form of answered_count(), usable inside one-statement CAS guards."""
    return (
        select(func.count(InterviewTurn.id))
        .where(
            InterviewTurn.request_id == rid,
            or_(InterviewTurn.answer.is_not(None), InterviewTurn.skipped),
        )
        .scalar_subquery()
    )


def _request_value_matches(column, expected):
    """NULL-safe equality for a value captured before ending the read transaction."""
    return column.is_(None) if expected is None else column == expected


def _next_turn_order(db: Session, model, rid: int) -> int:
    """Derive append order only after the parent request row has been claimed."""
    value = db.scalar(
        select(func.coalesce(func.max(model.order), -1) + 1).where(
            model.request_id == rid
        )
    )
    return int(value)


def _pending_prototype_turn_exists(rid: int):
    return (
        select(PrototypeTurn.id)
        .where(PrototypeTurn.request_id == rid, PrototypeTurn.mode == "pending")
        .exists()
    )


def _conflict(db: Session, detail: str) -> None:
    db.rollback()
    raise HTTPException(status.HTTP_409_CONFLICT, detail)


def _advance_cas_timestamp(previous):
    """Return a request timestamp that changes even at SQL Server precision."""
    return max(utcnow(), previous + timedelta(milliseconds=10))


def current_question(r: Request) -> Question | None:
    """The question awaiting an answer, if one is ready. Pure read — the next
    question is produced ahead of time by interview_gen (a background thread), so
    the request path never blocks on the model."""
    pq = r.pending_question
    return Question(**pq) if pq and "question" in pq else None


def _persist_generated_question(
    db: Session,
    *,
    rid: int,
    payload: dict,
    answered_at_start: int,
    type_at_start: str,
    ceiling_at_start: int | None,
) -> bool:
    """Elect one still-current generated question with a single guarded write."""
    result = db.execute(
        update(Request)
        .where(
            Request.id == rid,
            Request.pending_question.is_(None),
            _answered_turn_count(rid) == answered_at_start,
            Request.type == type_at_start,
            _request_value_matches(Request.reopen_ceiling, ceiling_at_start),
        )
        .values(pending_question=payload)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount == 1:
        db.commit()
        return True
    db.rollback()
    return False


def _generate_pending_sync(db: Session, r: Request) -> Question | None:
    """Generate inline without overwriting a question or turn that wins the race."""
    q = current_question(r)
    if q is not None:
        return q
    answered_at_start = answered_count(r)
    if answered_at_start >= question_ceiling(r) or r.pending_question == DONE_SENTINEL:
        return None
    _resolve_interview(db, r)
    db.refresh(r)
    return current_question(r)


def _current_or_generate(db: Session, r: Request) -> Question | None:
    """The pending question, materializing it synchronously if absent. The UI always
    GETs (which pre-generates) before answering, so this only fires for out-of-protocol
    direct POSTs — never the hot path."""
    return _generate_pending_sync(db, r)


def _routing_fingerprint(r: Request, brain) -> str:
    return prompt_fingerprint(
        r,
        extra={
            "kind": "team-routing",
            "brain": type(brain).__name__,
            "teams": knowledge.teams(),
        },
    )


def _cached_routing_proposal(
    cached: dict, fingerprint: str, request_type: str
) -> tuple[bool, dict | None]:
    proposal = cached.get("proposal")
    if (
        cached.get("accepted")
        and isinstance(proposal, dict)
        and proposal.get("to_type") == request_type
    ):
        return True, None
    if cached.get("fingerprint") != fingerprint:
        return False, None
    if cached.get("declined"):
        return True, None
    if "proposal" not in cached:
        return False, None
    return True, proposal if isinstance(proposal, dict) else None


def _write_routing_cache(
    db: Session,
    r: Request,
    value: dict,
    *,
    call_id: int | None = None,
    dedup_key: str | None = None,
) -> bool:
    """Persist enrichment state without changing the request's business timestamp."""
    updated_at = r.updated_at
    previous = r.intake_escalation
    conditions = [
        Request.id == r.id,
        Request.updated_at == updated_at,
        _request_value_matches(Request.intake_escalation, previous),
    ]
    if call_id is not None and dedup_key is not None:
        conditions.append(
            exists(
                select(BrainCall.id).where(
                    BrainCall.id == call_id,
                    BrainCall.dedup_key == dedup_key,
                )
            )
        )
    wrote = db.execute(
        update(Request)
        .where(*conditions)
        .values(
            intake_escalation=value,
            updated_at=Request.updated_at,
        )
        .execution_options(synchronize_session=False)
    )
    db.commit()
    if wrote.rowcount != 1:
        return False
    db.refresh(r, ["intake_escalation", "updated_at"])
    return True


# NOTE(plan-008): the routing model call must never run on a request thread
# (the same rule that moved classify to classify_gen). interview_state reads the
# cache via _routing_state and defers a miss to this in-process worker; the
# durable brain_calls claim inside _routing_proposal stays the cross-replica
# dedup, this set is only the cheap same-process fast path.
_routing_lock = threading.Lock()
_routing_inflight: set[int] = set()


def _kick_routing(rid: int) -> None:
    with _routing_lock:
        if rid in _routing_inflight:
            return
        _routing_inflight.add(rid)
    threading.Thread(target=_routing_worker, args=(rid,), daemon=True).start()


def _routing_worker(rid: int) -> None:
    try:
        with SessionLocal() as db:
            r = db.get(Request, rid)
            if r is not None:
                _routing_proposal(db, r)
    except Exception:
        log.exception("background team-routing check failed for request %s", rid)
    finally:
        with _routing_lock:
            _routing_inflight.discard(rid)


def _routing_state(db: Session, r: Request, *, allow_call: bool) -> dict | None:
    """Cache-only read for request threads; a miss kicks the background worker."""
    brain = get_brain()
    fingerprint = _routing_fingerprint(r, brain)
    cached = r.intake_escalation if isinstance(r.intake_escalation, dict) else {}
    hit, proposal = _cached_routing_proposal(cached, fingerprint, r.type)
    if hit:
        return proposal
    if not allow_call:
        return None
    if interview_gen.SYNC:
        # NOTE(plan-008): inline in SYNC mode so tests and smoke stay deterministic,
        # mirroring how interview_gen/summary_gen handle their SYNC paths.
        return _routing_proposal(db, r)
    _kick_routing(r.id)
    return None


def _routing_proposal(
    db: Session, r: Request, *, allow_call: bool = True
) -> dict | None:
    """Resolve one deduplicated optional team-routing check for this prompt.

    Synchronous by design — request threads must reach it only through
    _routing_state's SYNC branch; in async mode it runs on _routing_worker's
    daemon thread with its own session."""
    brain = get_brain()
    fingerprint = _routing_fingerprint(r, brain)
    cached = r.intake_escalation if isinstance(r.intake_escalation, dict) else {}
    hit, proposal = _cached_routing_proposal(cached, fingerprint, r.type)
    if hit:
        return proposal
    if not allow_call:
        return None

    if budget_degraded(r.reporter):
        # Over the daily budget: the routing check is enrichment, so skip the provider
        # call. Log the throttle and cache a no-proposal for this fingerprint so the
        # poll loop stops re-kicking instead of spamming budget rows.
        record_budget_call(
            request_id=r.id, kind="escalation", model=model_for_kind("escalation")
        )
        _write_routing_cache(
            db,
            r,
            {
                "fingerprint": fingerprint,
                "proposal": None,
                "declined": False,
                "accepted": False,
            },
        )
        return None

    # End the read transaction before the provider call. The durable brain_calls
    # claim prevents two API replicas from billing the same fingerprint twice.
    _ = r.app, r.turns, r.attachments
    db.commit()
    claim_key = f"escalation:{r.id}:{fingerprint}"
    call_id = claim_call(
        request_id=r.id,
        kind="escalation",
        dedup_key=claim_key,
        model=model_for_kind("escalation"),
        stale_after_seconds=settings.ESCALATION_TIMEOUT + 10,
        retry_after_seconds=settings.ESCALATION_RETRY_SECONDS,
    )
    if call_id is None:
        db.expire(r)
        if _routing_fingerprint(r, brain) != fingerprint:
            db.commit()
            return None
        cached = r.intake_escalation if isinstance(r.intake_escalation, dict) else {}
        cached_proposal = _cached_routing_proposal(cached, fingerprint, r.type)[1]
        db.commit()
        return cached_proposal

    succeeded = False
    try:
        # The previous claimant may have published just before this replacement
        # acquired the key. Reuse that result instead of making a duplicate call.
        db.expire(r)
        if _routing_fingerprint(r, brain) != fingerprint:
            db.commit()
            return None
        cached = r.intake_escalation if isinstance(r.intake_escalation, dict) else {}
        hit, cached_proposal = _cached_routing_proposal(cached, fingerprint, r.type)
        db.commit()
        if hit:
            succeeded = True
            return cached_proposal
        with active_call(call_id):
            proposal = brain.propose_escalation(r)
        call_status = db.scalar(
            select(BrainCall.status).where(BrainCall.id == call_id)
        )
        db.commit()
        if call_status in {"fallback", "failed"}:
            return None
        if proposal is not None:
            if (
                not isinstance(proposal, dict)
                or proposal.get("to_type") not in ("bug", "enh", "new", "other")
                or not isinstance(proposal.get("why"), str)
            ):
                return None
            proposal = {
                "to_type": proposal["to_type"],
                "why": proposal["why"][:200],
            }

        # Do not publish an answer generated from stale request facts or team data.
        db.expire(r)
        if _routing_fingerprint(r, brain) != fingerprint:
            db.commit()
            return None
        value = {
            "fingerprint": fingerprint,
            "proposal": proposal,
            "declined": False,
            "accepted": False,
        }
        succeeded = _write_routing_cache(
            db,
            r,
            value,
            call_id=call_id,
            dedup_key=claim_key,
        )
        return proposal if succeeded else None
    except Exception:
        db.rollback()
        log.exception("optional intake team-routing check failed")
        return None
    finally:
        finish_call(call_id, success=succeeded)


def interview_state(db: Session, r: Request, *, generate: bool = True) -> InterviewState:
    """Cheap read of the interview state. If the next question isn't ready yet and
    `generate` is set, kick off background pre-generation and report `thinking` (SYNC
    mode generates inline). The SSE worker passes generate=False — it does the
    generating itself, so it only wants to read/report the current state."""
    def build(*, done: bool, q: Question | None, thinking: bool) -> InterviewState:
        st = InterviewState(done=done, asked=answered_count(r), total=question_ceiling(r),
                            thinking=thinking, turns=[t for t in r.turns],
                            budget_limited=budget_degraded(r.reporter))
        if q:
            st.question, st.sub, st.options, st.final = q.question, q.sub, q.options, q.final
        # ScriptedBrain and the CLI brain stay silent; ApiBrain can now fill this
        # consent-gated seam without repeated polling creating repeated provider calls.
        prop = _routing_state(db, r, allow_call=not thinking)
        if prop and prop.get("to_type") in ("bug", "enh", "new", "other") and prop["to_type"] != r.type:
            st.escalation = {"to_type": prop["to_type"], "why": str(prop.get("why") or "")[:200]}
        return st

    if answered_count(r) >= question_ceiling(r) or r.pending_question == DONE_SENTINEL:
        if generate and not interview_gen.SYNC:
            summary_gen.ensure_summary(r.id)  # warm the Review summary while "done" shows
        return build(done=True, q=None, thinking=False)
    q = current_question(r)
    if q is not None:
        return build(done=False, q=q, thinking=False)
    if not generate:
        return build(done=False, q=None, thinking=True)  # generation runs elsewhere
    if interview_gen.SYNC:  # deterministic path (tests / smoke): generate inline
        q = _generate_pending_sync(db, r)
        if r.pending_question == DONE_SENTINEL:
            return build(done=True, q=None, thinking=False)
        return build(done=False, q=q, thinking=False)
    thinking = interview_gen.ensure_next_question(r.id)  # async: background pre-generation
    return build(done=False, q=None, thinking=thinking)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _resolved(r: Request) -> bool:
    """The interview is done, or a question is already waiting — nothing to generate."""
    return (current_question(r) is not None
            or answered_count(r) >= question_ceiling(r)
            or r.pending_question == DONE_SENTINEL)


def _sse_worker(rid: int, queue: "asyncio.Queue", loop: "asyncio.AbstractEventLoop", *,
                acquire, release, timeout: int, resolved, resolve, build_state,
                stream_kind: str | None = None, marker: str | None = None) -> None:
    """Shared SSE generation worker (interview + prototype). Claim the per-request slot — or, if a
    generation is already in flight, poll up to `timeout+5`s for its result — then run generation
    on this background thread, relay prose deltas when the brain supports them, persist, and finish
    with one authoritative `state` event. Feature-specific behaviour is the injected `resolved(r)`
    predicate, `resolve(db, r)` generator, and `build_state(db, r)` serializer."""
    def push(ev: dict) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, ev)

    def emit(db: Session, r: Request) -> None:
        push({"type": "state", "state": build_state(db, r).model_dump(mode="json")})

    if not acquire(rid):  # another generation in flight — poll for its result
        deadline = time.monotonic() + timeout + 5
        delay = 1.0
        with SessionLocal() as db:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(min(delay, remaining))
                db.expire_all()
                r = db.get(Request, rid)
                if r is None:
                    push({"type": "state", "state": None})
                    return
                if resolved(r):
                    emit(db, r)
                    return
                # End the read transaction so this long-lived waiter does not pin a DB snapshot.
                db.rollback()
                delay = min(delay * 2, 5.0)
        push({"type": "state", "state": None})
        return
    try:
        with SessionLocal() as db:
            r = db.get(Request, rid)
            if r is None:
                push({"type": "state", "state": None})
                return
            relay = (
                brain_streams.prose_relay(stream_kind, rid, marker)
                if stream_kind is not None and marker is not None
                else None
            )
            try:
                brain_streams.invoke_with_delta(
                    resolve,
                    db,
                    r,
                    on_delta=relay.feed if relay is not None else None,
                )
            finally:
                if relay is not None:
                    relay.finish()
            db.expire_all()
            r = db.get(Request, rid)
            if r is None:
                push({"type": "state", "state": None})
                return
            emit(db, r)
    except Exception:
        log.exception("SSE generation failed for request %s", rid)
        push({"type": "state", "state": None})
    finally:
        release(rid)


def _sse_response(rid: int, worker, *, stream_kind: str) -> StreamingResponse:
    """Run a worker thread, relay live deltas, then finish with authoritative state."""
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def push(event: dict) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, event)

    unsubscribe = brain_streams.subscribe(stream_kind, rid, push)
    threading.Thread(target=worker, args=(rid, queue, loop), daemon=True).start()

    async def gen():
        try:
            while True:
                ev = await queue.get()
                event_type = ev.get("type")
                if event_type == "delta":
                    yield _sse("delta", {"text": ev.get("text") or ""})
                    continue
                yield _sse("state", ev.get("state") or {})
                return
        finally:
            unsubscribe()

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _resolve_interview(db: Session, r: Request, on_delta=None) -> None:
    """Generate + persist the next interview question (batch) unless it's already resolved."""
    if _resolved(r):
        return
    rid = r.id
    answered_at_start = answered_count(r)
    type_at_start = r.type
    ceiling_at_start = r.reopen_ceiling
    identity = r.reporter
    # End the read transaction before the slow call. expire_on_commit=False keeps
    # the fully loaded brain snapshot while returning the pooled connection.
    _ = r.app, r.turns, r.attachments
    db.commit()
    if budget_degraded(identity):
        # Over the daily budget: serve the scripted question and log the throttle;
        # _persist_generated_question still guards against a racing state change.
        record_budget_call(
            request_id=rid, kind="question", model=model_for_kind("question")
        )
        q = ScriptedBrain().next_question(r)
        _persist_generated_question(
            db,
            rid=rid,
            payload=pending_payload(q),
            answered_at_start=answered_at_start,
            type_at_start=type_at_start,
            ceiling_at_start=ceiling_at_start,
        )
        db.refresh(r)
        return
    call_id = claim_call(
        request_id=rid,
        kind="question",
        dedup_key=f"question:{rid}:{answered_at_start}:{prompt_fingerprint(r)}",
        model=model_for_kind("question"),
    )
    if call_id is None:
        return
    succeeded = False
    try:
        with active_call(call_id):
            q = brain_streams.invoke_with_delta(
                get_brain().next_question,
                r,
                on_delta=on_delta,
            )
        _persist_generated_question(
            db,
            rid=rid,
            payload=pending_payload(q),
            answered_at_start=answered_at_start,
            type_at_start=type_at_start,
            ceiling_at_start=ceiling_at_start,
        )
        succeeded = True
        db.refresh(r)
    finally:
        finish_call(call_id, success=succeeded)


def _interview_worker(rid: int, queue: "asyncio.Queue", loop: "asyncio.AbstractEventLoop") -> None:
    _sse_worker(rid, queue, loop, acquire=interview_gen.acquire, release=interview_gen.release,
                timeout=settings.INTERVIEW_TIMEOUT, resolved=_resolved, resolve=_resolve_interview,
                build_state=lambda db, r: interview_state(db, r, generate=False),
                stream_kind="interview", marker=META_MARKER)


def _prototype_state(db: Session, r: Request, *, thinking: bool) -> PrototypeState:
    """The Prototype step's live state: the current document + the chat thread."""
    return PrototypeState(
        html=r.prototype_html, status=r.prototype_status, thinking=thinking,
        turns=[PrototypeTurnOut(order=t.order, instruction=t.instruction, annotation=t.annotation,
                                mode=t.mode, note=t.note, revision=t.html is not None)
               for t in r.prototype_turns],
    )


def _resolve_prototype(db: Session, r: Request, on_delta=None) -> None:
    """Seed the first draft if owed, then generate + apply the pending revision (batch)."""
    prototype_gen.seed_first_draft(db, r)
    turn = prototype_gen.pending_turn(r)
    if turn is None:  # nothing to generate — already resolved
        return
    rid = r.id
    db.commit()
    db.close()
    prototype_gen.resolve_one(rid, on_delta=on_delta)


def _prototype_worker(rid: int, queue: "asyncio.Queue", loop: "asyncio.AbstractEventLoop") -> None:
    _sse_worker(rid, queue, loop, acquire=prototype_gen.acquire, release=prototype_gen.release,
                timeout=settings.PROTOTYPE_TIMEOUT,
                resolved=lambda r: prototype_gen.pending_turn(r) is None,
                resolve=_resolve_prototype,
                build_state=lambda db, r: _prototype_state(db, r, thinking=False),
                stream_kind="prototype", marker=PROTO_MARKER)


# ---------- requests CRUD ----------

@router.post("/api/requests/classify", response_model=ClassifyOut)
def classify_request(body: ClassifyIn, response: Response):
    """Kick durable classification for a Request, retaining the legacy stateless call."""
    # NOTE(plan-008): The approved plan assumed classification already wrote Request
    # fields, but the active endpoint was stateless. Request-bound calls now persist a
    # separate result while the no-id contract stays deterministic and immediate.
    if body.request_id is None:
        return ClassifyOut(status="succeeded", **ScriptedBrain().classify(body.description))
    if not classify_gen.kick(body.request_id, body.description):
        raise HTTPException(404, "Request not found")
    response.status_code = status.HTTP_202_ACCEPTED
    return ClassifyOut(status="pending")


@router.get("/api/requests/{rid}/classify", response_model=ClassifyOut)
def get_classification(rid: int, db: Session = Depends(get_db)):
    request = db.get(Request, rid)
    stored = request.classification_result if request is not None else None
    result = dict(stored) if stored is not None else None
    if result is None:
        raise HTTPException(404, "Classification not found")
    if result.get("status") == "pending":
        # Do not retain this poll's checkout while the restart path opens its own session.
        db.close()
        classify_gen.ensure_classification(rid)
    return ClassifyOut(
        status=result["status"],
        type=result.get("type"),
        confidence=result.get("confidence"),
    )


@router.get("/api/requests", response_model=list[RequestOut])
def list_requests(mine: str | None = None, active: bool = False, limit: int = 500,
                  db: Session = Depends(get_db)):
    q = db.query(Request).filter(Request.status != "draft")
    if mine:
        q = q.filter(Request.reporter == mine)
    if active:  # in SQL, not Python — the DB does the filtering
        q = q.filter(Request.status.notin_(("done", "cancelled")))
    rows = q.order_by(Request.created_at.desc()).limit(min(limit, 1000)).all()
    # latest milestone per request, scoped to the returned page — the events
    # table grows forever; this query must not grow with it (ADR 0013)
    ids = [r.id for r in rows]
    latest = dict(
        db.query(ProgressEvent.request_id, func.max(ProgressEvent.id))
        .filter(ProgressEvent.request_id.in_(ids))
        .group_by(ProgressEvent.request_id)
        .all()
    ) if ids else {}
    titles = {
        ev.id: ev.title
        for ev in db.query(ProgressEvent).filter(ProgressEvent.id.in_(latest.values())).all()
    } if latest else {}
    return [to_out(r, last_event=titles.get(latest.get(r.id))) for r in rows]


@router.get("/api/requests/{rid}", response_model=RequestDetail)
def request_detail(rid: int, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    d = to_out(r, RequestDetail)
    d.audit = [a for a in db.query(AuditEvent).filter(AuditEvent.request_id == rid).order_by(AuditEvent.created_at).all()]
    rs = run_state(db, r)
    d.run = RunStateOut(**rs) if rs is not None else None
    ev = evidence(db, r)
    d.evidence = EvidenceOut(**ev) if ev is not None else None
    # naive duplicate hint: another recent request on the same app sharing a title
    # word >4 chars. Only meaningful before approval — past that, skip the scan
    # (it used to run a full per-app table load on every detail poll).
    if r.app_id and r.status in transitions.PRE_APPROVAL:
        words = {w.lower().strip(",.") for w in r.title.split() if len(w) > 4}
        recent = (db.query(Request)
                  .filter(Request.app_id == r.app_id, Request.id != r.id,
                          Request.status != transitions.CANCELLED)
                  .order_by(Request.id.desc()).limit(200).all())
        for other in recent:
            ow = {w.lower().strip(",.") for w in other.title.split() if len(w) > 4}
            if words & ow:
                d.duplicate = {"ref": other.ref, "title": other.title, "id": other.id}
                break
    return d


@router.post("/api/requests", response_model=RequestDetail, status_code=201)
def create_request(body: RequestCreate, db: Session = Depends(get_db)):
    # SEC-01: with the auth wall on, the reporter is WHO SIGNED IN — the body
    # fields degrade to untrusted UI state (same rule as operator override).
    identity = current_identity()
    reporter = identity["name"] if identity else body.reporter
    reporter_initials = identity["initials"] if identity else body.reporter_initials
    # persist-first (PRD hardening #4): the Request exists before anything else
    for attempt in (0, 1):
        r = Request(
            ref=next_ref(db), title=body.title or "(untitled request)", description=body.description,
            type=body.type, urgency=body.urgency, reach=body.reach,
            impact_metric=body.impact_metric, impact_value=body.impact_value, app_id=body.app_id,
            new_app_name=body.new_app_name, bug_where=body.bug_where,
            status=transitions.DRAFT, stage="intake",
            reporter=reporter, reporter_initials=reporter_initials,
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


@router.patch("/api/requests/{rid}", response_model=RequestDetail)
def update_request(rid: int, body: RequestUpdate, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    if r.status not in (transitions.DRAFT, transitions.SUBMITTED):
        raise HTTPException(409, "Request can no longer be edited")
    data = body.model_dump(exclude_unset=True)  # PATCH: unsent fields stay untouched
    if not data.get("title"):
        data.pop("title", None)  # the title can change but never go blank
    type_changed = "type" in data and data["type"] != r.type
    for k, v in data.items():
        setattr(r, k, v)
    # Any edit invalidates the cached summary: it is keyed on answered turns only,
    # and between the two brains the summary reads nearly every field (agent:
    # _context; scripted: reach/impact) — a selective set here would drift.
    if data:
        r.summary = None
    # A type change (e.g. correcting the inferred Track in Basics) invalidates any
    # question pre-generated for the OLD type — drop it so the next one regenerates
    # for the new type instead of asking the old track's questions.
    if type_changed:
        r.pending_question = None
    db.commit()
    return to_out(r, RequestDetail)


# ---------- intake interview ----------

@router.get("/api/requests/{rid}/interview", response_model=InterviewState)
def get_interview(rid: int, gen: bool = True, db: Session = Depends(get_db)):
    # gen=false: read state without kicking background pre-generation — the streaming
    # client reads first, then opens the SSE stream to drive (and stream) the question.
    r = get_request(db, rid)
    return interview_state(db, r, generate=gen)


@router.get("/api/requests/{rid}/interview/stream")
async def stream_interview(rid: int):
    """SSE: drives the next-question generation on a worker thread, then returns the terminal
    InterviewState. Frees the HTTP handler from the blocking model call."""
    return _sse_response(rid, _interview_worker, stream_kind="interview")


@router.post("/api/requests/{rid}/interview", response_model=InterviewState)
def answer_interview(rid: int, body: InterviewAnswer, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    q = _current_or_generate(db, r)
    if q is None:
        return interview_state(db, r)  # nothing pending to answer (interview is done)
    expected_question = dict(r.pending_question)
    stop = not body.skip and is_stop_signal(body.answer or "")
    # NOTE(plan-008): release SQLite's read snapshot before the one-statement
    # CAS. The exact JSON payload is the question generation being answered.
    db.commit()
    claim = db.execute(
        update(Request)
        .where(
            Request.id == rid,
            Request.pending_question.is_not(None),
            Request.pending_question == expected_question,
        )
        .values(pending_question=null())
        .execution_options(synchronize_session=False)
    )
    if claim.rowcount != 1:
        _conflict(db, "Interview question was already answered; refresh and try again.")
    order = _next_turn_order(db, InterviewTurn, rid)
    db.add(InterviewTurn(request_id=rid, order=order, question=q.question, sub=q.sub,
                         options=q.options, answer=None if body.skip else (body.answer or None),
                         skipped=body.skip))
    if stop:
        db.execute(
            update(Request)
            .where(Request.id == rid)
            .values(pending_question=DONE_SENTINEL)
            .execution_options(synchronize_session=False)
        )
    try:
        db.commit()
    except IntegrityError:
        _conflict(db, "Interview answer conflicted with another turn; refresh and try again.")
    db.refresh(r)
    db.expire(r, ["turns"])
    # returns immediately with `thinking`. In async mode we DON'T kick pre-gen here —
    # the client drives the next question (SSE stream, or poll which kicks it). SYNC
    # mode (tests/smoke) generates inline so the next question comes back in the POST.
    return interview_state(db, r, generate=interview_gen.SYNC)


@router.post("/api/requests/{rid}/interview/reopen", response_model=InterviewState)
def reopen_interview(rid: int, body: Note, db: Session = Depends(get_db)):
    """'Add more detail' from the Review step: record the submitter's added note as an
    interview turn and unlock a follow-up round so Fabric can ask one more question (or
    wrap up), instead of the interview being permanently finished."""
    r = get_request(db, rid)
    note = (body.note or "").strip()
    if not note:
        return interview_state(db, r, generate=interview_gen.SYNC)
    answered_at_start = answered_count(r)
    ceiling_at_start = r.reopen_ceiling
    pending_at_start = dict(r.pending_question) if r.pending_question is not None else None
    db.commit()
    claim = db.execute(
        update(Request)
        .where(
            Request.id == rid,
            _answered_turn_count(rid) == answered_at_start,
            _request_value_matches(Request.reopen_ceiling, ceiling_at_start),
            _request_value_matches(Request.pending_question, pending_at_start),
        )
        # The note itself becomes one answered turn; keep the existing two-question allowance.
        .values(reopen_ceiling=answered_at_start + 3, pending_question=null())
        .execution_options(synchronize_session=False)
    )
    if claim.rowcount != 1:
        _conflict(db, "Interview was already reopened; refresh and try again.")
    order = _next_turn_order(db, InterviewTurn, rid)
    db.add(InterviewTurn(request_id=rid, order=order, question="Anything else to add?",
                         answer=note[:2000], skipped=False))
    try:
        db.commit()
    except IntegrityError:
        _conflict(db, "Interview reopen conflicted with another turn; refresh and try again.")
    db.refresh(r)
    db.expire(r, ["turns"])
    return interview_state(db, r, generate=interview_gen.SYNC)


@router.post("/api/requests/{rid}/interview/escalate", response_model=InterviewState)
def escalate_interview(rid: int, body: EscalateIn, db: Session = Depends(get_db)):
    """Consent gate for a mid-interview type change (ADR 0023). Accept PATCHes the type
    (the draft's other facts persist — lossless); decline leaves it unchanged. Either way
    the interview continues; the routing decision is retained for audit."""
    r = get_request(db, rid)
    cached = r.intake_escalation if isinstance(r.intake_escalation, dict) else None
    cached_proposal = cached.get("proposal") if cached is not None else None
    if isinstance(cached_proposal, dict):
        same_target = cached_proposal.get("to_type") == body.to_type
        if cached.get("accepted"):
            if body.accept and same_target and r.type == body.to_type:
                return interview_state(db, r, generate=interview_gen.SYNC)
            _conflict(db, "Interview escalation was already accepted.")
        if cached.get("declined"):
            if not body.accept and same_target:
                return interview_state(db, r, generate=interview_gen.SYNC)
            _conflict(db, "Interview escalation was already declined.")
        current_fingerprint = _routing_fingerprint(r, get_brain())
        if (
            cached.get("fingerprint") != current_fingerprint
            or cached_proposal.get("to_type") != body.to_type
        ):
            _conflict(db, "Interview escalation is stale; refresh and try again.")
    resolved_cache = (
        {
            **cached,
            "accepted": bool(body.accept),
            "declined": not body.accept,
            "resolved_at": utcnow().isoformat(),
        }
        if cached is not None and isinstance(cached_proposal, dict)
        else None
    )
    if body.accept and r.type != body.to_type:
        type_at_start = r.type
        answered_at_start = answered_count(r)
        pending_at_start = dict(r.pending_question) if r.pending_question is not None else None
        updated_at_start = r.updated_at
        db.commit()
        claim = db.execute(
            update(Request)
            .where(
                Request.id == rid,
                Request.type == type_at_start,
                Request.updated_at == updated_at_start,
                _request_value_matches(Request.intake_escalation, cached),
                _answered_turn_count(rid) == answered_at_start,
                _request_value_matches(Request.pending_question, pending_at_start),
            )
            .values(
                type=body.to_type,
                summary=null(),
                pending_question=null(),
                intake_escalation=(
                    resolved_cache if resolved_cache is not None else null()
                ),
            )
            .execution_options(synchronize_session=False)
        )
        if claim.rowcount != 1:
            _conflict(db, "Interview escalation was already resolved; refresh and try again.")
    else:
        if resolved_cache is not None and not _write_routing_cache(db, r, resolved_cache):
            _conflict(db, "Interview escalation was already resolved; refresh and try again.")
    db.commit()  # preserve decline and same-type accept as successful no-ops
    db.refresh(r)
    return interview_state(db, r, generate=interview_gen.SYNC)


def _review_summary(data: dict | None, *, thinking: bool = False) -> ReviewSummary:
    data = data or {}
    return ReviewSummary(overview=data.get("overview"), sections=data.get("sections") or [],
                         thinking=thinking)


@router.get("/api/requests/{rid}/summary", response_model=ReviewSummary)
def get_summary(rid: int, db: Session = Depends(get_db)):
    """The AI-written Review spec. Returns the cached copy when it's current; otherwise generates
    it (inline in SYNC mode, else on a background thread → `thinking`, poll)."""
    r = get_request(db, rid)
    hit = summary_gen.cached(r)
    if hit:
        return _review_summary(hit)
    if interview_gen.SYNC:
        return _review_summary(summary_gen.generate_sync(r, db))
    return _review_summary(None, thinking=summary_gen.ensure_summary(rid))


# ---------- prototype step (new-app only) ----------

@router.get("/api/requests/{rid}/prototype", response_model=PrototypeState)
def get_prototype(rid: int, gen: bool = True, db: Session = Depends(get_db)):
    """The Prototype step state. gen=true seeds + kicks the first draft on first entry (SYNC
    generates inline). gen=false is a pure read — the streaming client reads, then opens the SSE
    stream to drive generation itself. Non new-app requests never get a prototype."""
    r = get_request(db, rid)
    if r.type != "new":
        return PrototypeState(html=r.prototype_html, status=r.prototype_status)
    thinking = prototype_gen.ensure(db, r) if gen else prototype_gen.is_thinking(r)
    if prototype_gen.SYNC and gen:
        r = get_request(db, rid)  # sync generation closes its snapshot session around the model call
    return _prototype_state(db, r, thinking=thinking)


@router.get("/api/requests/{rid}/prototype/stream")
async def stream_prototype(rid: int):
    """SSE: drives the pending prototype revision on a worker thread, then returns the new state."""
    return _sse_response(rid, _prototype_worker, stream_kind="prototype")


@router.post("/api/requests/{rid}/prototype", response_model=PrototypeState)
def instruct_prototype(rid: int, body: PrototypeInstruction, db: Session = Depends(get_db)):
    """A chat turn: record the user's edit instruction (optionally scoped to an annotated element)
    as a pending turn and kick generation. Returns immediately with `thinking`; the client opens
    the stream to watch the revision form (SYNC generates inline)."""
    r = get_request(db, rid)
    if r.type != "new":  # prototype is new-app only — mirror the GET gate on the write paths
        return _prototype_state(db, r, thinking=False)
    instr = (body.instruction or "").strip()
    if not instr:
        return _prototype_state(db, r, thinking=prototype_gen.is_thinking(r))
    # The client already exposes one-open-instruction semantics by disabling the
    # composer while a pending turn exists. Make that rule atomic server-side.
    updated_at_start = r.updated_at
    pending_turn_exists = _pending_prototype_turn_exists(rid)
    db.commit()
    claim = db.execute(
        update(Request)
        .where(
            Request.id == rid,
            Request.type == "new",
            Request.updated_at == updated_at_start,
            ~pending_turn_exists,
        )
        # SQL Server DATETIME has coarse precision. Advancing by at least 10 ms
        # ensures the request timestamp is a real CAS token even on same-tick posts.
        .values(updated_at=_advance_cas_timestamp(updated_at_start))
        .execution_options(synchronize_session=False)
    )
    if claim.rowcount != 1:
        _conflict(db, "A prototype instruction is already being processed; refresh and try again.")
    order = _next_turn_order(db, PrototypeTurn, rid)
    db.add(PrototypeTurn(request_id=rid, order=order, instruction=instr,
                         annotation=body.annotation, mode="pending"))
    try:
        db.commit()
    except IntegrityError:
        _conflict(db, "Prototype instruction conflicted with another turn; refresh and try again.")
    db.refresh(r)
    db.expire(r, ["prototype_turns"])
    thinking = prototype_gen.queue_or_resolve(db, r)  # SYNC resolves inline; async → client streams
    if prototype_gen.SYNC:
        r = get_request(db, rid)  # sync generation closes its snapshot session around the model call
    return _prototype_state(db, r, thinking=thinking)


@router.post("/api/requests/{rid}/prototype/skip", response_model=PrototypeState)
def skip_prototype(rid: int, db: Session = Depends(get_db)):
    """Soft-gate skip: advance to Review with no prototype attached (the confirm is client-side)."""
    r = get_request(db, rid)
    if r.type != "new":
        return _prototype_state(db, r, thinking=False)
    r.prototype_status = "skipped"
    db.commit()
    db.refresh(r)
    return _prototype_state(db, r, thinking=False)


@router.post("/api/requests/{rid}/prototype/restore", response_model=PrototypeState)
def restore_prototype(rid: int, body: PrototypeRestore, db: Session = Depends(get_db)):
    """Undo/restore: re-apply the document from the revision at `order` as a new latest revision
    (linear history — restore never rewrites the past, design A6)."""
    r = get_request(db, rid)
    if r.type != "new":
        return _prototype_state(db, r, thinking=False)
    target = next((t for t in r.prototype_turns if t.order == body.order and t.html is not None), None)
    if target is None:
        return _prototype_state(db, r, thinking=prototype_gen.is_thinking(r))
    target_html = target.html
    updated_at_start = r.updated_at
    db.commit()
    claim = db.execute(
        update(Request)
        .where(
            Request.id == rid,
            Request.type == "new",
            Request.updated_at == updated_at_start,
            ~_pending_prototype_turn_exists(rid),
        )
        .values(
            prototype_html=target_html,
            prototype_status="edited",
            updated_at=_advance_cas_timestamp(updated_at_start),
        )
        .execution_options(synchronize_session=False)
    )
    if claim.rowcount != 1:
        _conflict(db, "Prototype history changed before restore; refresh and try again.")
    order = _next_turn_order(db, PrototypeTurn, rid)
    db.add(PrototypeTurn(request_id=rid, order=order, instruction=None, mode="rewrite",
                         note="Reverted to an earlier version.", html=target_html))
    try:
        db.commit()
    except IntegrityError:
        _conflict(db, "Prototype restore conflicted with another turn; refresh and try again.")
    db.refresh(r)
    db.expire(r, ["prototype_turns"])
    return _prototype_state(db, r, thinking=False)


# ---------- submit (after Review step) ----------

MIN_TITLE_CHARS = 3
MIN_SUBSTANCE_CHARS = 10


def _normalized_content(value: object) -> str:
    """Collapse surrounding/internal whitespace before applying intake floors."""
    return " ".join(str(value or "").split())


def _is_substantive(value: object, minimum: int = MIN_SUBSTANCE_CHARS) -> bool:
    return len(_normalized_content(value)) >= minimum


def _submit_floor_error(r: Request, extra: Note | None) -> str | None:
    """Return why a draft is too thin to spend pipeline work on, if anything."""
    title = _normalized_content(r.title)
    if not title or title == "(untitled request)":
        return "Request title is required before submit."
    if len(title) < MIN_TITLE_CHARS:
        return f"Request title must contain at least {MIN_TITLE_CHARS} characters."

    supplied_detail = any(
        _is_substantive(value)
        for value in (
            r.description,
            r.bug_where,
            r.reach,
            r.impact_value,
            r.extra_detail,
            extra.note if extra else None,
        )
    )
    supplied_detail = supplied_detail or any(
        not turn.skipped and _is_substantive(turn.answer) for turn in r.turns
    )
    supplied_detail = supplied_detail or any(
        not line.assume and _is_substantive(line.text) for line in r.spec_lines
    )
    floor, _ceiling = question_budget(r.type)
    answered = sum(
        1
        for turn in r.turns
        if not turn.skipped and _is_substantive(turn.answer)
    )
    interview_complete = answered >= floor or (
        r.pending_question == DONE_SENTINEL and answered > 0
    )
    if not supplied_detail and not interview_complete:
        return (
            "Request needs more detail before submit: add a description/spec "
            "detail or complete the interview."
        )
    return None


@router.post("/api/requests/{rid}/submit", response_model=RequestDetail)
def submit(rid: int, extra: Note | None = None, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    if r.status not in (transitions.DRAFT, transitions.SUBMITTED):
        return to_out(r, RequestDetail)  # idempotent
    if floor_error := _submit_floor_error(r, extra):
        raise HTTPException(422, floor_error)
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
        # Stage 1 brain writes the grounded Draft spec, then the spec gate is raised.
        # Over the daily budget the spec degrades to the scripted draft (the interview
        # is enrichment, never a blocker); the throttle is logged for ops.
        if budget_degraded(r.reporter):
            record_budget_call(request_id=r.id, kind="spec", model=model_for_kind("spec"))
            lines, note = ScriptedBrain().draft_spec(r)
        else:
            lines, note = get_brain().draft_spec(r)
        db.add_all(lines)
        r.spec_open_note = note
        gate = transitions.apply(db, r, "raise_spec_gate", actor=reporter)
        if isinstance(gate, transitions.Loss):
            return to_out(r, RequestDetail)  # a Cancel raced the brain — it wins, spec discarded
        auto_approved = settings.spec_gate_mode() == "auto"
        if auto_approved:
            repo = r.app.repo if r.app else prospective_repo(r)
            approval = transitions.apply(
                db,
                r,
                "approve_spec",
                actor=transitions.FACTORY,
                params={
                    "repo": repo,
                    "audit_note": "auto-approved (FACTORY_SPEC_GATE=auto)",
                },
            )
            if isinstance(approval, transitions.Loss):
                return to_out(r, RequestDetail)
            r.repo_ready = True
            r.spec_pr_open = True
            acceptance.derive_and_snapshot(db, r)
        db.commit()
        if auto_approved:
            if runner_mode() == "agent":
                pipeline().start(r.id)
        else:
            gate.notify()
    except Exception:
        db.rollback()
        release = transitions.apply(db, r, "release_submit_claim", actor=reporter)
        if isinstance(release, transitions.Win):
            db.commit()  # hand the claim back — a failed brain must not strand the request
        else:
            db.rollback()  # Cancel won during the brain call; never resurrect the request
        raise
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/steer", status_code=201)
def steer(rid: int, body: SteerIn, db: Session = Depends(get_db)):
    """Append a steer note for a RUNNING build (spec §6). 409 anywhere else:
    at a gate the human verb is approve/send-back; stalled has Recovery."""
    r = get_request(db, rid)
    from .operators import resolve_operator
    actor = resolve_operator(db, body.operator_id).name
    if not in_flight(r):
        raise HTTPException(409, "Steer is only available while a run is in flight")
    ev = emit(db, r, "steer_note", body.note[:300], actor=actor, bot=False, body=body.note)
    db.add(AuditEvent(request_id=r.id, actor=actor, action="steered", note=body.note[:300]))
    db.flush()  # assign the event id before returning it
    db.commit()
    return {"id": ev.id, "status": "queued"}
