"""Software Factory API — FastAPI backend (ADR 0007) over the two-axis event log (ADR 0008)."""
import asyncio
import contextlib
import logging
import os

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, or_, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import api_helpers, settings, simulator
from .claude_exec import brain_mode, runner_mode
from .claude_runner import ClaudeRunner
from .db import SessionLocal, engine, get_db, migrate
from .events import emit
from .interview import MAX_QUESTIONS, answered_count, get_brain
from .models import App, AuditEvent, Comment, InterviewTurn, ProgressEvent, Request, SpecLine, utcnow
from .schemas import (
    AppIn,
    AppOut,
    CommentIn,
    CommentOut,
    EventOut,
    FeedPage,
    InterviewAnswer,
    InterviewState,
    Note,
    RequestCreate,
    RequestDetail,
    RequestOut,
    RequestUpdate,
)
from .seed import seed

log = logging.getLogger("factory")

PIPELINE_STAGES = ("architecture", "build", "review")


def create_app(*, auto_tick: float | None = None, runner: ClaudeRunner | None = None) -> FastAPI:
    logging.basicConfig(level=settings.LOG_LEVEL)  # no-op if the host app already configured logging

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        added = migrate()  # generic models-vs-schema diff — new columns never 500 existing DBs
        if added:
            log.info("migrated: added %s", ", ".join(added))
        with engine.connect() as conn:
            conn.execute(text("UPDATE requests SET stage_entered_at = updated_at WHERE stage_entered_at IS NULL"))
            conn.commit()
        with SessionLocal() as db:
            if settings.SEED_DEMO:
                seed(db)
            # one-time backfill: comments ride the progress_event log (ADR 0012)
            if not db.query(ProgressEvent).filter(ProgressEvent.kind == "comment").count():
                for c in db.query(Comment).all():
                    db.add(ProgressEvent(
                        request_id=c.request_id, subject_id=c.request.app_id, kind="comment",
                        stage=c.request.stage, actor=c.author, bot=False, broadcast=False,
                        title=c.body[:300],
                        payload={"comment_id": c.id, "initials": c.initials, "color": c.color, "body": c.body},
                        created_at=c.created_at,
                    ))
                db.commit()
            if runner_mode() == "claude":
                # a restart kills the pipeline worker threads; anything left mid-stage
                # is orphaned — escalate it so it is VISIBLE and Retry can re-drive it
                # (stop + flag, never auto-rerun: CONTEXT.md escalation, ADR 0013)
                orphans = db.query(Request).filter(
                    Request.status == "approved", Request.needs_human.is_(False),
                    Request.gate.is_(None), Request.stage.in_(PIPELINE_STAGES),
                ).all()
                for r in orphans:
                    r.needs_human = True
                    r.needs_human_reason = "Pipeline orphaned by a server restart — Retry re-runs the stage"
                    emit(db, r, "escalation",
                         "Escalated — needs a human (pipeline orphaned by a server restart)",
                         broadcast=True, payload={"Ref": r.ref, "reason": "server restart mid-pipeline"})
                    log.warning("startup: %s was orphaned mid-%s — escalated for Retry", r.ref, r.stage)
                db.commit()
        task = None
        interval = auto_tick if auto_tick is not None else settings.SIM_INTERVAL
        if runner_mode() == "claude":
            interval = 0  # the real runner drives itself; the simulator stands down
        workers = os.environ.get("WEB_CONCURRENCY", "1")
        if workers not in ("", "1"):
            # the tick loop and the pipeline threads assume ONE process; two workers
            # double-fire every tick and pipeline (see docker-compose.yml note)
            log.warning("WEB_CONCURRENCY=%s — refusing to start the tick loop in a multi-worker setup", workers)
            interval = 0
        if interval > 0:
            def safe_tick():
                try:
                    with SessionLocal() as db:
                        simulator.tick(db)
                except Exception:  # one bad tick must never kill the factory's heartbeat
                    log.exception("simulator tick failed — loop continues")

            async def loop():
                while True:
                    await asyncio.sleep(interval)
                    await asyncio.to_thread(safe_tick)  # off the event loop: a slow DB never blocks HTTP
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
        try:
            n = max(2045, int(last.ref.split("-")[1]) + 1) if last else 2045
        except (IndexError, ValueError):  # tolerate non-standard refs left by manual cleanup
            n = 2045 + last.id
        return f"REQ-{n}"

    claude_pipeline = runner or ClaudeRunner()
    api_helpers.set_pipeline(claude_pipeline)

    # ---------- ops ----------
    @app.get("/api/health")
    def health(db: Session = Depends(get_db)):
        try:
            db.execute(text("SELECT 1"))  # a green health check must mean the DB answers
        except Exception:
            log.exception("health check: database unavailable")
            raise HTTPException(503, "database unavailable")
        return {"status": "ok", "db": "ok", "brain": brain_mode(), "runner": runner_mode()}

    # ---------- apps (registry) ----------
    @app.get("/api/apps", response_model=list[AppOut])
    def list_apps(db: Session = Depends(get_db)):
        # one grouped COUNT instead of lazy-loading every request row per app
        counts = dict(
            db.query(Request.app_id, func.count())
            .filter(Request.app_id.isnot(None), Request.status.notin_(("done", "cancelled")))
            .group_by(Request.app_id).all()
        )
        out = []
        for a in db.query(App).order_by(App.id).all():
            o = AppOut.model_validate(a, from_attributes=True)
            o.open_requests = counts.get(a.id, 0)
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

    @app.get("/api/requests/{rid}", response_model=RequestDetail)
    def request_detail(rid: int, db: Session = Depends(get_db)):
        r = get_request(db, rid)
        d = to_out(r, RequestDetail)
        d.audit = [a for a in db.query(AuditEvent).filter(AuditEvent.request_id == rid).order_by(AuditEvent.created_at).all()]
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

    @app.post("/api/requests", response_model=RequestDetail, status_code=201)
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

    @app.patch("/api/requests/{rid}", response_model=RequestDetail)
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
    def current_question(db: Session, r: Request):
        """Generate-once semantics: the pending question is persisted so what the
        submitter sees is exactly what gets recorded with their answer."""
        if answered_count(r) >= MAX_QUESTIONS:
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
        st = InterviewState(done=q is None, asked=answered_count(r), total=MAX_QUESTIONS,
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
            if r.status in ("cancelled", "done"):  # a stale gate must never merge dead work
                raise HTTPException(409, f"Cannot merge a {r.status} request")
            if runner_mode() == "claude":
                claude_pipeline.approve_merge(db, r, actor)
            else:
                simulator.approve_merge(db, r, actor)
            if r.status == "done":  # the merge can escalate instead (honest deploy)
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
        # atomic claim: of two concurrent approves, exactly one wins this UPDATE —
        # the loser takes the idempotent-replay path and never double-starts a pipeline
        claimed = db.execute(
            update(Request)
            .where(Request.id == r.id, Request.status == "pending_approval")
            .values(status="approved", gate=None, stage="architecture", sim_step=0,
                    stage2_fired=True, stage_entered_at=utcnow())
        ).rowcount
        if not claimed:
            db.commit()
            db.refresh(r)
            return to_out(r, RequestDetail)
        db.refresh(r)
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
        # Retry must actually re-drive the runner: in claude mode nothing else ever
        # picks an 'approved' request back up (the simulator stands down) — without
        # this, Retry silently dead-ends and the request is stranded forever (ADR 0013)
        if runner_mode() == "claude" and r.stage in PIPELINE_STAGES:
            claude_pipeline.start(r.id)
        return to_out(r, RequestDetail)

    # ---------- comments ----------
    @app.post("/api/requests/{rid}/comments", response_model=CommentOut, status_code=201)
    def add_comment(rid: int, body: CommentIn, db: Session = Depends(get_db)):
        r = get_request(db, rid)
        c = Comment(request=r, author=body.author, initials=body.initials, color=body.color, body=body.body)
        db.add(c)
        db.add(AuditEvent(request_id=r.id, actor=body.author, action="commented"))
        db.flush()  # assign the comment id before the event references it
        # the comment also rides the one progress_event rail (ADR 0012) so feeds
        # update through the same keyset cursor as every other entry
        emit(db, r, "comment", body.body[:300], actor=body.author, bot=False,
             payload={"comment_id": c.id, "initials": body.initials, "color": body.color, "body": body.body})
        db.commit()
        return c

    # ---------- the two-axis feed (keyset cursor, ADR 0008) ----------
    def serialize_events(rows) -> list[EventOut]:
        """rows: (ProgressEvent, ref, title) tuples from a single joined query — no N+1."""
        out = []
        for ev, ref, title in rows:
            o = EventOut.model_validate(ev, from_attributes=True)
            o.request_ref, o.request_title = ref, title
            out.append(o)
        return out

    def joined_events(db: Session):
        return (
            db.query(ProgressEvent, Request.ref, Request.title)
            .outerjoin(Request, ProgressEvent.request_id == Request.id)
        )

    @app.get("/api/events/cursor")
    def events_cursor(db: Session = Depends(get_db)):
        """Where 'now' is. New clients start polling from here instead of
        replaying the whole event log from id 0 (ADR 0013)."""
        return {"cursor": db.query(func.max(ProgressEvent.id)).scalar() or 0}

    @app.get("/api/events", response_model=list[EventOut])
    def events(after: int = 0, subject: str | None = None, request_id: int | None = None,
               limit: int = 200, db: Session = Depends(get_db)):
        q = joined_events(db).filter(ProgressEvent.id > after)
        if subject:
            a = db.query(App).filter(App.key == subject).first()
            if not a:
                raise HTTPException(404, "Unknown app")
            q = q.filter(ProgressEvent.subject_id == a.id)
        if request_id:
            q = q.filter(ProgressEvent.request_id == request_id)
        rows = q.order_by(ProgressEvent.id).limit(min(limit, 500)).all()
        return serialize_events(rows)

    @app.get("/api/subjects/{key}/feed", response_model=FeedPage)
    def subject_feed(key: str, after: int = 0, limit: int = 100, db: Session = Depends(get_db)):
        """The channel feed: with no cursor, the LATEST `limit` items (ascending);
        with ?after=, only newer items. The cursor is the max event id either way."""
        a = db.query(App).filter(App.key == key).first()
        if not a:
            raise HTTPException(404, "Unknown app")
        limit = min(limit, 300)
        base = joined_events(db).filter(ProgressEvent.subject_id == a.id)
        if after > 0:
            rows = base.filter(ProgressEvent.id > after).order_by(ProgressEvent.id).limit(limit).all()
        else:
            rows = list(reversed(base.order_by(ProgressEvent.id.desc()).limit(limit).all()))
        items = serialize_events(rows)
        cursor = items[-1].id if items else after
        return FeedPage(items=items, cursor=cursor)

    @app.get("/api/requests/{rid}/comments", response_model=list[CommentOut])
    def list_comments(rid: int, db: Session = Depends(get_db)):
        return get_request(db, rid).comments

    # ---------- needs-me inbox ----------
    @app.get("/api/inbox", response_model=list[RequestOut])
    def inbox(db: Session = Depends(get_db)):
        rows = (
            db.query(Request)
            .filter(or_(Request.gate.isnot(None), Request.needs_human.is_(True)))
            .filter(Request.status.notin_(("cancelled", "done")))  # a stale gate never resurrects dead work
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
