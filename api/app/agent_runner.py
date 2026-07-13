"""AgentRunner — Stages 2–5 executed for real by an agent CLI (ADR 0011, 0021).

Enabled with FACTORY_RUNNER=agent. Which CLI actually runs is FACTORY_CLI's call
(codex by default, claude optional) — the runner never names a vendor. Each
approved Request gets a git workspace copied from `sample/`; the stage agents run
headless inside it and the GATES ARE MACHINE-CHECKED, not taken on the agent's word:

  architecture  → PLAN.md must exist                     (structural validation)
  build · RED   → pytest must FAIL with collected tests  (RED gate)
  build · GREEN → pytest must PASS and the frozen test
                  surface must be untouched              (GREEN + test-isolation gate)
  review        → REVIEW.md must exist, then the human
                  merge gate is raised                   (humans gate the irreversible)
  merge approve → git merge work branch → main           (the "deploy")

Any gate failure, timeout, or crashed stage escalates (needs_human) — no
automatic retry, exactly like CONTEXT.md's Escalation. A request can never be
silently stranded: the stage loop catches everything, and escalation/gate
writes re-check status so a concurrent Cancel always wins (ADR 0013).
The executor is injectable for tests.
"""
import hashlib
import logging
import re
import shutil
import threading
from pathlib import Path
from typing import Callable

from sqlalchemy.orm import Session

from . import lifecycle, settings
from .agent_exec import AgentResult, run_agent
from .db import SessionLocal
from .events import emit
from .models import Request, utcnow
from .supervision import pending_steer_notes
from .verification import build_payload, emit_verification
from .ws_exec import _git, _pytest

WORKSPACES = settings.WORKSPACES
SAMPLE = settings.SAMPLE
STAGE_TIMEOUT = settings.STAGE_TIMEOUT

# the frozen test surface includes the pytest-config files an implementer could
# use to deselect tests without touching tests/ (collect_ignore, addopts, -k)
CONFIG_SURFACE = ("conftest.py", "pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini")

log = logging.getLogger("factory.runner")

Executor = Callable[..., AgentResult]


def _tests_hash(ws: Path) -> str:
    h = hashlib.sha256()
    paths = sorted(p for p in (ws / "tests").rglob("*") if p.is_file())
    paths += [ws / name for name in CONFIG_SURFACE if (ws / name).is_file()]
    for p in paths:
        h.update(p.relative_to(ws).as_posix().encode())
        h.update(p.read_bytes())
    return h.hexdigest()


def _revert_test_surface(ws: Path) -> None:
    """Reject a test-isolation violation wholesale: restore tracked test/config
    files, delete created ones. src/ changes stay for the human to inspect."""
    _git(ws, "checkout", "--", "tests")
    _git(ws, "clean", "-fdq", "tests")
    for name in CONFIG_SURFACE:
        f = ws / name
        if _git(ws, "ls-files", "--error-unmatch", name).returncode == 0:
            _git(ws, "checkout", "--", name)
        elif f.exists():
            f.unlink()


def workspace_for(req: Request) -> Path:
    if not re.fullmatch(r"REQ-\d+", req.ref or ""):
        raise ValueError(f"refusing workspace path for malformed ref {req.ref!r}")
    return WORKSPACES / req.ref.lower()


