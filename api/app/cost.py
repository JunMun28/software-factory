"""Read-side effort, token-usage, and queue projections from durable rows.

No accounting schema is needed: StageJob timestamps and its envelope JSON are
the source of truth. Completed jobs use the exact ``created_at`` to
``completed_at`` interval; in-flight rows have no completed minutes yet. Every
durable stage execution, including infrastructure outcomes, consumes the
lifetime work budget while its domain attempt number remains retry-neutral.

Operational deferrals: ``progress_event`` stays strictly append-only. Archive
or partition work for the Azure 2 GB ceiling belongs to C9/DATA, never online
row deletion. OBS-02 liveness/tick-age watchdog work remains deferred to the
parallel heartbeat slice and must be reconciled with ``heartbeat.py`` after
the stack merges.
"""

from collections import Counter, defaultdict
from dataclasses import dataclass

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from . import settings, transitions
from .kube_jobs import KUBE_STAGES, REQUEST_STAGE
from .models import PIPELINE_STAGES, Request, StageJob

_GENERAL_CAP_ROLES = ("stage", "gate", "pbuild")
_BUILD_CAP_ROLES = ("build", "pbuild", "deploy", "pdeploy")
_PIPELINE_BUILD_STAGES = ("red", "green")
_USAGE_KEYS = ("tokens_in", "tokens_out", "tokens_total")


def app_bucket(request: Request) -> tuple[str, object]:
    """Stable fair-share identity for registered and not-yet-registered apps."""
    if request.app_id is not None:
        return ("app", request.app_id)
    if request.new_app_name:
        return ("new_app", request.new_app_name.strip().casefold())
    return ("reporter", request.reporter.strip().casefold())


def agent_attempt_count(db: Session, request_id: int) -> int:
    """Count every durable agent execution row across stages and retries."""
    return len(
        db.scalars(
            select(StageJob.id).where(
                StageJob.request_id == request_id,
                StageJob.role == "stage",
            )
        ).all()
    )


def _pipeline_candidates(
    db: Session, requests: list[Request]
) -> list["SchedulingCandidate"]:
    ids = [request.id for request in requests]
    if not ids:
        return []
    rows = db.execute(
        select(
            StageJob.request_id,
            StageJob.stage,
            StageJob.attempt,
            StageJob.role,
            StageJob.status,
            StageJob.created_at,
        ).where(StageJob.request_id.in_(ids))
    ).all()
    by_request: dict[int, list[tuple[str, int, str, str, object]]] = defaultdict(list)
    for request_id, stage, attempt, role, status, created_at in rows:
        by_request[request_id].append(
            (stage, attempt, role, status, created_at)
        )
    candidates: list[SchedulingCandidate] = []
    for request in requests:
        history = [
            row for row in by_request[request.id] if row[3] != "superseded"
        ]
        target = next(
            (
                stage
                for stage in KUBE_STAGES
                if REQUEST_STAGE[stage] == request.stage
            ),
            None,
        )
        if target is not None and request.stage_entered_at is not None:
            target_index = KUBE_STAGES.index(target)
            has_older_later_work = any(
                created_at < request.stage_entered_at
                and KUBE_STAGES.index(stage) > target_index
                for stage, _attempt, _role, _status, created_at in history
                if stage in KUBE_STAGES
            )
            if has_older_later_work:
                history = [
                    row
                    for row in history
                    if not (
                        row[4] < request.stage_entered_at
                        and row[0] in KUBE_STAGES
                        and KUBE_STAGES.index(row[0]) >= target_index
                    )
                ]
        next_stage = next(
            (
                stage
                for stage in KUBE_STAGES
                if not any(
                    row_stage == stage
                    and role == "gate"
                    and status == "succeeded"
                    for row_stage, _attempt, role, status, _created_at in history
                )
            ),
            None,
        )
        # A review-complete request with no gate is repaired by raising its
        # merge gate; it does not need a Kubernetes slot. Earlier stages with
        # complete history are explicit rewinds and do need fresh work.
        if next_stage is None and request.stage != "review":
            next_stage = next(
                (
                    stage
                    for stage in KUBE_STAGES
                    if REQUEST_STAGE[stage] == request.stage
                ),
                None,
            )
        if next_stage is not None:
            stage_history = [row for row in history if row[0] == next_stage]
            latest_attempt_rows = stage_history
            if stage_history:
                latest_attempt = max(row[1] for row in stage_history)
                latest_attempt_rows = [
                    row for row in stage_history if row[1] == latest_attempt
                ]
            stage_succeeded = any(
                role == "stage" and status == "succeeded"
                for _stage, _attempt, role, status, _created_at in latest_attempt_rows
            )
            gate_rows = [
                row for row in latest_attempt_rows if row[2] == "gate"
            ]
            gate_status = gate_rows[-1][3] if gate_rows else None
            pipeline_role = (
                "gate"
                if stage_succeeded
                and (gate_status is None or gate_status == "infra")
                else "stage"
            )
            budget_exhausted = (
                pipeline_role == "stage"
                and agent_attempt_count(db, request.id)
                >= max(0, settings.REQUEST_ATTEMPT_BUDGET)
            )
            candidates.append(
                SchedulingCandidate(
                    request=request,
                    kind="pipeline",
                    pipeline_stage=next_stage,
                    pipeline_role=pipeline_role,
                    attempt_budget_exhausted=budget_exhausted,
                )
            )
        elif request.stage == "review":
            candidates.append(SchedulingCandidate(request, "pipeline_repair"))
    return candidates


