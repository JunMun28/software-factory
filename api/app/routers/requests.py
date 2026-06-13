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

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..api_helpers import get_request, next_ref, to_out
from ..db import get_db
from ..events import emit
from ..interview import MAX_QUESTIONS, Question, answered_count, get_brain
from ..models import AuditEvent, InterviewTurn, ProgressEvent, Request, utcnow
from ..schemas import (
    EvidenceOut,
    InterviewAnswer,
    InterviewState,
    Note,
    RequestCreate,
    RequestDetail,
    RequestOut,
    RequestUpdate,
    RunStateOut,
    SteerIn,
)
from ..supervision import evidence, in_flight, run_state

router = APIRouter()


# ---------- interview helpers (module-local, no side-effects beyond DB) ----------

def current_question(db: Session, r: Request):
    """Generate-once semantics: the pending question is persisted so what the
    submitter sees is exactly what gets recorded with their answer."""
    if answered_count(r) >= MAX_QUESTIONS:
        return None
    if r.pending_question:
        return Question(**r.pending_question)
    q = get_brain().next_question(r)
    if q:
        r.pending_question = {"question": q.question, "sub": q.sub, "options": q.options, "final": q.final}
        db.commit()
    return q


def interview_state(db: Session, r: Request) -> InterviewState:
    q = current_question(db, r)
    st = InterviewState(done=q is None, asked=answered_count(r), total=MAX_QUESTIONS,
                        turns=[t for t in r.turns])
    if q:
        st.question, st.sub, st.options, st.final = q.question, q.sub, q.options, q.final
    return st


# ---------- requests CRUD ----------

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
    db.commit()
    return to_out(r, RequestDetail)


# ---------- intake interview ----------

@router.get("/api/requests/{rid}/interview", response_model=InterviewState)
def get_interview(rid: int, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    return interview_state(db, r)


@router.post("/api/requests/{rid}/interview", response_model=InterviewState)
def answer_interview(rid: int, body: InterviewAnswer, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    q = current_question(db, r)
    if q is None:
        return interview_state(db, r)
    order = len(r.turns)
    db.add(InterviewTurn(request=r, order=order, question=q.question, sub=q.sub, options=q.options,
                         answer=None if body.skip else (body.answer or None), skipped=body.skip))
    r.pending_question = None
    db.commit()
    db.refresh(r)
    return interview_state(db, r)


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
