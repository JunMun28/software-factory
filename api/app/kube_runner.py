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
import json
import logging
import re
import urllib.request
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import (
    deploy_manifests,
    intents,
    settings,
    simulator,
    transitions,
    verification,
    workspace,
)
from .events import emit
from .kube_client import KubeClient
from .kube_jobs import (
    KUBE_STAGES,
    REQUEST_STAGE,
    gate_job_manifest,
    job_name,
    parse_digest,
    parse_envelope,
    stage_job_manifest,
)
from .leader import get_elector
from .models import PIPELINE_STAGES, AuditEvent, Intent, Request, StageJob, utcnow
from .transitions import FACTORY, IntentSpec
from .ws_exec import _git

log = logging.getLogger("factory.kube")

LOGS_TAIL = 20_000  # chars of captured NDJSON persisted per Job
GATE_INFRA_LIMIT = 3
# How long a consumed merge gate shields the request from strand-repair: long
# enough for any GitHub merge round-trip, short enough that a process that died
# between claim and merge is still rescued by the re-raise.
MERGE_CLAIM_GRACE = int(__import__("os").environ.get("FACTORY_MERGE_CLAIM_GRACE", "600"))
SHA40 = re.compile(r"^[0-9a-f]{40}$")


def _http_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=5) as response:  # nosec: in-cluster probe
            return 200 <= response.status < 400
    except Exception:
        return False

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
    def __init__(self, client: KubeClient | None = None, github=None):
        self._client = client
        self._github = github
        self._observe_failures: dict[str, int] = {}

    @property
    def client(self) -> KubeClient:
        if self._client is None:  # first USE, never import/startup: tests and sim mode never pay kubeconfig loading
            from .kube_client import RealKubeClient

            self._client = RealKubeClient()
        return self._client

    @property
    def github(self):
        if self._github is None:
            from .github import GitHub

            self._github = GitHub()
        return self._github

    # ---------- tick ----------
    def tick(self, db: Session) -> list[str]:
        moved: list[str] = []
        defer_spawn: set[int] = set()
        self._reap_dead_requests(db, moved)
        self._drive_deploys(db, moved)
        for sj in db.scalars(
            select(StageJob)
            .where(
                StageJob.status == "running",
                StageJob.role.in_(("stage", "gate")),
            )
            .order_by(StageJob.id)
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
                should_defer_spawn = self._observe(db, req, sj, moved)
                if should_defer_spawn or sj.status in ("failed", "timed_out", "infra"):
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
        running = db.scalars(
            select(StageJob).where(
                StageJob.status == "running",
                StageJob.role.in_(("stage", "gate")),
            )
        ).all()
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
        for sj in db.scalars(
            select(StageJob).where(
                StageJob.status == "running",
                StageJob.role.in_(("stage", "gate")),
            )
        ).all():
            req = db.get(Request, sj.request_id)
            if req and req.status == transitions.APPROVED and not req.needs_human:
                continue
            try:
                view = self.client.get_job(sj.job_name, capture=True)
                sj.logs_tail = (view.logs or "")[-LOGS_TAIL:] or None
                sj.envelope = parse_envelope(view.termination_message)
                self.client.delete_job(sj.job_name, uid=sj.job_uid)
                sj.status = "reaped"
                sj.completed_at = utcnow()
                db.commit()
                moved.append(f"{req.ref if req else sj.request_id}: reaped {sj.job_name}")
            except Exception:
                log.exception("kube reap failed for %s", sj.job_name)
                db.rollback()

    # ---------- observe one running Job ----------
    def _observe(self, db: Session, req: Request, sj: StageJob, moved: list[str]) -> bool:
        view = self.client.get_job(sj.job_name)
        self._observe_failures.pop(sj.job_name, None)
        if view.phase != "absent" and sj.job_uid and view.uid and view.uid != sj.job_uid:
            # Same name, different Job — not ours (out-of-band recreate).
            # Never grade a stranger: infra, re-run (spec §5 stale-discard).
            sj.status = "infra"
            sj.completed_at = utcnow()
            db.commit()
            moved.append(f"{req.ref}: {sj.job_name} uid changed under us — will re-run")
            return False
        now = utcnow()
        if view.phase == "running":
            if now < sj.deadline_at:
                return False
            # orchestrator wall clock (spec §5): fires regardless of Job status —
            # a partitioned node cannot strand the request. Capture is attempted
            # first, including logs from a pod whose Job is still running.
            view = self.client.get_job(sj.job_name, capture=True)
            sj.envelope = parse_envelope(view.termination_message)
            sj.logs_tail = (view.logs or "")[-LOGS_TAIL:] or None
            self.client.delete_job(sj.job_name, uid=sj.job_uid)
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
            return True
        if view.phase == "absent":
            # vanished under us (external deletion / create replay that never landed):
            # infra, not a domain failure — the same attempt re-runs
            if sj.role == "gate":
                self._grade(db, req, sj, view.phase, None, moved)
                return sj.status in ("failed", "timed_out", "infra")
            sj.status = "infra"
            sj.completed_at = now
            db.commit()
            moved.append(f"{req.ref}: {sj.job_name} vanished — will re-run")
            return True
        # terminal: capture BEFORE deletion — the orchestrator owns the Job
        # lifecycle and never loses an outcome (spec §5, §8)
        envelope = parse_envelope(view.termination_message)
        sj.envelope = envelope
        sj.logs_tail = (view.logs or "")[-LOGS_TAIL:] or None
        self.client.delete_job(sj.job_name, uid=sj.job_uid)
        sj.completed_at = now
        if sj.role == "gate":
            self._grade(db, req, sj, view.phase, envelope, moved)
            return sj.status in ("failed", "timed_out", "infra")
        else:
            return self._finish_stage_job(db, req, sj, view.phase, envelope, moved)

    def _finish_stage_job(
        self,
        db: Session,
        req: Request,
        sj: StageJob,
        phase: str,
        envelope: dict | None,
        moved: list[str],
    ) -> bool:
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
            return True
        if phase == "succeeded" and envelope.get("outcome") == "ok":
            sj.status = "succeeded"
            db.commit()
            moved.append(f"{req.ref}: {sj.job_name} succeeded")
            return not self._spawn_gate(db, req, sj.stage, sj.attempt, moved)
        sj.status = "failed"
        db.commit()
        detail = (envelope or {}).get("detail") or f"agent Job {sj.job_name} failed"
        self._after_failure(db, req, sj, detail, moved)
        return True

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
            source = self._surface_check(db, req, sj)
            if source == "violated":
                verdict = "fail"
                envelope = {
                    **envelope,
                    "reason": "Test-isolation gate: the frozen test surface changed after RED — change rejected",
                }
                sj.envelope = envelope
            elif source == "unavailable":
                # B1 fallback: no git backbone/SHAs — compare the (untrusted)
                # gate-envelope hashes, better than nothing
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

    # ---------- the human merge gate (kube mode) ----------
    def _resolve_pr(
        self, db: Session, req: Request, slug: str, ref: str
    ) -> int | None:
        pr_intent = db.get(Intent, f"pr:{ref}")
        if pr_intent is not None:
            try:
                pr_number = json.loads(pr_intent.outcome_json).get("pr_number")
            except (TypeError, ValueError):
                pr_number = None
            if isinstance(pr_number, int):
                return pr_number
        try:
            pr_number = self.github.find_open_pr(slug, workspace.work_branch(ref))
        except Exception as exc:
            raise RuntimeError(f"Could not resolve GitHub PR: {exc}") from exc
        return pr_number

    def approve_merge(self, db: Session, req: Request, actor: str) -> None:
        """SHA-precondition merge (spec §6, local edition): merge exactly the
        last graded SHA into main, or escalate. Without a git workspace (no
        GIT_REMOTE_BASE — B1-shaped runs) delegate to the simulator's
        finish_done, which was B1's contract."""
        if not settings.GIT_REMOTE_BASE:
            simulator.approve_merge(db, req, actor)
            return
        ws = workspace.workspace_for(req)
        sha = self._last_graded_sha(db, req)
        if not (ws / ".git").exists() or not sha:
            simulator.approve_merge(db, req, actor)
            return
        intent_key = f"merge:{req.ref}"
        fresh = intents.begin(
            db,
            intent_key,
            intents.MERGE_PR,
            req.id,
            {"slug": self._app_slug(req), "sha": sha},
        )
        db.commit()
        merge_intent = db.get(Intent, intent_key)
        already_done = fresh is None and merge_intent.status == "done"
        if fresh is None and not already_done:
            recovery_error = None
            if settings.github_enabled():
                try:
                    recovery_error = workspace.fetch_main_from_github(
                        ws, self._app_slug(req)
                    )
                except Exception as exc:
                    recovery_error = workspace.sanitize_github_git_error(str(exc))
            graded_is_merged = (
                _git(ws, "merge-base", "--is-ancestor", sha, "main").returncode
                == 0
            )
            if graded_is_merged:
                merge_sha = workspace.head_sha(ws, "main") or sha
                intents.complete(db, intent_key, {"merge_sha": merge_sha})
                already_done = True
            elif recovery_error:
                recovery_error = workspace.sanitize_github_git_error(
                    recovery_error
                )[:300]
                intents.fail(db, intent_key, {"error": recovery_error})
                self._escalate(
                    db,
                    req,
                    f"Could not refresh GitHub main during merge recovery: "
                    f"{recovery_error}",
                )
                return
        if settings.github_enabled():
            if not already_done:
                slug = self._app_slug(req)
                try:
                    pr_number = self._resolve_pr(db, req, slug, req.ref)
                except Exception as exc:
                    detail = workspace.sanitize_github_git_error(str(exc))[:300]
                    intents.fail(db, intent_key, {"error": detail})
                    self._escalate(db, req, detail)
                    return
                if pr_number is None:
                    detail = f"No open GitHub PR found for {req.ref}"
                    intents.fail(db, intent_key, {"error": detail})
                    self._escalate(db, req, detail)
                    return
                try:
                    from .github import MergeShaMismatch

                    merge_sha = self.github.merge_pr(slug, pr_number, sha)
                except MergeShaMismatch as exc:
                    detail = workspace.sanitize_github_git_error(str(exc))[:300]
                    intents.fail(db, intent_key, {"error": detail})
                    self._escalate(db, req, f"Merge refused: {detail}")
                    return
                except Exception as exc:
                    detail = workspace.sanitize_github_git_error(str(exc))[:300]
                    intents.fail(db, intent_key, {"error": detail})
                    self._escalate(db, req, f"GitHub merge failed: {detail}")
                    return
                try:
                    fetch_error = workspace.fetch_main_from_github(ws, slug)
                except Exception as exc:
                    fetch_error = workspace.sanitize_github_git_error(str(exc))
                if fetch_error:
                    fetch_error = workspace.sanitize_github_git_error(
                        fetch_error
                    )[:300]
                    intents.fail(db, intent_key, {"error": fetch_error})
                    self._escalate(
                        db,
                        req,
                        f"Merged on GitHub but mirror update failed: {fetch_error}",
                    )
                    return
                intents.complete(db, intent_key, {"merge_sha": merge_sha})
        elif not already_done:
            err = workspace.merge_graded(ws, req.ref, sha, actor)
            if err:
                intents.fail(db, intent_key, {"error": err})
                self._escalate(db, req, f"Merge failed: {err}")
                return
            merge_sha = workspace.head_sha(ws, "main") or sha
            intents.complete(db, intent_key, {"merge_sha": merge_sha})
        if settings.app_deploy_enabled():
            # B4: merge landed — WAIT at the deploy gate (spec §4.10). The build
            # is driven only after a human clears the gate; fenced + notified
            # like the merge gate, and a raced Cancel wins the CAS.
            res = transitions.apply_committed(
                db,
                req,
                "raise_deploy_gate",
                actor=transitions.Actor(name=actor),
                params={"sha": sha},
                epoch=get_elector().epoch,
            )
            if isinstance(res, transitions.Loss):
                log.info("%s: raise_deploy_gate lost (%s)", req.ref, res.detail)
                return
            log.info("%s merged at %s — waiting at the deploy gate", req.ref, sha[:12])
            return
        res = transitions.apply(
            db,
            req,
            "finish_done",
            actor=transitions.Actor(name=actor),
            params={
                "merge_note": "work branch merged to main",
                "deploy_title": "Deployed — main updated in the Subject workspace",
                "payload_extra": {
                    "merged": True,
                    "workspace": str(ws),
                    "sha": sha,
                },
            },
        )
        if isinstance(res, transitions.Loss):
            log.info("%s: finish_done lost (%s)", req.ref, res.detail)
            return
        db.commit()
        log.info("%s merged to main at %s by %s", req.ref, sha[:12], actor)

    # ---------- produced-app build + deploy (B3) ----------
    @staticmethod
    def _app_slug(req: Request) -> str:
        return req.app.key if req.app else req.ref.lower()

    def _drive_deploys(self, db: Session, moved: list[str]) -> None:
        if not settings.app_deploy_enabled():
            return
        # B4: only APPROVED (gate-cleared) deploy requests build. A request at
        # gate=approve_deploy is WAITING for a human — never drive it.
        requests = db.scalars(
            select(Request).where(Request.stage == "deploy", Request.gate.is_(None))
        ).all()
        for req in requests:
            try:
                self._drive_one_deploy(db, req, moved)
            except Exception as exc:
                db.rollback()
                log.exception("deploy driver failed for %s", req.ref)
                self._escalate(db, req, f"Build/deploy failed: {exc}")

    def _drive_one_deploy(
        self, db: Session, req: Request, moved: list[str]
    ) -> None:
        slug = self._app_slug(req)
        if req.status != transitions.APPROVED or req.needs_human:
            self._teardown_app(db, req, slug)
            return
        rows = db.scalars(
            select(StageJob)
            .where(
                StageJob.request_id == req.id,
                StageJob.role.in_(("build", "deploy")),
            )
            .order_by(StageJob.id)
        ).all()
        build = next((row for row in reversed(rows) if row.role == "build"), None)
        deploy = next((row for row in reversed(rows) if row.role == "deploy"), None)
        if build is None or build.status in ("failed", "timed_out", "infra"):
            # bounded like the stage machinery: 3 consecutive infra rounds end
            # in a human, never a silent create/observe loop
            tail_infra = 0
            for row in reversed([r for r in rows if r.role == "build"]):
                if row.status != "infra":
                    break
                tail_infra += 1
            if tail_infra >= 3:
                self._escalate(
                    db, req,
                    "Build re-ran 3 times without completing — infra loop",
                )
                return
            self._spawn_build(db, req, slug, moved)
            return
        if build.status == "running":
            self._observe_build(db, req, build, slug, moved)
            return
        # a dead deploy row (timed_out/infra) must not dead-end the request:
        # after a human Retry the manifests are re-applied — intents.begin is
        # idempotent on the deterministic key and apply is create-or-update
        deploy_live = deploy is not None and deploy.status in ("running", "succeeded")
        if build.status == "succeeded" and not deploy_live:
            self._apply_deploy(db, req, slug, build.envelope["digest"], moved)
            return
        if deploy is not None and deploy.status == "running":
            self._observe_deploy(db, req, deploy, slug, moved)

    def _spawn_build(
        self, db: Session, req: Request, slug: str, moved: list[str]
    ) -> None:
        ws = workspace.workspace_for(req)
        sha = workspace.head_sha(ws, "main")
        if not (isinstance(sha, str) and SHA40.fullmatch(sha)):
            self._escalate(db, req, "Build source SHA could not be read from merged main")
            return
        name = deploy_manifests.build_job_name(req.ref)
        intent_key = f"build:{req.ref}:{sha}"
        intents.begin(
            db,
            intent_key,
            intents.TRIGGER_BUILD,
            req.id,
            {"job": name, "sha": sha},
        )
        row = StageJob(
            request_id=req.id,
            stage="deploy",
            attempt=1,
            role="build",
            job_name=name,
            epoch=get_elector().epoch,
            deadline_at=utcnow() + timedelta(seconds=settings.BUILD_WALL_CLOCK),
            envelope={"sha": sha},
        )
        db.add(row)
        db.commit()
        self._create(
            db,
            req,
            row,
            deploy_manifests.build_job_manifest(req.ref, slug, sha),
            moved,
            intent_key=intent_key,
        )

    def _observe_build(
        self,
        db: Session,
        req: Request,
        build: StageJob,
        slug: str,
        moved: list[str],
    ) -> None:
        view = self.client.get_job(build.job_name)
        now = utcnow()
        if view.phase == "running" and now < build.deadline_at:
            return
        view = self.client.get_job(build.job_name, capture=True)
        build.logs_tail = (view.logs or "")[-LOGS_TAIL:] or None
        if view.phase != "absent" and build.job_uid and view.uid and view.uid != build.job_uid:
            build.status = "infra"
            build.completed_at = now
            self.client.delete_job(build.job_name, uid=build.job_uid)
            db.commit()
            self._escalate(db, req, f"Build Job {build.job_name} uid changed under us")
            return
        self.client.delete_job(build.job_name, uid=build.job_uid)
        build.completed_at = now
        if view.phase == "running":
            build.status = "timed_out"
            db.commit()
            self._escalate(db, req, f"Build Job {build.job_name} exceeded its wall clock")
            return
        if view.phase == "absent":
            # crash between the row commit and create_job, or an external
            # delete: benign — re-spawn next tick (deterministic name, digest
            # pin), bounded by the consecutive-infra guard in the driver
            build.status = "infra"
            db.commit()
            moved.append(f"{req.ref}: build Job absent — re-running")
            return
        if view.phase != "succeeded":
            build.status = "failed"
            db.commit()
            self._escalate(db, req, f"Build Job {build.job_name} failed")
            return
        digest = parse_digest(view.termination_message)
        if digest is None:
            build.status = "infra"
            db.commit()
            self._escalate(db, req, "build image digest could not be captured")
            return
        build.status = "succeeded"
        build.envelope = {**(build.envelope or {}), "digest": digest}
        db.commit()
        moved.append(f"{req.ref}: build image captured at {digest}")
        self._apply_deploy(db, req, slug, digest, moved)

    def _apply_deploy(
        self,
        db: Session,
        req: Request,
        slug: str,
        digest: str,
        moved: list[str],
    ) -> None:
        name = deploy_manifests.app_name(slug)
        image = f"{settings.REGISTRY}/sf-app-{slug}@{digest}"
        intent_key = f"deploy:{slug}:{digest}"
        intents.begin(
            db,
            intent_key,
            intents.APPLY_DEPLOY,
            req.id,
            {"app": name, "digest": digest},
        )
        row = StageJob(
            request_id=req.id,
            stage="deploy",
            attempt=1,
            role="deploy",
            job_name=name,
            epoch=get_elector().epoch,
            deadline_at=utcnow() + timedelta(seconds=settings.DEPLOY_WALL_CLOCK),
            envelope={"digest": digest, "image": image},
        )
        db.add(row)
        db.commit()
        try:
            for manifest in deploy_manifests.app_deploy_manifests(slug, digest, 1):
                self.client.apply(manifest)
        except Exception as exc:
            row.status = "infra"
            row.completed_at = utcnow()
            intents.fail(db, intent_key, {"error": str(exc)[:300]})
            self._escalate(db, req, f"Could not apply produced app {name}: {exc}")
            return
        intents.complete(db, intent_key, {"app": name, "digest": digest})
        moved.append(f"{req.ref}: applied {name} at {digest}")

    def _observe_deploy(
        self,
        db: Session,
        req: Request,
        deploy: StageJob,
        slug: str,
        moved: list[str],
    ) -> None:
        name = deploy_manifests.app_name(slug)
        probe_url = f"http://{name}.{settings.KUBE_NAMESPACE}.svc:80/health"
        rollout_ready = self.client.rollout_ready(name)
        probe_ok = rollout_ready and _http_ok(probe_url)
        now = utcnow()
        if rollout_ready and probe_ok:
            url = f"http://{slug}.{settings.APP_INGRESS_DOMAIN}"
            deploy.status = "succeeded"
            deploy.completed_at = now
            res = transitions.apply_committed(
                db,
                req,
                "finish_done",
                actor=FACTORY,
                params={
                    "merge_note": "PR merged to main",
                    "deploy_title": f"Deployed — {url} is live",
                    "payload_extra": {"digest": deploy.envelope["digest"], "url": url},
                },
                epoch=get_elector().epoch,
            )
            if isinstance(res, transitions.Loss):
                log.info("%s: finish_done lost (%s)", req.ref, res.detail)
                return
            moved.append(f"{req.ref}: deployed {url}")
            return
        if now < deploy.deadline_at:
            return
        deploy.status = "timed_out"
        deploy.completed_at = now
        db.commit()
        reason = (
            f"Produced app {name} health probe failed before the deploy deadline"
            if rollout_ready
            else f"Produced app {name} rollout was not ready before the deploy deadline"
        )
        self._escalate(db, req, reason)

    def _teardown_app(self, db: Session, req: Request, slug: str) -> None:
        # OPERATE-02: a closed/escalated deploy request stays at stage=deploy and
        # is re-selected every tick. Guard against (a) re-running the deletes
        # every tick (durable teardown marker + early return) and (b) deleting a
        # SHARED live app another request owns (ownership decided by the DB, not a
        # cluster label). Scope is DELETION safety only — apply-time cutover
        # safety is deferred to C8.
        lref = req.ref.lower()
        rows = db.scalars(
            select(StageJob)
            .where(
                StageJob.request_id == req.id,
                StageJob.role.in_(("build", "deploy", "teardown")),
            )
            .order_by(StageJob.id.desc())
        ).all()
        if rows and rows[0].role == "teardown":
            return  # this closed episode was already cleaned (idempotent, once)
        build = next((r for r in rows if r.role == "build"), None)
        if build is not None:
            try:
                self.client.delete_job(build.job_name, uid=build.job_uid)
            except Exception:
                log.exception("build teardown failed for %s", build.job_name)
        # request-scoped ephemeral resources (C1 previews will carry sf/request);
        # a no-op today — only the build Job has that label and Jobs are not
        # deleted by delete_by_label.
        try:
            self.client.delete_by_label(f"sf/request={lref}")
        except Exception:
            log.exception("ephemeral teardown failed for %s", lref)
        # the SHARED live app (sf/instance=<slug>) is deleted ONLY when nothing
        # successful is live under this slug — a failed follow-up must never nuke
        # a sibling's production.
        deleted_instance = False
        if not self._slug_has_live_app(db, req):
            try:
                self.client.delete_by_label(f"sf/instance={slug}")
                deleted_instance = True
            except Exception:
                log.exception("app teardown failed for %s", slug)
        for row in rows:
            if row.role in ("build", "deploy") and row.status == "running":
                row.status = "reaped"
                row.completed_at = utcnow()
        now = utcnow()
        db.add(
            StageJob(
                request_id=req.id,
                stage="deploy",
                attempt=1,
                role="teardown",
                job_name=f"sf-{lref}-teardown",
                epoch=get_elector().epoch,
                status="succeeded",
                deadline_at=now,
                completed_at=now,
                envelope={"teardown": True, "slug": slug,
                          "deleted_instance": deleted_instance},
            )
        )
        db.commit()

    def _slug_has_live_app(self, db: Session, req: Request) -> bool:
        """True iff a DIFFERENT request sharing this slug has a live (running or
        succeeded) deploy — i.e. sf/instance=<slug> belongs to a sibling we must
        NOT delete. `req` itself is excluded: the request being torn down is not
        "live", and its own half-applied/succeeded-then-superseded debris is
        exactly what teardown reclaims. Running is protected alongside succeeded
        so a sibling mid-rollout (Deployment applied, rollout not yet finished) is
        not nuked. Requests share a slug through Request.app_id (OPERATE-01's
        follow-up linkage); an unregistered app (app_id is None) has a unique
        ephemeral slug=ref, so no sibling can share it -> always False -> teardown
        reclaims its own debris. HARD PRECONDITION for OPERATE-01/C8: the request
        that owns a live deploy MUST carry the shared app_id, else this misses it
        and teardown fails open into the nuke-prod bug."""
        if req.app_id is None:
            return False
        q = (
            select(StageJob.id)
            .where(
                StageJob.role == "deploy",
                StageJob.status.in_(("running", "succeeded")),
                StageJob.request_id != req.id,
                StageJob.request_id.in_(
                    select(Request.id).where(Request.app_id == req.app_id)
                ),
            )
            .limit(1)
        )
        return db.scalar(q) is not None

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

    # ---------- git-as-workspace (B2): the trusted side of the pipeline ----------
    def _last_graded_sha(self, db: Session, req: Request) -> str | None:
        """The newest stage SHA whose gate succeeded — the only safe branch
        state for a fresh attempt (spec §5 attempt semantics)."""
        rows = db.scalars(
            select(StageJob)
            .where(StageJob.request_id == req.id)
            .order_by(StageJob.id)
        ).all()
        for gate in reversed(rows):
            if gate.role != "gate" or gate.status != "succeeded":
                continue
            stage_row = next(
                (
                    r
                    for r in reversed(rows)
                    if r.role == "stage"
                    and r.status == "succeeded"
                    and r.stage == gate.stage
                    and r.attempt == gate.attempt
                ),
                None,
            )
            sha = (stage_row.envelope or {}).get("sha") if stage_row else None
            if isinstance(sha, str) and SHA40.fullmatch(sha):
                return sha
        return None

    def _prepare_workspace(
        self, db: Session, req: Request, *, force_rewind: bool = False
    ) -> None:
        """Before an agent Job clones: the repo exists and the work branch
        sits at the last graded SHA (or the SPEC baseline). A no-op between
        clean stages; the reset that matters happens on retries."""
        if not settings.GIT_REMOTE_BASE:
            return  # no git backbone configured: B1 behavior (unit fakes)
        ws = workspace.ensure_repo(req, workspace.spec_md(req))
        if settings.github_enabled():
            slug = self._app_slug(req)
            intent_key = f"repo:{req.ref}"
            fresh = intents.begin(
                db,
                intent_key,
                intents.CREATE_REPO,
                req.id,
                {"slug": slug},
            )
            db.commit()
            repo_intent = fresh or db.get(Intent, intent_key)
            if repo_intent.status != "done":
                try:
                    clone_url = self.github.ensure_repo(slug)
                    self._push_github_baseline(ws, slug, req.ref)
                except Exception as exc:
                    detail = workspace.sanitize_github_git_error(str(exc))[:300]
                    intents.fail(db, intent_key, {"error": detail})
                    raise RuntimeError(detail) from exc
                intents.complete(db, intent_key, {"clone_url": clone_url})
        target = self._last_graded_sha(db, req) or workspace.BASELINE_TAG
        before = workspace.head_sha(ws, workspace.work_branch(req.ref))
        if not workspace.reset_branch(ws, req.ref, target):
            raise RuntimeError(f"could not reset {req.ref} work branch to {target}")
        if settings.github_enabled() and (
            force_rewind or before != workspace.head_sha(ws)
        ):
            error = workspace.push_branch_to_github(
                ws,
                self._app_slug(req),
                req.ref,
                force=True,
            )
            if error:
                raise RuntimeError(f"could not rewind GitHub work branch: {error}")

    @staticmethod
    def _push_github_baseline(ws, slug: str, ref: str) -> None:
        pushed_main = _git(
            ws,
            "push",
            workspace._authed_url(slug),
            "main:main",
        )
        if pushed_main.returncode != 0:
            detail = workspace.sanitize_github_git_error(
                pushed_main.stderr or pushed_main.stdout
            ).strip()[:200]
            raise RuntimeError(detail or "push main to GitHub failed")
        push_error = workspace.push_branch_to_github(ws, slug, ref)
        if push_error:
            raise RuntimeError(push_error)

    def _open_pr(self, db: Session, req: Request, slug: str) -> bool:
        intent_key = f"pr:{req.ref}"
        fresh = intents.begin(
            db,
            intent_key,
            intents.OPEN_PR,
            req.id,
            {"slug": slug, "branch": workspace.work_branch(req.ref)},
        )
        db.commit()
        pr_intent = fresh or db.get(Intent, intent_key)
        if pr_intent.status == "done":
            return True
        try:
            pr_number = self.github.open_pr(
                slug,
                workspace.work_branch(req.ref),
                req.ref,
                workspace.spec_md(req),
            )
        except Exception as exc:
            intents.fail(db, intent_key, {"error": str(exc)[:300]})
            self._escalate(db, req, f"Could not open GitHub PR: {exc}")
            return False
        intents.complete(db, intent_key, {"pr_number": pr_number})
        return True

    def _surface_check(self, db: Session, req: Request, sj: StageJob) -> str:
        """'ok' | 'violated' | 'unavailable'. The orchestrator computes the
        frozen-surface hash at red's and green's PUSHED SHAs on its own repo
        (spec §6) — the gate pod's claimed hash is never load-bearing here.
        A SHA that does not resolve is a violation, never a pass."""
        if not settings.GIT_REMOTE_BASE:
            return "unavailable"
        ws = workspace.workspace_for(req)
        if not (ws / ".git").exists():
            return "unavailable"

        def _stage_sha(stage: str, attempt: int | None) -> str | None:
            q = (
                select(StageJob)
                .where(
                    StageJob.request_id == req.id,
                    StageJob.stage == stage,
                    StageJob.role == "stage",
                    StageJob.status == "succeeded",
                )
                .order_by(StageJob.id.desc())
            )
            if attempt is not None:
                q = q.where(StageJob.attempt == attempt)
            row = db.scalar(q)
            return (row.envelope or {}).get("sha") if row else None

        red_sha = _stage_sha("red", None)
        green_sha = _stage_sha("green", sj.attempt)
        if not red_sha or not green_sha:
            return "unavailable"
        red_hash = workspace.surface_hash_at(ws, red_sha)
        green_hash = workspace.surface_hash_at(ws, green_sha)
        if red_hash is None or green_hash is None:
            return "violated"  # an agent claiming an unknown SHA never passes
        return "ok" if red_hash == green_hash else "violated"

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
            # A HUMAN merge claim may be IN FLIGHT: claim_merge consumed the
            # gate and approve_merge is mid-call — seconds, when the merge is a
            # GitHub API round-trip (found live: the racing re-raise made the
            # post-merge raise_deploy_gate lose its CAS). Only strand-repair
            # when the newest decisive audit is NOT a fresh merge claim; a
            # STALE claim means the approving process died mid-merge and the
            # re-raise is the designed recovery.
            claim = db.scalar(
                select(AuditEvent)
                .where(
                    AuditEvent.request_id == req.id,
                    AuditEvent.action.in_(transitions.DECISIVE_ACTIONS),
                )
                .order_by(AuditEvent.id.desc())
            )
            if (
                claim is not None
                and claim.action == "merge_claimed"
                and claim.created_at is not None
                and (utcnow() - claim.created_at).total_seconds() < MERGE_CLAIM_GRACE
            ):
                return None
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
                        self.client.delete_job(row.job_name, uid=row.job_uid)
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
        try:
            self._prepare_workspace(db, req, force_rewind=attempt > 1)
        except Exception as exc:
            detail = workspace.sanitize_github_git_error(str(exc))[:300]
            row.status = "infra"
            row.completed_at = utcnow()
            intents.fail(db, f"spawn:{name}", {"error": detail})
            self._escalate(
                db,
                req,
                f"Workspace preparation failed before {name}: {detail}",
            )
            return False
        return self._create(
            db,
            req,
            row,
            stage_job_manifest(
                req.ref,
                stage,
                attempt,
                feedback=feedback,
                repo_slug=self._app_slug(req),
            ),
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
        stage_row = db.scalar(
            select(StageJob)
            .where(
                StageJob.request_id == req.id,
                StageJob.stage == stage,
                StageJob.attempt == attempt,
                StageJob.role == "stage",
                StageJob.status == "succeeded",
            )
            .order_by(StageJob.id.desc())
        )
        stage_env = (stage_row.envelope or {}) if stage_row else {}
        pinned_sha = stage_env.get("sha") or ""
        if settings.GIT_REMOTE_BASE and not (
            isinstance(pinned_sha, str) and SHA40.fullmatch(pinned_sha)
        ):
            reason = (
                f"{stage} gate rejected invalid stage SHA — expected 40 lowercase hex "
                "characters"
            )
            row = StageJob(
                request_id=req.id,
                stage=stage,
                attempt=attempt,
                role="gate",
                job_name=name,
                epoch=get_elector().epoch,
                deadline_at=utcnow() + timedelta(seconds=settings.GATE_WALL_CLOCK),
                envelope={"outcome": "fail", "reason": reason},
            )
            db.add(row)
            self._grade(db, req, row, "failed", row.envelope, moved)
            return False
        if settings.github_enabled():
            ws = workspace.workspace_for(req)
            try:
                fetch_error = workspace.fetch_ref_from_github(
                    ws,
                    self._app_slug(req),
                    req.ref,
                    sha=pinned_sha,
                )
            except Exception as exc:
                fetch_error = workspace.sanitize_github_git_error(str(exc))
            if fetch_error:
                self._escalate(
                    db,
                    req,
                    f"could not fetch {pinned_sha[:12]} from GitHub before grading: "
                    f"{fetch_error}",
                )
                return False
            if stage == "architecture" and not self._open_pr(
                db, req, self._app_slug(req)
            ):
                return False
        review_verdict = (
            (stage_env.get("detail") or "") if stage == "review" else ""
        )
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
            gate_job_manifest(
                req.ref,
                stage,
                attempt,
                sha=pinned_sha,
                review_verdict=review_verdict,
            ),
            moved,
        )

    def _create(
        self,
        db: Session,
        req: Request,
        row: StageJob,
        manifest: dict,
        moved: list[str],
        *,
        intent_key: str | None = None,
    ) -> bool:
        name = row.job_name
        intent_key = intent_key or f"spawn:{name}"
        try:
            uid = self.client.create_job(manifest)
        except Exception as exc:
            log.exception("create_job %s failed", name)
            intents.fail(db, intent_key, {"error": str(exc)[:300]})
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
            if prior_uids:
                stranger = bool(view.uid and view.uid not in prior_uids)
                intents.fail(
                    db,
                    intent_key,
                    {
                        "error": (
                            "same-name Job has an unrecognized uid"
                            if stranger
                            else "same-name Job from a prior attempt still terminating"
                        )
                    },
                )
                row.status = "infra"
                row.completed_at = utcnow()
                db.commit()
                blocker = "a uid stranger" if stranger else "a dying predecessor"
                moved.append(f"{req.ref}: {name} blocked by {blocker} — will re-run")
                return False
            row.job_uid = view.uid or None
        else:
            row.job_uid = uid
        intents.complete(db, intent_key, {"job": name, "uid": row.job_uid})
        db.commit()
        moved.append(f"{req.ref}: spawned {name}")
        return True
