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

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import func, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import interview_gen, prototype_gen, settings, summary_gen
from ..api_helpers import get_request, next_ref, to_out
from ..db import SessionLocal, get_db
from ..events import emit
from ..interview import (
    DONE_SENTINEL,
    Question,
    answered_count,
    get_brain,
    pending_payload,
    question_ceiling,
)
from ..models import AuditEvent, InterviewTurn, ProgressEvent, PrototypeTurn, Request, utcnow
from ..schemas import (
    ClassifyIn,
    ClassifyOut,
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

def current_question(r: Request) -> Question | None:
    """The question awaiting an answer, if one is ready. Pure read — the next
    question is produced ahead of time by interview_gen (a background thread), so
    the request path never blocks on the model."""
    pq = r.pending_question
    return Question(**pq) if pq and "question" in pq else None


def _current_or_generate(db: Session, r: Request) -> Question | None:
    """The pending question, materializing it synchronously if absent. The UI always
    GETs (which pre-generates) before answering, so this only fires for out-of-protocol
    direct POSTs — never the hot path."""
    q = current_question(r)
    if q is not None:
        return q
    if answered_count(r) >= question_ceiling(r) or r.pending_question == DONE_SENTINEL:
        return None
    r.pending_question = pending_payload(get_brain().next_question(r))
    db.commit()
    db.refresh(r)
    return current_question(r)


def interview_state(db: Session, r: Request, *, generate: bool = True) -> InterviewState:
    """Cheap read of the interview state. If the next question isn't ready yet and
    `generate` is set, kick off background pre-generation and report `thinking` (SYNC
    mode generates inline). The SSE worker passes generate=False — it does the
    generating itself, so it only wants to read/report the current state."""
    def build(*, done: bool, q: Question | None, thinking: bool) -> InterviewState:
        st = InterviewState(done=done, asked=answered_count(r), total=question_ceiling(r),
                            thinking=thinking, turns=[t for t in r.turns])
        if q:
            st.question, st.sub, st.options, st.final = q.question, q.sub, q.options, q.final
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
        r.pending_question = pending_payload(get_brain().next_question(r))
        db.commit()
        if r.pending_question == DONE_SENTINEL:
            return build(done=True, q=None, thinking=False)
        return build(done=False, q=current_question(r), thinking=False)
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
                acquire, release, timeout: int, resolved, resolve, build_state) -> None:
    """Shared SSE generation worker (interview + prototype). Claim the per-request slot — or, if a
    generation is already in flight, poll up to `timeout+5`s for its result — then run the (batch)
    generation on this background thread, persist, and push exactly one terminal `state` event so
    the single uvicorn event loop is never frozen. Feature-specific behaviour is the injected
    `resolved(r)` predicate, `resolve(db, r)` generator, and `build_state(db, r)` serializer."""
    def push(ev: dict) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, ev)

    def emit(db: Session, r: Request) -> None:
        push({"type": "state", "state": build_state(db, r).model_dump(mode="json")})

    if not acquire(rid):  # another generation in flight — poll for its result
        for _ in range(timeout + 5):
            time.sleep(1)
            with SessionLocal() as db:
                r = db.get(Request, rid)
                if r is None:
                    push({"type": "state", "state": None})
                    return
                if resolved(r):
                    emit(db, r)
                    return
        push({"type": "state", "state": None})
        return
    try:
        with SessionLocal() as db:
            r = db.get(Request, rid)
            if r is None:
                push({"type": "state", "state": None})
                return
            resolve(db, r)  # generate + persist if not already resolved (idempotent)
            emit(db, r)
    except Exception:
        log.exception("SSE generation failed for request %s", rid)
        push({"type": "state", "state": None})
    finally:
        release(rid)


def _sse_response(rid: int, worker) -> StreamingResponse:
    """Run `worker(rid, queue, loop)` on a daemon thread and stream its terminal state as one SSE
    event. The batch GET stays the reconnect/replay source of truth."""
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()
    threading.Thread(target=worker, args=(rid, queue, loop), daemon=True).start()

    async def gen():
        ev = await queue.get()
        yield _sse("state", ev.get("state") or {})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _resolve_interview(db: Session, r: Request) -> None:
    """Generate + persist the next interview question (batch) unless it's already resolved."""
    if _resolved(r):
        return
    q = get_brain().next_question(r)
    db.refresh(r)
    if r.pending_question is None:  # don't clobber a racing write
        r.pending_question = pending_payload(q)
        db.commit()


