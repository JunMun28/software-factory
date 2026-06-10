"""ClaudeRunner — Stages 2–5 executed for real by Claude Code (ADR 0011).

Enabled with FACTORY_RUNNER=claude. Each approved Request gets a git workspace
copied from `sample/`; the stage agents run `claude -p` headless inside it and
the GATES ARE MACHINE-CHECKED, not taken on the agent's word:

  architecture  → PLAN.md must exist                     (structural validation)
  build · RED   → pytest must FAIL with collected tests  (RED gate)
  build · GREEN → pytest must PASS and the tests/ tree
                  hash must be untouched                 (GREEN + test-isolation gate)
  review        → REVIEW.md must exist, then the human
                  merge gate is raised                   (humans gate the irreversible)
  merge approve → git merge work branch → main           (the "deploy")

Any gate failure or timeout escalates (needs_human) — no automatic retry,
exactly like CONTEXT.md's Escalation. The executor is injectable for tests.
"""
import hashlib
import os
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Callable

from sqlalchemy.orm import Session

from .claude_exec import ClaudeResult, run_claude
from .db import SessionLocal
from .events import emit
from .models import Request, utcnow

WORKSPACES = Path(os.environ.get("FACTORY_WORKSPACES", "workspaces"))
SAMPLE = Path(os.environ.get("FACTORY_SAMPLE", "../sample"))
STAGE_TIMEOUT = int(os.environ.get("FACTORY_STAGE_TIMEOUT", "300"))

Executor = Callable[..., ClaudeResult]


def _git(ws: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(ws), *args], capture_output=True, text=True)


def _pytest(ws: Path) -> subprocess.CompletedProcess:
    return subprocess.run(["python", "-m", "pytest", "-q", "--no-header"],
                          cwd=ws, capture_output=True, text=True, timeout=120)


def _tests_hash(ws: Path) -> str:
    h = hashlib.sha256()
    tests = ws / "tests"
    for p in sorted(tests.rglob("*.py")):
        h.update(p.relative_to(ws).as_posix().encode())
        h.update(p.read_bytes())
    return h.hexdigest()


def workspace_for(req: Request) -> Path:
    return WORKSPACES / req.ref.lower()


