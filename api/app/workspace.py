"""Git-as-workspace for the kube path (Plan B2; spec §5/§6).

The orchestrator OWNS one non-bare git repo per request under
settings.WORKSPACES; a git-daemon sidecar (deploy/base/factory-api.yaml)
exports the same directory to agent/gate Jobs as GIT_REMOTE_BASE/<ref>.
Everything trust-critical is computed HERE on the orchestrator's copy,
never taken from a pod's word:

  * surface_hash_at(): the frozen-test-surface hash at an exact SHA — the
    orchestrator-side pure-git check of spec §6 (config-based test
    deselection is covered by SURFACE_PATHS);
  * reset_branch(): a new attempt starts from the last graded SHA, so
    half-pushed work from a killed pod is never silently inherited (spec §5);
  * merge_graded(): merge exactly the graded SHA into main — the SHA
    precondition of spec §6, local edition (GitHub API merge is B3).

Push contract: the work branch stays checked out and the repo sets
receive.denyCurrentBranch=updateInstead, so an agent pod's push refreshes
the orchestrator's working tree in place (refused if that tree is dirty —
the orchestrator keeps it clean by construction).

settings.WORKSPACES / settings.SAMPLE / settings.GIT_REMOTE_BASE are read
at CALL time (not import) so tests can monkeypatch them.
"""
import hashlib
import re
import shutil
from pathlib import Path

from . import settings
from .ws_exec import _git

BASELINE_TAG = "sf-baseline"

# spec §6's frozen surface: tests plus every config file that could deselect
# them. Paths absent from a repo simply contribute nothing to the hash.
SURFACE_PATHS = (
    "tests",
    "conftest.py",
    "pyproject.toml",
    "pytest.ini",
    "setup.cfg",
    "tox.ini",
    "package.json",
    "vitest.config.ts",
    "angular.json",
)


def workspace_for(req) -> Path:
    if not re.fullmatch(r"REQ-\d+", req.ref or ""):
        raise ValueError(f"refusing workspace path for malformed ref {req.ref!r}")
    return Path(settings.WORKSPACES) / req.ref.lower()


def work_branch(ref: str) -> str:
    return f"work/{ref.lower()}"


def spec_md(req) -> str:
    lines = [f"# SPEC — {req.title}", "", f"Request {req.ref} · {req.app_name}", ""]
    for sl in req.spec_lines:
        tag = (
            "(ASSUMPTION — confirm before relying on it)"
            if sl.assume
            else f"(from: {sl.prov})"
        )
        lines.append(f"- {sl.text} {tag}")
    return "\n".join(lines) + "\n"


def repo_url(ref: str) -> str:
    base = settings.GIT_REMOTE_BASE
    return f"{base}/{ref.lower()}" if base else ""


def ensure_repo(req, spec: str) -> Path:
    """Create the per-request repo once; NEVER touch an existing one — agent
    pushes live there and must not be clobbered by a re-entrant tick."""
    ws = workspace_for(req)
    if (ws / ".git").exists():
        return ws
    ws.parent.mkdir(parents=True, exist_ok=True)
    if ws.exists():
        shutil.rmtree(ws)
    shutil.copytree(Path(settings.SAMPLE), ws)
    _git(ws, "init", "-b", "main")
    (ws / ".git" / "info" / "exclude").write_text(".factory/\n")
    _git(ws, "config", "user.email", "factory@local")
    _git(ws, "config", "user.name", "Factory Builder bot")
    _git(ws, "config", "receive.denyCurrentBranch", "updateInstead")
    _git(ws, "add", "-A")
    _git(ws, "commit", "-q", "-m", "baseline: sample subject")
    (ws / "SPEC.md").write_text(spec)
    _git(ws, "checkout", "-q", "-B", work_branch(req.ref))
    _git(ws, "add", "SPEC.md")
    _git(ws, "commit", "-q", "-m", f"{req.ref}: approved SPEC.md")
    _git(ws, "tag", "-f", BASELINE_TAG)
    return ws


def head_sha(ws: Path, refname: str = "HEAD") -> str | None:
    out = _git(ws, "rev-parse", refname)
    return out.stdout.strip() if out.returncode == 0 else None


def surface_hash_at(ws: Path, sha: str) -> str | None:
    """sha256 over `git ls-tree <sha> -- SURFACE_PATHS` — the tree hash of
    tests/ covers every file under it; the config blobs cover deselection.
    None = the SHA does not resolve in this repo (never a pass)."""
    if not re.fullmatch(r"[0-9a-fA-F]{7,40}", sha or ""):
        return None
    if _git(ws, "cat-file", "-e", f"{sha}^{{commit}}").returncode != 0:
        return None
    out = _git(ws, "ls-tree", sha, "--", *SURFACE_PATHS)
    if out.returncode != 0:
        return None
    return hashlib.sha256(out.stdout.encode()).hexdigest()


def reset_branch(ws: Path, ref: str, to_sha: str) -> bool:
    """Forced: a new attempt starts from the last graded SHA (spec §5)."""
    if _git(ws, "checkout", "-q", work_branch(ref)).returncode != 0:
        return False
    ok = _git(ws, "reset", "-q", "--hard", to_sha).returncode == 0
    _git(ws, "clean", "-fdq")
    return ok


def merge_graded(ws: Path, ref: str, sha: str, actor: str) -> str | None:
    """Merge exactly the graded SHA into main. Returns an error string, or
    None on success (main checked out — 'deployed' in the B2 sense)."""
    head = head_sha(ws, work_branch(ref))
    if head != sha:
        return (
            f"work branch head {(head or 'missing')[:12]} is not the graded "
            f"SHA {sha[:12]} — refusing to merge"
        )
    _git(ws, "checkout", "-q", "main")
    merge = _git(
        ws,
        "merge",
        "--no-ff",
        "-q",
        "-m",
        f"{ref}: merge (approved by {actor})",
        sha,
    )
    if merge.returncode != 0:
        _git(ws, "merge", "--abort")
        _git(ws, "checkout", "-q", work_branch(ref))
        return (merge.stderr or merge.stdout).strip()[:200] or "git merge error"
    return None
