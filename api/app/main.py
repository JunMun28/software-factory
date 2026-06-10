"""Software Factory API — FastAPI backend (ADR 0007) over the two-axis event log (ADR 0008)."""
import asyncio
import contextlib
import os

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from . import simulator
from .claude_exec import brain_mode, runner_mode
from .claude_runner import ClaudeRunner
from .db import Base, SessionLocal, engine, get_db
from .events import emit
from .interview import MAX_QUESTIONS, get_brain
from .models import App, AuditEvent, Comment, InterviewTurn, ProgressEvent, Request, SpecLine, utcnow
from .schemas import (
    AppIn, AppOut, CommentIn, CommentOut, EventOut, InterviewAnswer, InterviewState,
    Note, RequestCreate, RequestDetail, RequestOut,
)
from .seed import seed


def create_app(*, auto_tick: float | None = None) -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        Base.metadata.create_all(engine)
        # tiny additive migration for pre-existing local DBs (create_all won't add columns)
        with engine.connect() as conn:
            cols = {row[1] for row in conn.execute(text("PRAGMA table_info(requests)"))}
            if "stage_entered_at" not in cols:
                conn.execute(text("ALTER TABLE requests ADD COLUMN stage_entered_at DATETIME"))
                conn.execute(text("UPDATE requests SET stage_entered_at = updated_at"))
                conn.commit()
            if "pending_question" not in cols:
                conn.execute(text("ALTER TABLE requests ADD COLUMN pending_question JSON"))
                conn.commit()
        with SessionLocal() as db:
            seed(db)
        task = None
        interval = auto_tick if auto_tick is not None else float(os.environ.get("SIM_INTERVAL", "0") or 0)
        if runner_mode() == "claude":
            interval = 0  # the real runner drives itself; the simulator stands down
        if interval > 0:
            async def loop():
                while True:
                    await asyncio.sleep(interval)
                    with SessionLocal() as db:
                        simulator.tick(db)
            task = asyncio.create_task(loop())
        yield
        if task:
            task.cancel()

    app = FastAPI(title="Software Factory API", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---------- helpers ----------
    def to_out(r: Request, model=RequestOut, **extra):
        d = model.model_validate(r, from_attributes=True)
        d.app_name = r.app_name
        d.app_key = r.app.key if r.app else None
        d.repo = r.app.repo if r.app else None
        for k, v in extra.items():
            setattr(d, k, v)
        return d

    def get_request(db: Session, rid: int) -> Request:
        r = db.get(Request, rid)
        if not r:
            raise HTTPException(404, "Request not found")
        return r

    def next_ref(db: Session) -> str:
        last = db.query(Request).order_by(Request.id.desc()).first()
        n = 2045 if not last else max(2045, int(last.ref.split("-")[1]) + 1)
        return f"REQ-{n}"

    claude_pipeline = ClaudeRunner()

    # ---------- ops ----------
    @app.get("/api/health")
    def health():
        return {"status": "ok", "brain": brain_mode(), "runner": runner_mode()}

    # ---------- apps (registry) ----------
    @app.get("/api/apps", response_model=list[AppOut])
    def list_apps(db: Session = Depends(get_db)):
        out = []
        for a in db.query(App).order_by(App.id).all():
            o = AppOut.model_validate(a, from_attributes=True)
            o.open_requests = sum(1 for r in a.requests if r.status not in ("done", "cancelled"))
            o.unread = o.open_requests > 0 and not a.muted
            out.append(o)
        return out

    @app.post("/api/apps", response_model=AppOut)
    def create_app_entry(body: AppIn, db: Session = Depends(get_db)):
        key = body.name.lower().replace(" ", "-")[:40]
        if db.query(App).filter(App.key == key).first():
            raise HTTPException(409, "App already registered")
        a = App(key=key, name=body.name, owner=body.owner, repo=body.repo, provisioning=body.provisioning, muted=body.muted)
        db.add(a)
        db.commit()
        return AppOut.model_validate(a, from_attributes=True)

    @app.patch("/api/apps/{app_id}", response_model=AppOut)
    def update_app(app_id: int, body: AppIn, db: Session = Depends(get_db)):
        a = db.get(App, app_id)
        if not a:
            raise HTTPException(404, "App not found")
        a.name, a.owner, a.repo, a.provisioning, a.muted = body.name, body.owner, body.repo, body.provisioning, body.muted
        db.commit()
        return AppOut.model_validate(a, from_attributes=True)

    # ---------- requests ----------
    @app.get("/api/requests", response_model=list[RequestOut])
    def list_requests(mine: str | None = None, active: bool = False, db: Session = Depends(get_db)):
        q = db.query(Request).filter(Request.status != "draft")
        if mine:
            q = q.filter(Request.reporter == mine)
        rows = q.order_by(Request.created_at.desc()).all()
        if active:
            rows = [r for r in rows if r.status not in ("done", "cancelled")]
        # latest milestone per request, in one grouped query (the Pipeline row's context line)
        latest = dict(
            db.query(ProgressEvent.request_id, func.max(ProgressEvent.id))
            .filter(ProgressEvent.request_id.isnot(None))
            .group_by(ProgressEvent.request_id)
            .all()
        )
        titles = {
            ev.id: ev.title
            for ev in db.query(ProgressEvent).filter(ProgressEvent.id.in_(latest.values())).all()
        } if latest else {}
        return [to_out(r, last_event=titles.get(latest.get(r.id))) for r in rows]

    @app.get("/api/requests/{rid}", response_model=RequestDetail)
    def request_detail(rid: int, db: Session = Depends(get_db)):
        r = get_request(db, rid)
        d = to_out(r, RequestDetail)
        d.audit = [a for a in db.query(AuditEvent).filter(AuditEvent.request_id == rid).order_by(AuditEvent.created_at).all()]
        # naive duplicate hint: another open-or-done request on the same app sharing a title word >4 chars
        if r.app_id:
            words = {w.lower().strip(",.") for w in r.title.split() if len(w) > 4}
            for other in db.query(Request).filter(Request.app_id == r.app_id, Request.id != r.id).all():
                ow = {w.lower().strip(",.") for w in other.title.split() if len(w) > 4}
                if words & ow:
                    d.duplicate = {"ref": other.ref, "title": other.title, "id": other.id}
                    break
        return d

    @app.post("/api/requests", response_model=RequestDetail, status_code=201)
    def create_request(body: RequestCreate, db: Session = Depends(get_db)):
        # persist-first (PRD hardening #4): the Request exists before anything else
        r = Request(
            ref=next_ref(db), title=body.title or "(untitled request)", description=body.description,
            type=body.type, urgency=body.urgency, app_id=body.app_id, new_app_name=body.new_app_name,
            bug_where=body.bug_where, status="draft", stage="intake",
            reporter=body.reporter, reporter_initials=body.reporter_initials,
        )
        db.add(r)
        db.commit()
        return to_out(r, RequestDetail)

    @app.patch("/api/requests/{rid}", response_model=RequestDetail)
    def update_request(rid: int, body: RequestCreate, db: Session = Depends(get_db)):
        r = get_request(db, rid)
        if r.status not in ("draft", "submitted"):
            raise HTTPException(409, "Request can no longer be edited")
        r.title = body.title or r.title
        r.description = body.description
        r.type = body.type
        r.app_id = body.app_id
        r.new_app_name = body.new_app_name
        r.bug_where = body.bug_where
        r.urgency = body.urgency
        db.commit()
        return to_out(r, RequestDetail)

    # ---------- intake interview ----------
    def current_question(db: Session, r: Request):
        """Generate-once semantics: the pending question is persisted so what the
        submitter sees is exactly what gets recorded with their answer."""
        answered = len([t for t in r.turns if t.answer is not None or t.skipped])
        if answered >= MAX_QUESTIONS:
            return None
        if r.pending_question:
            from .interview import Question
            return Question(**r.pending_question)
        q = get_brain().next_question(r)
        if q:
            r.pending_question = {"question": q.question, "sub": q.sub, "options": q.options, "final": q.final}
            db.commit()
        return q

    def interview_state(db: Session, r: Request) -> InterviewState:
        q = current_question(db, r)
        answered = len([t for t in r.turns if t.answer is not None or t.skipped])
        st = InterviewState(done=q is None, asked=answered, total=MAX_QUESTIONS,
                            turns=[t for t in r.turns])
        if q:
            st.question, st.sub, st.options, st.final = q.question, q.sub, q.options, q.final
        return st

    @app.get("/api/requests/{rid}/interview", response_model=InterviewState)
    def get_interview(rid: int, db: Session = Depends(get_db)):
        r = get_request(db, rid)
        return interview_state(db, r)

    @app.post("/api/requests/{rid}/interview", response_model=InterviewState)
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
    @app.post("/api/requests/{rid}/submit", response_model=RequestDetail)
    def submit(rid: int, extra: Note | None = None, db: Session = Depends(get_db)):
        r = get_request(db, rid)
        if r.status not in ("draft", "submitted"):
            return to_out(r, RequestDetail)  # idempotent
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
        return to_out(r, RequestDetail)

    # ---------- gates & recovery actions ----------
    @app.post("/api/requests/{rid}/approve", response_model=RequestDetail)
    def approve(rid: int, body: Note | None = None, db: Session = Depends(get_db)):
        r = get_request(db, rid)
        actor = (body.actor if body else None) or "Kim P."
        if r.gate == "approve_merge":
            if runner_mode() == "claude":
                claude_pipeline.approve_merge(db, r, actor)
            else:
                simulator.approve_merge(db, r, actor)
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
        if not r.stage2_fired:
            r.stage2_fired = True
        r.status = "approved"
        r.gate = None
        r.stage = "architecture"
        r.sim_step = 0
        r.stage_entered_at = utcnow()
        repo = r.app.repo if r.app else f"micron/{(r.new_app_name or r.title).lower().replace(' ', '-')[:30]}"
        emit(db, r, "gate_event", f"Spec approved by {actor} — repo ready, SPEC.md PR open, Stage 2 started",
             actor=actor, bot=False, broadcast=True,
             payload={"gate": "approve_spec", "repo": repo, "Ref": r.ref})
        db.add(AuditEvent(request_id=r.id, actor=actor, action="approved",
                          note="approved the spec — repo created, SPEC.md PR opened, Stage 2 fired"))
        db.commit()
        if runner_mode() == "claude":
            claude_pipeline.start(r.id)  # Stage 2 fires for real: Claude Code in the Subject workspace
        return to_out(r, RequestDetail)

    @app.post("/api/requests/{rid}/send-back", response_model=RequestDetail)
    def send_back(rid: int, body: Note, db: Session = Depends(get_db)):
        r = get_request(db, rid)
        if r.status not in ("pending_approval", "submitted"):
            raise HTTPException(409, f"Cannot send back from status '{r.status}'")
        r.status = "sent_back"
        r.gate = None
        r.send_back_question = body.note or "Could you add a bit more detail?"
        r.send_back_rounds += 1
        r.stage_entered_at = utcnow()
        emit(db, r, "gate_event", "Sent back to the submitter — one question is blocking the spec",
             actor=body.actor, bot=False, broadcast=True, payload={"gate": "send_back", "Ref": r.ref})
        db.add(AuditEvent(request_id=r.id, actor=body.actor, action="sent_back", note=body.note))
        db.commit()
        return to_out(r, RequestDetail)

    @app.post("/api/requests/{rid}/respond", response_model=RequestDetail)
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

    @app.post("/api/requests/{rid}/cancel", response_model=RequestDetail)
    def cancel(rid: int, body: Note | None = None, db: Session = Depends(get_db)):
        r = get_request(db, rid)
        if r.status in ("done", "cancelled"):
            return to_out(r, RequestDetail)
        r.status = "cancelled"
        r.gate = None
        r.needs_human = False
        actor = (body.actor if body else None) or "Kim P."
        emit(db, r, "recovery_action", f"Request cancelled by {actor}",
             actor=actor, bot=False, payload={"Ref": r.ref})
        db.add(AuditEvent(request_id=r.id, actor=actor, action="cancelled", note=body.note if body else None))
        db.commit()
        return to_out(r, RequestDetail)

    @app.post("/api/requests/{rid}/retry", response_model=RequestDetail)
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
        return to_out(r, RequestDetail)

    # ---------- comments ----------
    @app.post("/api/requests/{rid}/comments", response_model=CommentOut, status_code=201)
    def add_comment(rid: int, body: CommentIn, db: Session = Depends(get_db)):
        r = get_request(db, rid)
        c = Comment(request=r, author=body.author, initials=body.initials, color=body.color, body=body.body)
        db.add(c)
        db.add(AuditEvent(request_id=r.id, actor=body.author, action="commented"))
        db.commit()
        return c

    # ---------- the two-axis feed (keyset cursor, ADR 0008) ----------
    @app.get("/api/events", response_model=list[EventOut])
    def events(after: int = 0, subject: str | None = None, request_id: int | None = None,
               limit: int = 200, db: Session = Depends(get_db)):
        q = db.query(ProgressEvent).filter(ProgressEvent.id > after)
        if subject:
            a = db.query(App).filter(App.key == subject).first()
            if not a:
                raise HTTPException(404, "Unknown app")
            q = q.filter(ProgressEvent.subject_id == a.id)
        if request_id:
            q = q.filter(ProgressEvent.request_id == request_id)
        rows = q.order_by(ProgressEvent.id).limit(min(limit, 500)).all()
        out = []
        for ev in rows:
            o = EventOut.model_validate(ev, from_attributes=True)
            if ev.request_id:
                r = db.get(Request, ev.request_id)
                if r:
                    o.request_ref, o.request_title = r.ref, r.title
            out.append(o)
        return out

    @app.get("/api/requests/{rid}/comments", response_model=list[CommentOut])
    def list_comments(rid: int, db: Session = Depends(get_db)):
        return get_request(db, rid).comments

    # ---------- needs-me inbox ----------
    @app.get("/api/inbox", response_model=list[RequestOut])
    def inbox(db: Session = Depends(get_db)):
        rows = (
            db.query(Request)
            .filter(or_(Request.gate.isnot(None), Request.needs_human.is_(True)))
            .order_by(Request.needs_human.desc(), Request.created_at.desc())
            .all()
        )
        return [to_out(r) for r in rows]

    # ---------- simulator ----------
    @app.post("/api/simulator/tick")
    def sim_tick(db: Session = Depends(get_db)):
        if runner_mode() == "claude":
            return {"moved": [], "note": "runner=claude — the real agents drive the stages"}
        return {"moved": simulator.tick(db)}

    return app


app = create_app()
