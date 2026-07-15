"""KubeJobRunner — pipeline stages as Kubernetes Jobs (Plan B1; spec §4-§6).

FACTORY_RUNNER=kube. The factory stays a DB state machine driven by the
leader's tick: nothing pushes work — each tick the runner *notices* runnable
requests and running Jobs and advances them one step (spec §4; poll from the
tick loop, no watch API). Request lifecycle transitions go through
transitions.apply()/apply_committed(); raise_merge_gate and escalations are
epoch-fenced, while durable StageJob grades themselves are not epoch-fenced.
Job creation is an external side effect and rides the intent log (spec §3.3).

Orchestrator-owned hard lines (spec §5/§6):
  * wall clock per (stage, attempt) — a partitioned node cannot strand a request;
  * only StageJob rows with status='running' are ever polled or graded — late
    completions of superseded attempts are discarded;
  * the orchestrator attempts output capture before every Job deletion,
    including timeout, reap, and supersede paths; running-pod capture is best-effort
    because log transfer itself can still fail;
  * a missing gate verdict re-runs the same attempt, but three consecutive infra outcomes
    consume that attempt as a gate failure instead of churning forever;
  * frozen surface: green's gate must report exactly the surface_hash red's
    succeeded gate recorded — a weakened test surface fails the attempt even
    when the (untrusted) gate pod claims a pass;
  * a failed attempt retries ONCE with the gate's reason as feedback
    (KUBE_MAX_ATTEMPTS=2), then escalates. Human Retry grants exactly one
    fresh attempt (attempts only ever increment — names stay unique).

Tick order matters: reap (cancel wins) → observe running Jobs → spawn next
work oldest-first under the Job cap.
"""
import logging
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import intents, settings, transitions, verification
from .events import emit
from .kube_client import KubeClient
from .kube_jobs import (
    KUBE_STAGES,
    REQUEST_STAGE,
    gate_job_manifest,
    job_name,
    parse_envelope,
    stage_job_manifest,
)
from .leader import get_elector
from .models import PIPELINE_STAGES, Request, StageJob, utcnow
from .transitions import FACTORY, IntentSpec

log = logging.getLogger("factory.kube")

LOGS_TAIL = 20_000  # chars of captured NDJSON persisted per Job
GATE_INFRA_LIMIT = 3

# feed parity with AgentRunner's milestone texts (test_agent_runner asserts these prefixes)
MILESTONES = {
    "architecture": (
        "Architecture plan committed — graded at the pinned SHA",
        {"Gate": "Architecture · passed", "Agent": "Factory agent"},
    ),
    "red": (
        "RED: failing tests authored — fail for the right reason",
        {"Gate": "RED · passed", "Agent": "Factory agent"},
    ),
    "green": (
        "GREEN: gate passed; implementer touched no test files",
        {"Gate": "GREEN + Test-isolation · passed", "Agent": "Factory agent"},
    ),
    "review": (
        "Review report committed — graded at the pinned SHA",
        {"Artifacts": "review summary", "Agent": "Factory agent"},
    ),
}