def _interview_worker(rid: int, queue: "asyncio.Queue", loop: "asyncio.AbstractEventLoop") -> None:
    _sse_worker(rid, queue, loop, acquire=interview_gen.acquire, release=interview_gen.release,
                timeout=settings.INTERVIEW_TIMEOUT, resolved=_resolved, resolve=_resolve_interview,
                build_state=lambda db, r: interview_state(db, r, generate=False))


def _prototype_state(db: Session, r: Request, *, thinking: bool) -> PrototypeState:
    """The Prototype step's live state: the current document + the chat thread."""
    return PrototypeState(
        html=r.prototype_html, status=r.prototype_status, thinking=thinking,
        turns=[PrototypeTurnOut(order=t.order, instruction=t.instruction, annotation=t.annotation,
                                mode=t.mode, note=t.note, revision=t.html is not None)
               for t in r.prototype_turns],
    )


def _resolve_prototype(db: Session, r: Request) -> None:
    """Seed the first draft if owed, then generate + apply the pending revision (batch)."""
    prototype_gen.seed_first_draft(db, r)
    turn = prototype_gen.pending_turn(r)
    if turn is None:  # nothing to generate — already resolved
        return
    rev = get_brain().generate_prototype(
        r, instruction=turn.instruction, annotation=turn.annotation, current_html=r.prototype_html)
    db.refresh(r)
    turn = prototype_gen.pending_turn(r)  # re-fetch after refresh; don't clobber a racing write
    if turn is not None:
        prototype_gen.apply_revision(db, r, turn, rev)


def _prototype_worker(rid: int, queue: "asyncio.Queue", loop: "asyncio.AbstractEventLoop") -> None:
    _sse_worker(rid, queue, loop, acquire=prototype_gen.acquire, release=prototype_gen.release,
                timeout=settings.PROTOTYPE_TIMEOUT,
                resolved=lambda r: prototype_gen.pending_turn(r) is None,
                resolve=_resolve_prototype,
                build_state=lambda db, r: _prototype_state(db, r, thinking=False))


# ---------- requests CRUD ----------

@router.post("/api/requests/classify", response_model=ClassifyOut)
def classify_request(body: ClassifyIn):
    """Stateless type inference for the composer chip — no Request is created.
    Track/confidence are Intake-only; the Factory still consumes only the stored type."""
    return get_brain().classify(body.description)


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
    if r.app_id and r.status in ("draft", "submitted", "pending_approval", "sent_back"):
        words = {w.lower().strip(",.") for w in r.title.split() if len(w) > 4}
        recent = (db.query(Request)
                  .filter(Request.app_id == r.app_id, Request.id != r.id,
                          Request.status != "cancelled")
                  .order_by(Request.id.desc()).limit(200).all())
        for other in recent:
            ow = {w.lower().strip(",.") for w in other.title.split() if len(w) > 4}
            if words & ow:
                d.duplicate = {"ref": other.ref, "title": other.title, "id": other.id}
                break
    return d