def _preview_candidates(db: Session) -> list["SchedulingCandidate"]:
    if not settings.preview_enabled():
        return []
    requests = db.scalars(
        select(Request)
        .where(
            Request.status == transitions.APPROVED,
            ~Request.needs_human,
            Request.gate.is_(None),
            Request.stage == "preview",
        )
        .order_by(Request.id)
    ).all()
    if not requests:
        return []
    rows = db.scalars(
        select(StageJob)
        .where(
            StageJob.request_id.in_([request.id for request in requests]),
            StageJob.role.in_(("pbuild", "pdeploy")),
        )
        .order_by(StageJob.id)
    ).all()
    by_request: dict[int, list[StageJob]] = defaultdict(list)
    for row in rows:
        by_request[row.request_id].append(row)
    candidates: list[SchedulingCandidate] = []
    for request in requests:
        history = by_request[request.id]
        if any(
            row.role == "pdeploy" and row.status in ("running", "succeeded")
            for row in history
        ):
            continue
        builds = [
            row
            for row in history
            if row.role == "pbuild"
            and (row.envelope or {}).get("round") == request.preview_round
        ]
        latest_build = builds[-1] if builds else None
        if latest_build is None and _preview_slots_full(db, request):
            continue
        if latest_build is None or latest_build.status in (
            "failed",
            "timed_out",
            "infra",
        ):
            candidates.append(SchedulingCandidate(request, "pbuild"))
        elif latest_build.status == "succeeded":
            candidates.append(SchedulingCandidate(request, "pdeploy"))
    return candidates


def _preview_slots_full(db: Session, request: Request) -> bool:
    active = 0
    others = db.scalars(
        select(Request).where(
            Request.id != request.id,
            Request.stage.in_(("preview", "deploy")),
        )
    ).all()
    for other in others:
        rows = db.scalars(
            select(StageJob)
            .where(
                StageJob.request_id == other.id,
                StageJob.role.in_(("pdeploy", "pteardown")),
            )
            .order_by(StageJob.id)
        ).all()
        marker = next(
            (row for row in reversed(rows) if row.role == "pteardown"), None
        )
        if any(
            row.role == "pdeploy"
            and row.status in ("running", "succeeded")
            and (marker is None or row.id > marker.id)
            for row in rows
        ):
            active += 1
    return active >= settings.PREVIEW_CAP