class AgentRunner:
    def __init__(self, executor: Executor = run_agent):
        self.exec = executor

    # ---------- workspace ----------
    def ensure_workspace(self, req: Request, spec_md: str) -> Path:
        ws = workspace_for(req)
        if not (ws / ".git").exists():
            ws.parent.mkdir(parents=True, exist_ok=True)
            if ws.exists():
                shutil.rmtree(ws)
            shutil.copytree(SAMPLE, ws)
            _git(ws, "init", "-b", "main")
            # stage transcripts live in the workspace but never in its history
            (ws / ".git" / "info" / "exclude").write_text(".factory/\n")
            _git(ws, "config", "user.email", "factory@local")
            _git(ws, "config", "user.name", "Factory Builder bot")
            _git(ws, "add", "-A")
            _git(ws, "commit", "-q", "-m", "baseline: sample subject")
        else:
            # a Retry re-enters here: the stage must re-run from a known state,
            # so drop uncommitted leftovers from the failed attempt (committed
            # stage artifacts survive in history; .factory/ is git-excluded)
            _git(ws, "reset", "-q", "--hard")
            _git(ws, "clean", "-fdq")
        (ws / "SPEC.md").write_text(spec_md)
        _git(ws, "checkout", "-q", "-B", f"work/{req.ref.lower()}")
        _git(ws, "add", "SPEC.md")
        _git(ws, "commit", "-q", "-m", f"{req.ref}: approved SPEC.md")
        return ws

    @staticmethod
    def spec_md(req: Request) -> str:
        lines = [f"# SPEC — {req.title}", "", f"Request {req.ref} · {req.app_name}", ""]
        for sl in req.spec_lines:
            tag = "(ASSUMPTION — confirm before relying on it)" if sl.assume else f"(from: {sl.prov})"
            lines.append(f"- {sl.text} {tag}")
        return "\n".join(lines) + "\n"

    def _save_transcript(self, ws: Path, stage: str, res: AgentResult) -> None:
        """The agent's full output survives in the workspace — the operator's
        answer to 'what did the agent actually do for 300 seconds'."""
        try:
            d = ws / ".factory"
            d.mkdir(exist_ok=True)
            (d / f"{stage}.log").write_text(res.text or res.error or "(empty)")
        except OSError:  # a transcript must never take the stage down
            log.exception("could not persist %s transcript", stage)

    # ---------- the pipeline ----------
    def start(self, request_id: int) -> None:
        """Fire-and-forget: the factory runs in a worker thread after Approve/Retry."""
        threading.Thread(target=self.run_pipeline, args=(request_id,), daemon=True).start()

    def run_pipeline(self, request_id: int) -> None:
        with SessionLocal() as db:
            req = db.get(Request, request_id)
            if not req:
                return
            log.info("pipeline start %s (stage=%s)", req.ref, req.stage)
            try:
                resumable = (workspace_for(req) / ".git").exists()
                ws = self.ensure_workspace(req, self.spec_md(req))
            except Exception as e:  # workspace failures escalate, never crash the API
                log.exception("workspace setup failed for %s", req.ref)
                self._escalate(db, req, f"Workspace setup failed: {e}")
                return
            # Retry resumes at the stuck Stage (CONTEXT.md: "re-run the same
            # Stage fresh"), not from the top — but only when the workspace
            # survived; a rebuilt one has no PLAN.md/tests yet, so it replays
            # everything from architecture.
            stages = (self._architecture, self._red, self._green, self._review)
            first = {"build": 1, "review": 3}.get(req.stage, 0) if resumable else 0
            for stage_fn in stages[first:]:
                db.refresh(req)
                if req.status != "approved" or req.needs_human:  # cancelled / escalated meanwhile
                    log.info("pipeline stop %s — status=%s needs_human=%s",
                             req.ref, req.status, req.needs_human)
                    return
                try:
                    ok = stage_fn(db, req, ws)
                except Exception as e:  # a crashed stage must escalate, never strand the request
                    log.exception("stage %s crashed for %s", stage_fn.__name__, req.ref)
                    db.rollback()
                    self._escalate(db, req, f"{stage_fn.__name__.lstrip('_')} stage crashed: {e}")
                    return
                if not ok:
                    return
            log.info("pipeline %s waiting at the merge gate", req.ref)

    def _advance(self, db: Session, req: Request, stage: str) -> None:
        req.stage = stage
        req.stage_entered_at = utcnow()
        db.commit()

    def _escalate(self, db: Session, req: Request, reason: str) -> None:
        db.refresh(req)
        if req.status in ("cancelled", "done"):  # a Cancel raced us — it wins, nothing to flag
            log.info("escalation for %s dropped — request is %s", req.ref, req.status)
            return
        lifecycle.escalate(db, req, reason)
        log.error("escalated %s: %s", req.ref, reason)

    def _commit_ws(self, ws: Path, message: str) -> None:
        _git(ws, "add", "-A")
        _git(ws, "commit", "-q", "-m", message)

    def _stage_prompt(self, db: Session, req: Request, prompt: str) -> tuple[str, list[int]]:
        """Carry pending operator notes into the next agent invocation."""
        notes = pending_steer_notes(db, req)
        if not notes:
            return prompt, []
        guidance = "\n".join(f"- {note.body}" for note in notes)
        return (
            f"{prompt}\n\nOperator steering to honor in this stage:\n{guidance}",
            [note.id for note in notes],
        )

    @staticmethod
    def _emit_step_boundary(
        db: Session,
        req: Request,
        *,
        step: int,
        of: int,
        label: str,
        acked_steer_ids: list[int],
    ) -> None:
        emit(
            db,
            req,
            "step_summary",
            f"{label} ({step}/{of})",
            payload={
                "step": step,
                "of": of,
                "label": label,
                "acked_steer_ids": acked_steer_ids,
                "Ref": req.ref,
            },
        )
        db.commit()

    # ---------- stages ----------
    def _architecture(self, db: Session, req: Request, ws: Path) -> bool:
        self._advance(db, req, "architecture")
        prompt, steer_ids = self._stage_prompt(
            db, req,
            "You are the architect stage of a software factory. Read SPEC.md and the code under src/. "
            "Write PLAN.md: a short implementation plan — which functions in src/ change or get added, "
            "what the public behavior must be, and which tests will prove it. Do NOT change any code. "
            "Keep it under 40 lines. End by confirming PLAN.md is written.",
        )
        self._emit_step_boundary(db, req, step=1, of=1, label="Architecture agent started",
                                 acked_steer_ids=steer_ids)
        res = self.exec(
            prompt,
            cwd=str(ws), allow_edits=True, timeout=STAGE_TIMEOUT,
        )
        self._save_transcript(ws, "architecture", res)
        if not res.ok or not (ws / "PLAN.md").exists():
            self._escalate(db, req, res.error or "Architecture stage produced no PLAN.md")
            return False
        self._commit_ws(ws, f"{req.ref}: PLAN.md")
        emit(db, req, "milestone_summary", "Architecture plan committed — PLAN.md validated against SPEC.md",
             payload={"fields": {"Artifacts": "PLAN.md", "Agent": "Factory agent"}, "Ref": req.ref})
        db.commit()
        log.info("%s: architecture gate passed", req.ref)
        return True

    def _red(self, db: Session, req: Request, ws: Path) -> bool:
        self._advance(db, req, "build")
        prompt, steer_ids = self._stage_prompt(
            db, req,
            "You are the test-author stage. Read SPEC.md and PLAN.md. Write failing pytest tests under "
            "tests/ ONLY (never touch src/) that pin the NEW behavior the spec demands. The existing "
            "tests must stay green. Run pytest to confirm your new tests fail because the feature is "
            "missing — assertion failures, not import errors.",
        )
        self._emit_step_boundary(db, req, step=1, of=2, label="RED test author started",
                                 acked_steer_ids=steer_ids)
        res = self.exec(
            prompt,
            cwd=str(ws), allow_edits=True, timeout=STAGE_TIMEOUT,
        )
        self._save_transcript(ws, "red", res)
        if not res.ok:
            self._escalate(db, req, res.error or "Test-author stage failed")
            return False
        proc = _pytest(ws)
        if proc.returncode == 127:
            self._escalate(db, req, f"RED gate cannot run: {proc.stderr}")
            return False
        if proc.returncode == 0:
            self._escalate(db, req, "RED gate: new tests did not fail — nothing pins the new behavior")
            return False
        if proc.returncode not in (1,):  # 2+ = collection/usage errors, 124 = hang — not honest failures
            self._escalate(db, req, f"RED gate: tests broke instead of failing (pytest rc={proc.returncode})")
            return False
        self._commit_ws(ws, f"{req.ref}: RED — failing tests pin the spec")
        summary = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else "tests failing"
        emit(db, req, "milestone_summary", f"RED: failing tests authored — fail for the right reason ({summary})",
             payload={"fields": {"Gate": "RED · passed", "Agent": "Factory agent"}, "Ref": req.ref})
        db.commit()
        log.info("%s: RED gate passed (%s)", req.ref, summary)
        return True

    def _green(self, db: Session, req: Request, ws: Path) -> bool:
        frozen = _tests_hash(ws)
        prompt, steer_ids = self._stage_prompt(
            db, req,
            "You are the implementer stage. Make the failing tests pass by editing src/ ONLY. You are "
            "FORBIDDEN from editing anything under tests/ or any pytest configuration — a CI gate rejects "
            "any change there. Read PLAN.md, implement, run pytest until the whole suite is green.",
        )
        self._emit_step_boundary(db, req, step=2, of=2, label="GREEN implementer started",
                                 acked_steer_ids=steer_ids)
        res = self.exec(
            prompt,
            cwd=str(ws), allow_edits=True, timeout=STAGE_TIMEOUT,
        )
        self._save_transcript(ws, "green", res)
        if not res.ok:
            self._escalate(db, req, res.error or "Implementer stage failed")
            return False
        if _tests_hash(ws) != frozen:  # the load-bearing rule, enforced on the artifact
            _revert_test_surface(ws)
            self._escalate(db, req, "Test-isolation gate: the implementer modified the frozen test surface — change rejected")
            return False
        proc = _pytest(ws)
        if proc.returncode == 127:
            self._escalate(db, req, f"GREEN gate cannot run: {proc.stderr}")
            return False
        if proc.returncode != 0:
            self._escalate(db, req, f"GREEN gate: suite still failing\n{proc.stdout[-200:]}")
            return False
        self._commit_ws(ws, f"{req.ref}: GREEN — implementation passes the frozen tests")
        summary = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else "all green"
        emit(db, req, "milestone_summary",
             f"GREEN: {summary}; implementer touched no test files",
             payload={"fields": {"Gate": "GREEN + Test-isolation · passed", "Agent": "Factory agent"}, "Ref": req.ref})
        db.commit()
        log.info("%s: GREEN + test-isolation gates passed (%s)", req.ref, summary)
        return True

    def _review(self, db: Session, req: Request, ws: Path) -> bool:
        self._advance(db, req, "review")
        diff = _git(ws, "diff", "main...HEAD", "--stat").stdout[-1500:]
        prompt, steer_ids = self._stage_prompt(
            db, req,
            "You are the read-only reviewer stage. Review the work branch against SPEC.md and PLAN.md. "
            f"The diff summary:\n{diff}\n"
            "Write REVIEW.md: does the implementation honor the spec, are the tests meaningful, any risks. "
            "Verdict line at the top: APPROVE or REQUEST-CHANGES. Do not modify src/ or tests/.",
        )
        self._emit_step_boundary(db, req, step=1, of=1, label="Review agent started",
                                 acked_steer_ids=steer_ids)
        res = self.exec(
            prompt,
            cwd=str(ws), allow_edits=True, timeout=STAGE_TIMEOUT,
        )
        self._save_transcript(ws, "review", res)
        review = (ws / "REVIEW.md")
        if not res.ok or not review.exists() or not review.read_text().strip():
            self._escalate(db, req, res.error or "Reviewer stage produced no usable REVIEW.md")
            return False
        self._commit_ws(ws, f"{req.ref}: review report")
        verdict = review.read_text().strip().splitlines()[0][:120]
        db.refresh(req)
        if req.status != "approved":  # cancelled while the reviewer ran — never raise a gate on it
            log.info("%s cancelled during review — merge gate not raised", req.ref)
            return False
        emit(db, req, "milestone_summary", f"Review report committed — {verdict}",
             payload={"fields": {"Artifacts": "REVIEW.md", "Agent": "Factory agent"}, "Ref": req.ref})
        vpayload = build_payload(ws, req)
        if vpayload["tests_total"] == 0 or vpayload["files_changed"] == 0:
            # the suite proved green at the GREEN gate and the work branch must
            # diverge from main; if either can't be derived now (the suite
            # didn't run, or the diff came back empty), the evidence would be a
            # lie — escalate rather than raise a blind gate
            self._escalate(db, req, "Verification could not be built — the suite did not run or the diff was empty at review")
            return False
        # emit through the single source of truth, passing the payload the guard
        # above already vetted so the guard and the event never diverge
        emit_verification(db, req, ws, payload=vpayload)
        lifecycle.raise_merge_gate(db, req)
        db.commit()
        log.info("%s: review committed, verification emitted, merge gate raised", req.ref)
        return True

    # ---------- the human merge gate ----------
    def approve_merge(self, db: Session, req: Request, actor: str) -> None:
        """Honest deploy: if the merge cannot happen, the request escalates —
        it is never reported done on a merge that did not occur."""
        ws = workspace_for(req)
        if not (ws / ".git").exists():
            self._escalate(db, req, "Merge failed: the workspace is missing (rebuilt container?) — Retry rebuilds it")
            return
        _git(ws, "checkout", "-q", "main")
        merge = _git(ws, "merge", "--no-ff", "-q", "-m",
                     f"{req.ref}: merge (approved by {actor})", f"work/{req.ref.lower()}")
        if merge.returncode != 0:
            _git(ws, "merge", "--abort")
            _git(ws, "checkout", "-q", f"work/{req.ref.lower()}")
            self._escalate(db, req, f"Merge failed: {(merge.stderr or merge.stdout).strip()[:200] or 'git merge error'}")
            return
        lifecycle.finish_done(db, req, actor,
                              merge_note="work branch merged to main",
                              deploy_title="Deployed — main updated in the Subject workspace",
                              payload_extra={"merged": True, "workspace": str(ws)})
        db.commit()
        log.info("%s merged to main by %s", req.ref, actor)