@router.post("/api/requests", response_model=RequestDetail, status_code=201)
def create_request(body: RequestCreate, db: Session = Depends(get_db)):
    # persist-first (PRD hardening #4): the Request exists before anything else
    for attempt in (0, 1):
        r = Request(
            ref=next_ref(db), title=body.title or "(untitled request)", description=body.description,
            type=body.type, urgency=body.urgency, reach=body.reach,
            impact_metric=body.impact_metric, impact_value=body.impact_value, app_id=body.app_id,
            new_app_name=body.new_app_name, bug_where=body.bug_where, status="draft", stage="intake",
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


@router.patch("/api/requests/{rid}", response_model=RequestDetail)
def update_request(rid: int, body: RequestUpdate, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    if r.status not in ("draft", "submitted"):
        raise HTTPException(409, "Request can no longer be edited")
    data = body.model_dump(exclude_unset=True)  # PATCH: unsent fields stay untouched
    if not data.get("title"):
        data.pop("title", None)  # the title can change but never go blank
    for k, v in data.items():
        setattr(r, k, v)
    # Any edit invalidates the cached summary: it is keyed on answered turns only,
    # and between the two brains the summary reads nearly every field (agent:
    # _context; scripted: reach/impact) — a selective set here would drift.
    if data:
        r.summary = None
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
    return _sse_response(rid, _interview_worker)


@router.post("/api/requests/{rid}/interview", response_model=InterviewState)
def answer_interview(rid: int, body: InterviewAnswer, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    q = _current_or_generate(db, r)
    if q is None:
        return interview_state(db, r)  # nothing pending to answer (interview is done)
    order = len(r.turns)
    db.add(InterviewTurn(request=r, order=order, question=q.question, sub=q.sub, options=q.options,
                         answer=None if body.skip else (body.answer or None), skipped=body.skip))
    r.pending_question = None
    db.commit()
    db.refresh(r)
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
    db.add(InterviewTurn(request=r, order=len(r.turns), question="Anything else to add?",
                         answer=note[:2000], skipped=False))
    db.flush()  # count the added note before sizing the allowance
    # allow up to ~2 follow-ups from where we resumed (overrides the type budget), not a full grill
    r.reopen_ceiling = answered_count(r) + 2
    r.pending_question = None  # force the next question to (re)generate
    db.commit()
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
    return _prototype_state(db, r, thinking=thinking)


@router.get("/api/requests/{rid}/prototype/stream")
async def stream_prototype(rid: int):
    """SSE: drives the pending prototype revision on a worker thread, then returns the new state."""
    return _sse_response(rid, _prototype_worker)


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
    db.add(PrototypeTurn(request=r, order=len(r.prototype_turns), instruction=instr,
                         annotation=body.annotation, mode="pending"))
    db.commit()
    db.refresh(r)
    thinking = prototype_gen.queue_or_resolve(db, r)  # SYNC resolves inline; async → client streams
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
    db.add(PrototypeTurn(request=r, order=len(r.prototype_turns), instruction=None, mode="rewrite",
                         note="Reverted to an earlier version.", html=target.html))
    r.prototype_html = target.html
    r.prototype_status = "edited"
    db.commit()
    db.refresh(r)
    return _prototype_state(db, r, thinking=False)


# ---------- submit (after Review step) ----------

@router.post("/api/requests/{rid}/submit", response_model=RequestDetail)
def submit(rid: int, extra: Note | None = None, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    if r.status not in ("draft", "submitted"):
        return to_out(r, RequestDetail)  # idempotent
    # atomic claim (mirrors approve), committed BEFORE the brain runs: of two
    # concurrent submits exactly one drafts the spec — the loser sees 0 rows
    # claimed and replays idempotently. Committing first also means the write
    # lock is never held across a (possibly slow) brain call.
    claimed = db.execute(
        update(Request)
        .where(Request.id == r.id, Request.status.in_(("draft", "submitted")))
        .values(status="pending_approval")
    ).rowcount
    db.commit()
    if not claimed:
        db.refresh(r)
        return to_out(r, RequestDetail)
    try:
        if extra and extra.note:
            r.extra_detail = extra.note
        r.status = "submitted"
        emit(db, r, "milestone_summary", f"New request filed in #{r.app_name}",
             payload={"fields": {"Type": r.type, "From": r.reporter, "Stage": "Triage"},
                      "context": f"Intake interview completed · {len(r.turns)} answers", "Ref": r.ref})
        db.add(AuditEvent(request_id=r.id, actor=r.reporter, action="submitted",
                          note="filed this request and completed intake"))
        # Stage 1 brain writes the grounded Draft spec, then the spec gate is raised
        lines, note = get_brain().draft_spec(r)
        db.add_all(lines)
        r.spec_open_note = note
        r.stage = "spec"
        r.status = "pending_approval"
        r.gate = "approve_spec"
        r.stage_entered_at = utcnow()
        emit(db, r, "gate_event", "Draft spec generated — 1 open question before it can be approved",
             broadcast=True,
             payload={"gate": "approve_spec",
                      "fields": {"Status": "Awaiting approval", "Assumptions": "1", "Ref": r.ref}})
        db.commit()
    except Exception:
        db.rollback()
        r.status = "draft"  # hand the claim back — a failed brain must not strand the request
        db.commit()
        raise
    return to_out(r, RequestDetail)


@router.post("/api/requests/{rid}/steer", status_code=201)
def steer(rid: int, body: SteerIn, db: Session = Depends(get_db)):
    """Append a steer note for a RUNNING build (spec §6). 409 anywhere else:
    at a gate the human verb is approve/send-back; stalled has Recovery."""
    r = get_request(db, rid)
    if not in_flight(r):
        raise HTTPException(409, "Steer is only available while a run is in flight")
    ev = emit(db, r, "steer_note", body.note[:300], actor=body.actor, bot=False, body=body.note)
    db.add(AuditEvent(request_id=r.id, actor=body.actor, action="steered", note=body.note[:300]))
    db.flush()  # assign the event id before returning it
    db.commit()
    return {"id": ev.id, "status": "queued"}