def _deploy_candidates(db: Session) -> list["SchedulingCandidate"]:
    if not settings.app_deploy_enabled():
        return []
    requests = db.scalars(
        select(Request)
        .where(
            Request.status == transitions.APPROVED,
            ~Request.needs_human,
            Request.gate.is_(None),
            Request.stage == "deploy",
        )
        .order_by(Request.id)
    ).all()
    if not requests:
        return []
    rows = db.scalars(
        select(StageJob)
        .where(
            StageJob.request_id.in_([request.id for request in requests]),
            StageJob.role.in_(("build", "deploy")),
        )
        .order_by(StageJob.id)
    ).all()
    by_request: dict[int, list[StageJob]] = defaultdict(list)
    for row in rows:
        by_request[row.request_id].append(row)
    candidates: list[SchedulingCandidate] = []
    for request in requests:
        history = by_request[request.id]
        build = next(
            (row for row in reversed(history) if row.role == "build"), None
        )
        deploy = next(
            (row for row in reversed(history) if row.role == "deploy"), None
        )
        if build is None or build.status in ("failed", "timed_out", "infra"):
            candidates.append(SchedulingCandidate(request, "build"))
        elif build.status == "succeeded" and (
            deploy is None or deploy.status not in ("running", "succeeded")
        ):
            candidates.append(SchedulingCandidate(request, "deploy"))
    return candidates


def scheduling_candidates(db: Session) -> list["SchedulingCandidate"]:
    """Every startable unit, in the exact order used by runner and cost views."""
    candidates = [
        *_pipeline_candidates(db, runnable_requests(db)),
        *_preview_candidates(db),
        *_deploy_candidates(db),
    ]
    return sorted(candidates, key=lambda candidate: candidate.request.id)


@dataclass(frozen=True)
class SchedulingCandidate:
    request: Request
    kind: str
    pipeline_stage: str | None = None
    pipeline_role: str | None = None
    attempt_budget_exhausted: bool = False

    @property
    def uses_general_slot(self) -> bool:
        return not self.attempt_budget_exhausted and self.kind in (
            "pipeline",
            "pbuild",
        )

    @property
    def uses_build_slot(self) -> bool:
        return not self.attempt_budget_exhausted and (
            self.kind in _BUILD_CAP_ROLES
            or (
                self.kind == "pipeline"
                and self.pipeline_stage in _PIPELINE_BUILD_STAGES
            )
        )

    @property
    def uses_app_slot(self) -> bool:
        return not self.attempt_budget_exhausted and self.kind in (
            "pipeline",
            "pbuild",
        )


def _running_build_rows(db: Session) -> list[StageJob]:
    return db.scalars(
        select(StageJob).where(
            StageJob.status == "running",
            or_(
                StageJob.role.in_(_BUILD_CAP_ROLES),
                (
                    StageJob.role.in_(("stage", "gate"))
                    & StageJob.stage.in_(_PIPELINE_BUILD_STAGES)
                ),
            ),
        )
    ).all()


def build_slots_full(db: Session) -> bool:
    return len(_running_build_rows(db)) >= settings.BUILD_CAP


def can_start_agent_attempt(
    db: Session, request_id: int, stage: str, attempt: int
) -> bool:
    del stage, attempt  # every spawn creates a fresh durable execution row
    return agent_attempt_count(db, request_id) < max(
        0, settings.REQUEST_ATTEMPT_BUDGET
    )


def runnable_requests(db: Session) -> list[Request]:
    return db.scalars(
        select(Request)
        .where(
            Request.status == transitions.APPROVED,
            ~Request.needs_human,
            Request.gate.is_(None),
            Request.stage.in_(PIPELINE_STAGES),
        )
        .order_by(Request.id)
    ).all()


@dataclass
class SchedulingPool:
    """Mutable, in-memory view of slots reserved during one scheduler pass."""

    capacity: int
    build_capacity: int
    busy: set[int]
    by_app: Counter
    per_app_cap: int

    def can_start(self, candidate: SchedulingCandidate) -> bool:
        request = candidate.request
        return (
            request.id not in self.busy
            and (not candidate.uses_general_slot or self.capacity > 0)
            and (not candidate.uses_build_slot or self.build_capacity > 0)
            and (
                not candidate.uses_app_slot
                or self.by_app[app_bucket(request)] < self.per_app_cap
            )
        )

    def record_start(self, candidate: SchedulingCandidate) -> None:
        request = candidate.request
        if candidate.uses_general_slot:
            self.capacity -= 1
        if candidate.uses_build_slot:
            self.build_capacity -= 1
        self.busy.add(request.id)
        if candidate.uses_app_slot:
            self.by_app[app_bucket(request)] += 1


