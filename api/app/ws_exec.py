"""Thin subprocess wrappers for acting on a workspace — git and pytest.

Shared by the runner's gates (agent_runner) and the merge-gate evidence
builder (verification) so the venv / timeout / missing-pytest handling lives in
ONE place.
"""
import subprocess
import sys
from pathlib import Path

from . import settings

GIT_TIMEOUT_RC = 124


class GitTimeout(Exception):
    """A git subprocess exceeded its bound; always an infrastructure fault."""


def _git(ws: Path, *args: str) -> subprocess.CompletedProcess:
    cmd = ["git", "-C", str(ws), *args]
    verb = args[0] if args else "git"
    try:
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=settings.GIT_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(
            cmd,
            returncode=GIT_TIMEOUT_RC,
            stdout="",
            stderr=(
                f"git timed out after {settings.GIT_TIMEOUT}s "
                f"(op: {verb})"
            ),
        )


def _pytest(ws: Path) -> subprocess.CompletedProcess:
    # sys.executable, not "python": the gate must run in the API's own venv —
    # the only interpreter guaranteed to carry pytest (a bare PATH lookup may
    # resolve to a pytest-less python, e.g. in the container)
    cmd = [sys.executable, "-m", "pytest", "-q", "--no-header"]
    try:
        proc = subprocess.run(cmd, cwd=ws, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        # a hanging generated test is a gate failure, not a crashed pipeline
        return subprocess.CompletedProcess(
            cmd, returncode=124, stdout="pytest timed out after 120s — a test is hanging", stderr="")
    if "No module named pytest" in (proc.stderr or ""):
        # rc=1 without pytest is NOT an honest test failure — it must never
        # pass the RED gate; surface it as "the gate itself cannot run"
        return subprocess.CompletedProcess(
            cmd, returncode=127, stdout="", stderr="pytest is not installed in the runner environment")
    return proc
