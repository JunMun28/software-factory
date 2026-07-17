"""Software Factory API — FastAPI backend (ADR 0007) over the two-axis event log (ADR 0008)."""
import asyncio
import contextlib
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import api_helpers, heartbeat, settings, simulator, startup
from .agent_exec import runner_mode
from .agent_runner import AgentRunner
from .db import SessionLocal, migrate
from .leader import LeaderElector, get_elector
from .routers import attachments as attachments_router
from .routers import events as events_router
from .routers import gates, operators, registry, system
from .routers import harness as harness_router
from .routers import mission as mission_router
from .routers import requests as requests_router
from .seed import seed

log = logging.getLogger("factory")


def _tick_once(elector: LeaderElector) -> None:
    if not (elector.verify() or elector.try_acquire()):
        return
    with SessionLocal() as db:
        if runner_mode() == "kube":
            api_helpers.pipeline().tick(db)
        else:
            simulator.tick(db)
    heartbeat.beat()  # a beat means a full leader pass completed, not merely "process up"


def create_app(*, auto_tick: float | None = None, runner: AgentRunner | None = None) -> FastAPI:
    logging.basicConfig(level=settings.LOG_LEVEL)  # no-op if the host app already configured logging

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        added = migrate()  # generic models-vs-schema diff — new columns never 500 existing DBs
        if added:
            log.info("migrated: added %s", ", ".join(added))
        elector = get_elector()
        elector.try_acquire()
        startup.backfill_stage_clock()
        with SessionLocal() as db:
            if settings.SEED_DEMO:
                seed(db)
            startup.backfill_comment_events(db)
            if runner_mode() == "agent":
                startup.escalate_orphans(db)
        task = None
        interval = auto_tick if auto_tick is not None else settings.SIM_INTERVAL
        if runner_mode() == "agent":
            interval = 0  # the real runner drives itself; the simulator stands down
        if runner_mode() == "kube" and auto_tick is None and interval <= 0:
            interval = 5.0  # kube is tick-driven: without a heartbeat nothing ever runs
        workers = os.environ.get("WEB_CONCURRENCY", "1")
        if workers not in ("", "1"):
            # the tick loop and the pipeline threads assume ONE process; two workers
            # double-fire every tick and pipeline (see docker-compose.yml note)
            log.warning("WEB_CONCURRENCY=%s — refusing to start the tick loop in a multi-worker setup", workers)
            interval = 0
        if interval > 0:
            def safe_tick():
                try:
                    _tick_once(elector)
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

    if runner is not None:
        agent_pipeline = runner
    elif runner_mode() == "kube":
        from .kube_runner import KubeJobRunner

        agent_pipeline = KubeJobRunner()  # client is lazy: kubeconfig loads on first tick, not import
    else:
        agent_pipeline = AgentRunner()
    api_helpers.set_pipeline(agent_pipeline)

    app.include_router(system.router)
    app.include_router(registry.router)
    app.include_router(operators.router)
    app.include_router(events_router.router)
    app.include_router(requests_router.router)
    app.include_router(attachments_router.router)
    app.include_router(gates.router)
    app.include_router(mission_router.router)
    app.include_router(harness_router.router)

    return app


app = create_app()