def scheduling_pool(
    db: Session,
    *,
    extra_busy: set[int] | None = None,
) -> SchedulingPool:
    running = db.scalars(
        select(StageJob).where(
            StageJob.status == "running",
            StageJob.role.in_(_GENERAL_CAP_ROLES),
        )
    ).all()
    build_running = _running_build_rows(db)
    all_running = list(
        {row.id: row for row in [*running, *build_running]}.values()
    )
    requests = {
        request.id: request
        for request in db.scalars(
            select(Request).where(
                Request.id.in_({row.request_id for row in all_running})
            )
        ).all()
    }
    by_app: Counter[tuple[str, object]] = Counter(
        app_bucket(requests[row.request_id])
        for row in running
        if row.request_id in requests
    )
    return SchedulingPool(
        capacity=max(0, settings.KUBE_JOB_CAP - len(running)),
        build_capacity=max(0, settings.BUILD_CAP - len(build_running)),
        busy={row.request_id for row in all_running} | (extra_busy or set()),
        by_app=by_app,
        per_app_cap=max(1, settings.PER_APP_CAP),
    )


def waiting_request_ids(db: Session) -> list[int]:
    """Project the next fair scheduler pass without mutating runner state."""
    pool = scheduling_pool(db)
    waiting: list[int] = []
    for candidate in scheduling_candidates(db):
        request = candidate.request
        if request.id in pool.busy:
            continue
        if pool.can_start(candidate):
            pool.record_start(candidate)
        else:
            waiting.append(request.id)
    return waiting


def queue_position(db: Session, request_id: int) -> int | None:
    try:
        return waiting_request_ids(db).index(request_id) + 1
    except ValueError:
        return None


def _minutes(row: StageJob) -> float:
    if row.completed_at is None:
        return 0.0
    return max(0.0, (row.completed_at - row.created_at).total_seconds() / 60.0)


def _usage(rows: list[StageJob]) -> dict[str, int]:
    totals: Counter[str] = Counter()
    present: set[str] = set()
    for row in rows:
        usage = (row.envelope or {}).get("usage") or {}
        if not isinstance(usage, dict):
            continue
        for key in _USAGE_KEYS:
            value = usage.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                totals[key] += value
                present.add(key)
    return {key: totals[key] for key in _USAGE_KEYS if key in present}


def aggregate_rows(rows: list[StageJob]) -> dict:
    stages: dict[str, list[StageJob]] = defaultdict(list)
    for row in rows:
        stages[row.stage].append(row)

    def summary(group: list[StageJob]) -> dict:
        return {
            "job_count": len(group),
            "job_minutes": round(sum(_minutes(row) for row in group), 6),
            "usage": _usage(group),
        }

    result = summary(rows)
    result["attempt_count"] = sum(row.role == "stage" for row in rows)
    result["stages"] = {
        stage: summary(group) for stage, group in sorted(stages.items())
    }
    return result


def request_cost(db: Session, request: Request) -> dict:
    rows = db.scalars(
        select(StageJob)
        .where(StageJob.request_id == request.id)
        .order_by(StageJob.id)
    ).all()
    return {
        "request_id": request.id,
        "ref": request.ref,
        **aggregate_rows(rows),
        "queue_position": queue_position(db, request.id),
        "attempt_budget": settings.REQUEST_ATTEMPT_BUDGET,
        "attempts_remaining": max(
            0, settings.REQUEST_ATTEMPT_BUDGET - agent_attempt_count(db, request.id)
        ),
    }


def fleet_cost(db: Session) -> dict:
    rows = db.scalars(select(StageJob).order_by(StageJob.id)).all()
    waiting = waiting_request_ids(db)
    return {
        "request_count": len({row.request_id for row in rows}),
        **aggregate_rows(rows),
        "queued_requests": len(waiting),
    }
