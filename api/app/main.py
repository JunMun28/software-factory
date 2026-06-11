"""Software Factory API — FastAPI backend (ADR 0007) over the two-axis event log (ADR 0008)."""
import asyncio
import contextlib
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from . import api_helpers, settings, simulator
from .claude_exec import runner_mode
from .claude_runner import ClaudeRunner
from .db import SessionLocal, engine, migrate
from .events import emit
from .models import Comment, ProgressEvent, Request
from .routers import events as events_router
from .routers import gates, registry, system
from .routers import requests as requests_router
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

    claude_pipeline = runner or ClaudeRunner()
    api_helpers.set_pipeline(claude_pipeline)

    app.include_router(system.router)
    app.include_router(registry.router)
    app.include_router(events_router.router)
    app.include_router(requests_router.router)
    app.include_router(gates.router)

    return app


app = create_app()