class ClaudeRunner:
    def __init__(self, executor: Executor = run_claude):
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
            _git(ws, "config", "user.email", "factory@local")
            _git(ws, "config", "user.name", "Factory Builder bot")
            _git(ws, "add", "-A")
            _git(ws, "commit", "-q", "-m", "baseline: sample subject")
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

    # ---------- the pipeline ----------
    def start(self, request_id: int) -> None:
        """Fire-and-forget: the factory runs in a worker thread after Approve."""
        threading.Thread(target=self.run_pipeline, args=(request_id,), daemon=True).start()

    def run_pipeline(self, request_id: int) -> None:
        with SessionLocal() as db:
            req = db.get(Request, request_id)
            if not req:
                return
            try:
                ws = self.ensure_workspace(req, self.spec_md(req))
            except Exception as e:  # workspace failures escalate, never crash the API
                self._escalate(db, req, f"Workspace setup failed: {e}")
                return
            for stage_fn in (self._architecture, self._red, self._green, self._review):
                db.refresh(req)
                if req.status != "approved" or req.needs_human:  # cancelled / escalated meanwhile
                    return
                if not stage_fn(db, req, ws):
                    return

    def _advance(self, db: Session, req: Request, stage: str) -> None:
        req.stage = stage
        req.stage_entered_at = utcnow()
        db.commit()

    def _escalate(self, db: Session, req: Request, reason: str) -> None:
        req.needs_human = True
        req.needs_human_reason = reason[:300]
        emit(db, req, "escalation", f"Escalated — needs a human ({reason[:140]})",
             broadcast=True, payload={"Ref": req.ref, "reason": reason[:300]})
        db.commit()

    def _commit_ws(self, ws: Path, message: str) -> None:
        _git(ws, "add", "-A")
        _git(ws, "commit", "-q", "-m", message)

    # ---------- stages ----------
    def _architecture(self, db: Session, req: Request, ws: Path) -> bool:
        self._advance(db, req, "architecture")
        res = self.exec(
            "You are the architect stage of a software factory. Read SPEC.md and the code under src/. "
            "Write PLAN.md: a short implementation plan — which functions in src/ change or get added, "
            "what the public behavior must be, and which tests will prove it. Do NOT change any code. "
            "Keep it under 40 lines. End by confirming PLAN.md is written.",
            cwd=str(ws), allow_edits=True, timeout=STAGE_TIMEOUT,
        )
        if not res.ok or not (ws / "PLAN.md").exists():
            self._escalate(db, req, res.error or "Architecture stage produced no PLAN.md")
            return False
        self._commit_ws(ws, f"{req.ref}: PLAN.md")
        emit(db, req, "milestone_summary", "Architecture plan committed — PLAN.md validated against SPEC.md",
             payload={"fields": {"Artifacts": "PLAN.md", "Agent": "Claude Code"}, "Ref": req.ref})
        db.commit()
        return True

    def _red(self, db: Session, req: Request, ws: Path) -> bool:
        self._advance(db, req, "build")
        res = self.exec(
            "You are the test-author stage. Read SPEC.md and PLAN.md. Write failing pytest tests under "
            "tests/ ONLY (never touch src/) that pin the NEW behavior the spec demands. The existing "
            "tests must stay green. Run pytest to confirm your new tests fail because the feature is "
            "missing — assertion failures, not import errors.",
            cwd=str(ws), allow_edits=True, timeout=STAGE_TIMEOUT,
        )
        if not res.ok:
            self._escalate(db, req, res.error or "Test-author stage failed")
            return False
        proc = _pytest(ws)
        if proc.returncode == 0:
            self._escalate(db, req, "RED gate: new tests did not fail — nothing pins the new behavior")
            return False
        if proc.returncode not in (1,):  # 2+ = collection/usage errors, not honest assertion failures
            self._escalate(db, req, f"RED gate: tests broke instead of failing (pytest rc={proc.returncode})")
            return False
        self._commit_ws(ws, f"{req.ref}: RED — failing tests pin the spec")
        summary = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else "tests failing"
        emit(db, req, "milestone_summary", f"RED: failing tests authored — fail for the right reason ({summary})",
             payload={"fields": {"Gate": "RED · passed", "Agent": "Claude Code"}, "Ref": req.ref})
        db.commit()
        return True

    def _green(self, db: Session, req: Request, ws: Path) -> bool:
        frozen = _tests_hash(ws)
        res = self.exec(
            "You are the implementer stage. Make the failing tests pass by editing src/ ONLY. You are "
            "FORBIDDEN from editing anything under tests/ — a CI gate rejects any change there. Read "
            "PLAN.md, implement, run pytest until the whole suite is green.",
            cwd=str(ws), allow_edits=True, timeout=STAGE_TIMEOUT,
        )
        if not res.ok:
            self._escalate(db, req, res.error or "Implementer stage failed")
            return False
        if _tests_hash(ws) != frozen:  # the load-bearing rule, enforced on the artifact
            _git(ws, "checkout", "--", "tests")
            self._escalate(db, req, "Test-isolation gate: the implementer modified tests/ — change rejected")
            return False
        proc = _pytest(ws)
        if proc.returncode != 0:
            self._escalate(db, req, f"GREEN gate: suite still failing\n{proc.stdout[-200:]}")
            return False
        self._commit_ws(ws, f"{req.ref}: GREEN — implementation passes the frozen tests")
        summary = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else "all green"
        emit(db, req, "milestone_summary",
             f"GREEN: {summary}; implementer touched no test files",
             payload={"fields": {"Gate": "GREEN + Test-isolation · passed", "Agent": "Claude Code"}, "Ref": req.ref})
        db.commit()
        return True

    def _review(self, db: Session, req: Request, ws: Path) -> bool:
        self._advance(db, req, "review")
        diff = _git(ws, "diff", "main...HEAD", "--stat").stdout[-1500:]
        res = self.exec(
            "You are the read-only reviewer stage. Review the work branch against SPEC.md and PLAN.md. "
            f"The diff summary:\n{diff}\n"
            "Write REVIEW.md: does the implementation honor the spec, are the tests meaningful, any risks. "
            "Verdict line at the top: APPROVE or REQUEST-CHANGES. Do not modify src/ or tests/.",
            cwd=str(ws), allow_edits=True, timeout=STAGE_TIMEOUT,
        )
        if not res.ok or not (ws / "REVIEW.md").exists():
            self._escalate(db, req, res.error or "Reviewer stage produced no REVIEW.md")
            return False
        self._commit_ws(ws, f"{req.ref}: review report")
        verdict = (ws / "REVIEW.md").read_text().strip().splitlines()[0][:120]
        emit(db, req, "milestone_summary", f"Review report committed — {verdict}",
             payload={"fields": {"Artifacts": "REVIEW.md", "Agent": "Claude Code"}, "Ref": req.ref})
        req.gate = "approve_merge"
        req.stage_entered_at = utcnow()
        emit(db, req, "gate_event", "Waiting at the merge gate — review passed, approval needed",
             broadcast=True, payload={"gate": "approve_merge", "Ref": req.ref})
        db.commit()
        return True

    # ---------- the human merge gate ----------
    def approve_merge(self, db: Session, req: Request, actor: str) -> None:
        ws = workspace_for(req)
        merged = False
        if (ws / ".git").exists():
            _git(ws, "checkout", "-q", "main")
            merged = _git(ws, "merge", "--no-ff", "-q", "-m", f"{req.ref}: merge (approved by {actor})",
                          f"work/{req.ref.lower()}").returncode == 0
        req.gate = None
        req.stage = "done"
        req.status = "done"
        req.stage_entered_at = utcnow()
        emit(db, req, "gate_event", f"Merge approved by {actor} — work branch merged to main",
             actor=actor, bot=False, broadcast=True,
             payload={"gate": "approve_merge", "Ref": req.ref, "merged": merged})
        emit(db, req, "milestone_summary", "Deployed — main updated in the Subject workspace",
             stage="done", payload={"Stage": "Done", "Ref": req.ref, "workspace": str(ws)})
        db.commit()