class KubeJobRunner:
    def __init__(self, client: KubeClient | None = None):
        self._client = client
        self._observe_failures: dict[str, int] = {}

    @property
    def client(self) -> KubeClient:
        if self._client is None:  # first USE, never import/startup: tests and sim mode never pay kubeconfig loading
            from .kube_client import RealKubeClient

            self._client = RealKubeClient()
        return self._client

    # ---------- tick ----------
    def tick(self, db: Session) -> list[str]:
        moved: list[str] = []
        defer_spawn: set[int] = set()
        self._reap_dead_requests(db, moved)
        for sj in db.scalars(
            select(StageJob).where(StageJob.status == "running").order_by(StageJob.id)
        ).all():
            req = db.get(Request, sj.request_id)
            all_rows = db.scalars(
                select(StageJob)
                .where(StageJob.request_id == req.id)
                .order_by(StageJob.attempt, StageJob.id)
            ).all()
            self._supersede_rewound_rows(db, req, all_rows)
            if sj.status != "running":
                continue
            try:
                self._observe(db, req, sj, moved)
                if sj.status in ("failed", "timed_out", "infra"):
                    # Failure and infra recovery are next-tick work. This is
                    # especially important for deterministic-name 409s: the
                    # predecessor may still be terminating in this tick.
                    defer_spawn.add(req.id)
            except Exception as exc:  # one broken Job stalls only its request (ADR 0013)
                db.rollback()
                failures = self._observe_failures.get(sj.job_name, 0) + 1
                self._observe_failures[sj.job_name] = failures
                if failures == 1:
                    log.warning("kube observe flaked for %s: %s", sj.job_name, exc)
                    continue
                log.exception("kube observe failed twice for %s", sj.job_name)
                self._observe_failures.pop(sj.job_name, None)
                req = db.get(Request, sj.request_id)
                self._escalate(db, req, f"Job observation failed for {sj.job_name}: {exc}")
        running = db.scalars(select(StageJob).where(StageJob.status == "running")).all()
        busy = {r.request_id for r in running} | defer_spawn
        capacity = settings.KUBE_JOB_CAP - len(running)
        runnable = db.scalars(
            select(Request)
            .where(
                Request.status == transitions.APPROVED,
                ~Request.needs_human,
                Request.gate.is_(None),
                Request.stage.in_(PIPELINE_STAGES),
            )
            .order_by(Request.id)  # oldest-runnable-first fairness (spec §3.6)
        ).all()
        for req in runnable:
            if capacity <= 0:
                break
            if req.id in busy:
                continue
            try:
                if self._spawn_next(db, req, moved):
                    capacity -= 1
            except Exception as exc:
                log.exception("kube spawn failed for %s", req.ref)
                db.rollback()
                self._escalate(db, req, f"Pipeline spawn failed: {exc}")
        return moved

    # ---------- reap: cancel (or any exit from the runnable set) wins ----------
    def _reap_dead_requests(self, db: Session, moved: list[str]) -> None:
        """Close running Jobs whose requests left the runnable set.

        Capture is attempted before deletion, including logs from a pod whose
        Job is still reported as running.
        """
        for sj in db.scalars(select(StageJob).where(StageJob.status == "running")).all():
            req = db.get(Request, sj.request_id)
            if req and req.status == transitions.APPROVED and not req.needs_human:
                continue
            try:
                view = self.client.get_job(sj.job_name, capture=True)
                sj.logs_tail = (view.logs or "")[-LOGS_TAIL:] or None
                sj.envelope = parse_envelope(view.termination_message)
                self.client.delete_job(sj.job_name)
                sj.status = "reaped"
                sj.completed_at = utcnow()
                db.commit()
                moved.append(f"{req.ref if req else sj.request_id}: reaped {sj.job_name}")
            except Exception:
                log.exception("kube reap failed for %s", sj.job_name)
                db.rollback()

    # ---------- observe one running Job ----------
    def _observe(self, db: Session, req: Request, sj: StageJob, moved: list[str]) -> None:
        view = self.client.get_job(sj.job_name)
        self._observe_failures.pop(sj.job_name, None)
        if view.phase != "absent" and sj.job_uid and view.uid and view.uid != sj.job_uid:
            # Same name, different Job — not ours (out-of-band recreate).
            # Never grade a stranger: infra, re-run (spec §5 stale-discard).
            sj.status = "infra"
            sj.completed_at = utcnow()
            db.commit()
            moved.append(f"{req.ref}: {sj.job_name} uid changed under us — will re-run")
            return
        now = utcnow()
        if view.phase == "running":
            if now < sj.deadline_at:
                return
            # orchestrator wall clock (spec §5): fires regardless of Job status —
            # a partitioned node cannot strand the request. Capture is attempted
            # first, including logs from a pod whose Job is still running.
            view = self.client.get_job(sj.job_name, capture=True)
            sj.envelope = parse_envelope(view.termination_message)
            sj.logs_tail = (view.logs or "")[-LOGS_TAIL:] or None
            self.client.delete_job(sj.job_name)
            sj.status = "timed_out"
            sj.completed_at = now
            db.commit()
            moved.append(f"{req.ref}: {sj.job_name} exceeded its wall clock")
            self._after_failure(
                db,
                req,
                sj,
                f"{sj.stage} {sj.role} Job exceeded its wall clock (attempt {sj.attempt})",
                moved,
            )
            return
        if view.phase == "absent":
            # vanished under us (external deletion / create replay that never landed):
            # infra, not a domain failure — the same attempt re-runs
            if sj.role == "gate":
                self._grade(db, req, sj, view.phase, None, moved)
                return
            sj.status = "infra"
            sj.completed_at = now
            db.commit()
            moved.append(f"{req.ref}: {sj.job_name} vanished — will re-run")
            return
        # terminal: capture BEFORE deletion — the orchestrator owns the Job
        # lifecycle and never loses an outcome (spec §5, §8)
        envelope = parse_envelope(view.termination_message)
        sj.envelope = envelope
        sj.logs_tail = (view.logs or "")[-LOGS_TAIL:] or None
        self.client.delete_job(sj.job_name)
        sj.completed_at = now
        if sj.role == "gate":
            self._grade(db, req, sj, view.phase, envelope, moved)
        else:
            self._finish_stage_job(db, req, sj, view.phase, envelope, moved)

    def _finish_stage_job(
        self,
        db: Session,
        req: Request,
        sj: StageJob,
        phase: str,
        envelope: dict | None,
        moved: list[str],
    ) -> None:
        if phase == "succeeded" and envelope is None:
            # log/envelope-capture failure is its own escalation reason (spec §5)
            sj.status = "infra"
            db.commit()
            self._escalate(
                db,
                req,
                f"Stage output could not be captured for {sj.job_name} — envelope missing",
            )
            moved.append(f"{req.ref}: escalated — capture failed for {sj.job_name}")
            return
        if phase == "succeeded" and envelope.get("outcome") == "ok":
            sj.status = "succeeded"
            db.commit()
            moved.append(f"{req.ref}: {sj.job_name} succeeded")
            self._spawn_gate(db, req, sj.stage, sj.attempt, moved)
            return
        sj.status = "failed"
        db.commit()
        detail = (envelope or {}).get("detail") or f"agent Job {sj.job_name} failed"
        self._after_failure(db, req, sj, detail, moved)

    # ---------- grade a gate verdict (orchestrator-side, trusted) ----------
    def _grade(
        self,
        db: Session,
        req: Request,
        sj: StageJob,
        phase: str,
        envelope: dict | None,
        moved: list[str],
    ) -> None:
        if envelope is None:
            infra_count = db.scalar(
                select(func.count(StageJob.id)).where(
                    StageJob.request_id == req.id,
                    StageJob.stage == sj.stage,
                    StageJob.attempt == sj.attempt,
                    StageJob.role == sj.role,
                    StageJob.status == "infra",
                )
            )
            if (infra_count or 0) + 1 < GATE_INFRA_LIMIT:
                sj.status = "infra"
                db.commit()
                moved.append(f"{req.ref}: {sj.job_name} produced no verdict — gate re-runs")
                return
            reason = (
                f"{sj.stage} gate produced no verdict after {GATE_INFRA_LIMIT} "
                f"consecutive infra outcomes (last phase: {phase})"
            )
            sj.status = "failed"
            sj.envelope = {"outcome": "fail", "reason": reason}
            db.commit()
            self._after_failure(db, req, sj, reason, moved)
            return
        verdict = envelope.get("outcome")
        if verdict == "pass" and sj.stage == "green":
            red = db.scalar(
                select(StageJob)
                .where(
                    StageJob.request_id == req.id,
                    StageJob.stage == "red",
                    StageJob.role == "gate",
                    StageJob.status == "succeeded",
                )
                .order_by(StageJob.id.desc())
            )
            red_hash = (red.envelope or {}).get("surface_hash") if red else None
            if not red_hash or envelope.get("surface_hash") != red_hash:
                # the load-bearing rule, enforced on the RECORD the trusted side
                # holds — an untrusted gate pod's "pass" cannot override it
                verdict = "fail"
                envelope = {
                    **envelope,
                    "reason": "Test-isolation gate: the frozen test surface changed after RED — change rejected",
                }
                sj.envelope = envelope
        if verdict == "pass" and sj.stage == "review":
            # evidence that can't be derived would be a lie — treat it as a
            # gate failure (retry machinery, then a human) rather than raising
            # a blind merge gate OR dead-ending a later Retry
            payload = verification.payload_from_metrics(req, envelope.get("metrics") or {})
            if payload["tests_total"] == 0 or payload["files_changed"] == 0:
                verdict = "fail"
                envelope = {
                    **envelope,
                    "reason": "Verification could not be built — the review gate reported no test/diff evidence",
                }
                sj.envelope = envelope
        if verdict != "pass":
            sj.status = "failed"
            db.commit()
            self._after_failure(
                db,
                req,
                sj,
                envelope.get("reason") or f"{sj.stage} gate failed",
                moved,
            )
            return
        sj.status = "succeeded"
        title, fields = MILESTONES[sj.stage]
        emit(db, req, "milestone_summary", title, payload={"fields": fields, "Ref": req.ref})
        db.commit()
        moved.append(f"{req.ref}: {sj.stage} gate passed")
        if sj.stage == "review":
            self._finish_review(db, req, envelope, moved)

    def _finish_review(
        self, db: Session, req: Request, envelope: dict, moved: list[str]
    ) -> None:
        # metrics were validated in _grade before the verdict counted as a pass
        payload = verification.payload_from_metrics(req, envelope.get("metrics") or {})
        verification.emit_verification(db, req, payload=payload)
        res = transitions.apply_committed(
            db,
            req,
            "raise_merge_gate",
            actor=FACTORY,
            epoch=get_elector().epoch,
        )
        if isinstance(res, transitions.Loss):
            log.info("%s: merge gate raise lost (%s)", req.ref, res.detail)
            return
        moved.append(f"{req.ref}: merge gate raised")

    # ---------- failure policy: retry-with-feedback (N=2), then a human ----------
    def _after_failure(
        self,
        db: Session,
        req: Request,
        sj: StageJob,
        reason: str,
        moved: list[str],
    ) -> None:
        if sj.attempt >= settings.KUBE_MAX_ATTEMPTS:
            self._escalate(db, req, f"{sj.stage} failed after {sj.attempt} attempts: {reason}")
            moved.append(f"{req.ref}: escalated at {sj.stage}")
            return
        # every attempt is an event (spec §5) — the next tick spawns attempt+1
        # with this reason injected as feedback
        emit(
            db,
            req,
            "milestone_summary",
            f"Attempt {sj.attempt} failed at {sj.stage} — retrying with the gate's feedback",
            payload={
                "Ref": req.ref,
                "stage": sj.stage,
                "attempt": sj.attempt,
                "reason": reason[:300],
            },
        )
        db.commit()
        moved.append(f"{req.ref}: {sj.stage} attempt {sj.attempt} failed — retry queued")

    def _escalate(self, db: Session, req: Request, reason: str) -> None:
        res = transitions.apply_committed(
            db,
            req,
            "escalate",
            actor=FACTORY,
            params={"reason": reason},
            epoch=get_elector().epoch,
        )
        if isinstance(res, transitions.Loss):  # a Cancel raced us — it wins
            log.info("escalation for %s dropped — %s", req.ref, res.detail)
            return
        log.error("escalated %s: %s", req.ref, reason)

    # ---------- decide + spawn the next Job for a runnable request ----------
    def _next_work(self, db: Session, req: Request, moved: list[str]):
        """What to spawn from durable rows plus an explicit Request rewind.

        StageJob rows remain the recovery record. A newer Request.stage entry
        can deliberately invalidate later rows when an operator sends work back.
        Returns ("stage", kube_stage, attempt, feedback) | ("gate", kube_stage,
        attempt) | None (busy, or waiting at the merge gate)."""
        all_rows = db.scalars(
            select(StageJob)
            .where(StageJob.request_id == req.id)
            .order_by(StageJob.attempt, StageJob.id)
        ).all()
        self._supersede_rewound_rows(db, req, all_rows)
        for stage in KUBE_STAGES:
            history = [row for row in all_rows if row.stage == stage]
            rows = [row for row in history if row.status != "superseded"]
            if any(r.role == "gate" and r.status == "succeeded" for r in rows):
                continue  # stage fully graded — look at the next one
            if not rows:
                attempt = max((row.attempt for row in history), default=0) + 1
                return ("stage", stage, attempt, "")
            if any(r.status == "running" for r in rows):
                return None  # the observe pass owns it
            attempt = max(r.attempt for r in rows)
            latest = [r for r in rows if r.attempt == attempt]
            stage_row = next((r for r in latest if r.role == "stage"), None)
            gate_row = next((r for r in reversed(latest) if r.role == "gate"), None)
            if gate_row is not None and gate_row.status == "infra":
                return ("gate", stage, attempt)  # verdict absent: re-run, attempt kept (spec §6)
            if stage_row is not None and stage_row.status == "succeeded" and gate_row is None:
                return ("gate", stage, attempt)  # crashed between stage success and gate spawn
            if stage_row is not None and stage_row.status == "infra":
                return ("stage", stage, attempt, "")  # Job vanished/never landed: same attempt
            # failed / timed_out / reaped → next attempt (escalation, if due,
            # already happened at failure time; a human Retry cleared it)
            return ("stage", stage, attempt + 1, self._feedback(rows))
        review = next(
            (
                row
                for row in reversed(all_rows)
                if row.stage == "review"
                and row.role == "gate"
                and row.status == "succeeded"
            ),
            None,
        )
        if req.status == transitions.APPROVED and req.gate is None and review is not None:
            self._finish_review(db, req, review.envelope or {}, moved)
        return None

    def _supersede_rewound_rows(
        self, db: Session, req: Request, rows: list[StageJob]
    ) -> None:
        target = next(
            (stage for stage in KUBE_STAGES if REQUEST_STAGE[stage] == req.stage),
            None,
        )
        if target is None or req.stage_entered_at is None:
            return
        target_index = KUBE_STAGES.index(target)
        older_later_rows = [
            row
            for row in rows
            if row.status != "superseded"
            and row.created_at < req.stage_entered_at
            and KUBE_STAGES.index(row.stage) > target_index
        ]
        if not older_later_rows:
            return
        for row in rows:
            if (
                row.status != "superseded"
                and row.created_at < req.stage_entered_at
                and KUBE_STAGES.index(row.stage) >= target_index
            ):
                if row.status == "running":
                    # A superseded running row must be captured and deleted, or
                    # it continues to run (and bill) after the rewind.
                    try:
                        view = self.client.get_job(row.job_name, capture=True)
                        row.logs_tail = (view.logs or "")[-LOGS_TAIL:] or None
                        row.envelope = row.envelope or parse_envelope(
                            view.termination_message
                        )
                        self.client.delete_job(row.job_name)
                        row.completed_at = utcnow()
                    except Exception:
                        log.exception("supersede reap failed for %s", row.job_name)
                        continue  # stays running; the next tick retries
                row.status = "superseded"
        db.commit()

    @staticmethod
    def _feedback(rows: list[StageJob]) -> str:
        for r in reversed(rows):
            if r.status in ("failed", "timed_out"):
                env = r.envelope or {}
                return (
                    env.get("reason")
                    or env.get("detail")
                    or f"{r.stage} attempt {r.attempt} {r.status}"
                )
        return ""

    def _spawn_next(self, db: Session, req: Request, moved: list[str]) -> bool:
        work = self._next_work(db, req, moved)
        if work is None:
            return False
        if work[0] == "stage":
            _, stage, attempt, feedback = work
            return self._spawn_stage(db, req, stage, attempt, feedback, moved)
        _, stage, attempt = work
        return self._spawn_gate(db, req, stage, attempt, moved)

    def _spawn_stage(
        self,
        db: Session,
        req: Request,
        stage: str,
        attempt: int,
        feedback: str,
        moved: list[str],
    ) -> bool:
        name = job_name(req.ref, stage, attempt)
        # the fenced CAS + intent + StageJob row + heartbeat event land in ONE
        # transaction (spec §3.3); the external create happens after commit
        res = transitions.apply(
            db,
            req,
            "advance_stage",
            actor=FACTORY,
            params={"stage": REQUEST_STAGE[stage]},
            epoch=get_elector().epoch,
            intent=IntentSpec(
                key=f"spawn:{name}",
                kind=intents.SPAWN_STAGE_JOB,
                payload={"job": name, "attempt": attempt},
            ),
        )
        if isinstance(res, transitions.Loss):
            log.info("%s: spawn of %s lost (%s)", req.ref, name, res.detail)
            return False
        row = StageJob(
            request_id=req.id,
            stage=stage,
            attempt=attempt,
            role="stage",
            job_name=name,
            epoch=get_elector().epoch,
            deadline_at=utcnow() + timedelta(seconds=settings.STAGE_WALL_CLOCK),
        )
        db.add(row)
        emit(
            db,
            req,
            "step_summary",
            f"{stage} agent Job spawned — attempt {attempt} ({name})",
            payload={
                "step": 1,
                "of": 2,
                "label": f"{stage} agent running",
                "Ref": req.ref,
                "job": name,
                "attempt": attempt,
                "with_feedback": bool(feedback),
            },
        )
        db.commit()
        return self._create(
            db,
            req,
            row,
            stage_job_manifest(req.ref, stage, attempt, feedback=feedback),
            moved,
        )

    def _spawn_gate(
        self,
        db: Session,
        req: Request,
        stage: str,
        attempt: int,
        moved: list[str],
    ) -> bool:
        name = job_name(req.ref, stage, attempt, gate=True)
        # No Request-lifecycle CAS fits "spawn a gate" (the stage column does
        # not move). StageJob grades are deliberately unfenced; only a later
        # raise_merge_gate or escalation is epoch-fenced. The intent row records
        # the side effect (idempotent begin: a replay is None).
        intents.begin(db, f"spawn:{name}", intents.SPAWN_GATE_JOB, req.id, {"job": name})
        row = StageJob(
            request_id=req.id,
            stage=stage,
            attempt=attempt,
            role="gate",
            job_name=name,
            epoch=get_elector().epoch,
            deadline_at=utcnow() + timedelta(seconds=settings.GATE_WALL_CLOCK),
        )
        db.add(row)
        emit(
            db,
            req,
            "step_summary",
            f"{stage} gate Job spawned ({name})",
            payload={
                "step": 2,
                "of": 2,
                "label": f"{stage} gate grading",
                "Ref": req.ref,
                "job": name,
                "attempt": attempt,
            },
        )
        db.commit()
        return self._create(
            db,
            req,
            row,
            gate_job_manifest(req.ref, stage, attempt),
            moved,
        )

    def _create(
        self,
        db: Session,
        req: Request,
        row: StageJob,
        manifest: dict,
        moved: list[str],
    ) -> bool:
        name = row.job_name
        try:
            uid = self.client.create_job(manifest)
        except Exception as exc:
            log.exception("create_job %s failed", name)
            intents.fail(db, f"spawn:{name}", {"error": str(exc)[:300]})
            row.status = "infra"
            row.completed_at = utcnow()
            self._escalate(db, req, f"Could not create Job {name}: {exc}")
            return False
        if uid is None:
            # 409: adopt our own unrecorded intent replay, but park when the
            # live object belongs to an earlier completed same-name row.
            view = self.client.get_job(name)
            prior_uids = {
                prior.job_uid
                for prior in db.scalars(
                    select(StageJob).where(
                        StageJob.job_name == name, StageJob.id != row.id
                    )
                ).all()
                if prior.job_uid
            }
            if view.phase != "absent" and view.uid and view.uid in prior_uids:
                intents.fail(
                    db,
                    f"spawn:{name}",
                    {"error": "same-name Job from a prior attempt still terminating"},
                )
                row.status = "infra"
                row.completed_at = utcnow()
                db.commit()
                moved.append(f"{req.ref}: {name} blocked by a dying predecessor — will re-run")
                return False
            row.job_uid = view.uid or None
        else:
            row.job_uid = uid
        intents.complete(db, f"spawn:{name}", {"job": name, "uid": row.job_uid})
        db.commit()
        moved.append(f"{req.ref}: spawned {name}")
        return True
