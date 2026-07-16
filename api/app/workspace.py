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
import ast
import hashlib
import json
import re
import shutil
from pathlib import Path

from . import settings
from .ws_exec import GIT_TIMEOUT_RC, GitTimeout, _git

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


def acceptance_md(req) -> str:
    lines = [
        f"# ACCEPTANCE CRITERIA — {req.title}",
        "",
        f"Request {req.ref} · {req.app_name}",
        "",
        "Each criterion below has a STABLE id. Write >=1 failing test per",
        "criterion and record the mapping in tests/acceptance.json.",
        "",
    ]
    version = max(
        (criterion.version for criterion in req.acceptance_criteria), default=0
    )
    criteria = sorted(
        (
            criterion
            for criterion in req.acceptance_criteria
            if criterion.version == version
        ),
        key=lambda criterion: criterion.ordinal,
    )
    for criterion in criteria:
        flag = " (ASSUMPTION)" if criterion.assume else ""
        lines.append(f"- **{criterion.code}**: {criterion.text}{flag}")
    return "\n".join(lines) + "\n"


def repo_url(ref: str) -> str:
    base = settings.GIT_REMOTE_BASE
    return f"{base}/{ref.lower()}" if base else ""


def github_https_url(slug: str) -> str:
    """The public https URL of the produced-app repo (no credential)."""
    return f"https://github.com/{settings.GITHUB_OWNER}/sf-app-{slug}.git"


def _authed_url(slug: str) -> str:
    # x-access-token is GitHub's convention for a bearer/PAT over https.
    return (
        f"https://x-access-token:{settings.GITHUB_TOKEN}"
        f"@github.com/{settings.GITHUB_OWNER}/sf-app-{slug}.git"
    )


def sanitize_github_git_error(message: str) -> str:
    """Remove GitHub credentials before an error crosses the workspace seam."""
    sanitized = re.sub(
        r"https://x-access-token:[^@\s]+@github\.com/",
        "https://github.com/",
        message or "",
    )
    if settings.GITHUB_TOKEN:
        sanitized = sanitized.replace(settings.GITHUB_TOKEN, "<redacted>")
    return sanitized


def _github_git_error(out, fallback: str) -> str:
    detail = sanitize_github_git_error(out.stderr or out.stdout).strip()[:200]
    return detail or fallback


def push_branch_to_github(
    ws: Path, slug: str, ref: str, *, force: bool = False
) -> str | None:
    """Push the local work branch to GitHub. force (rewind to last-graded SHA on a
    retry) uses --force-with-lease so a concurrent push is never clobbered. Returns
    an error string or None. The authed URL is passed per-command, never persisted."""
    br = work_branch(ref)
    url = _authed_url(slug)
    force_args = []
    if force:
        remote_ref = f"refs/heads/{br}"
        remote = _git(ws, "ls-remote", url, remote_ref)
        if remote.returncode != 0:
            return _github_git_error(
                remote, f"read remote {br} head from github failed"
            )
        expected = remote.stdout.strip().split(maxsplit=1)[0] if remote.stdout.strip() else ""
        force_args = [f"--force-with-lease={remote_ref}:{expected}"]
    args = ["push"] + force_args + [url, f"{br}:{br}"]
    out = _git(ws, *args)
    return None if out.returncode == 0 else _github_git_error(out, "push to github failed")


def fetch_ref_from_github(
    ws: Path, slug: str, ref: str, sha: str | None = None
) -> str | None:
    """Fetch the work branch (agent pushed to GitHub) into the LOCAL mirror so
    git-daemon serves the pinned SHA to gate/build pods and surface_hash_at can
    resolve it. Fast-forwards the local work branch; a rewind updates it hard.
    Returns an error string or None."""
    br = work_branch(ref)
    if _git(ws, "fetch", _authed_url(slug), br).returncode != 0:
        return f"fetch {br} from github failed"
    if sha and head_sha(ws, "FETCH_HEAD") != sha:
        return f"fetched head is not the reported SHA {sha[:12]}"
    if _git(ws, "checkout", "-q", "main").returncode != 0:
        return "could not check out local main"
    # Move the local branch without checking it out.
    if _git(ws, "branch", "-f", br, "FETCH_HEAD").returncode != 0:
        return f"could not update local {br} to fetched head"
    return None


def fetch_main_from_github(ws: Path, slug: str) -> str | None:
    """After a GitHub-API merge: pull merged main into the local mirror so the
    build clone (git://api:9418/<ref>) sees the merge commit — B3's build path
    is byte-for-byte unchanged."""
    if _git(ws, "fetch", _authed_url(slug), "main").returncode != 0:
        return "fetch main from github failed"
    if _git(ws, "checkout", "-q", "main").returncode != 0:
        return "could not check out local main"
    if _git(ws, "reset", "-q", "--hard", "FETCH_HEAD").returncode != 0:
        return "could not fast-forward local main to merged head"
    return None


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
    None = the SHA does not resolve in this repo (never a pass). A timeout is
    infra, not evidence that the frozen surface changed."""
    if not re.fullmatch(r"[0-9a-fA-F]{7,40}", sha or ""):
        return None
    exists = _git(ws, "cat-file", "-e", f"{sha}^{{commit}}")
    if exists.returncode == GIT_TIMEOUT_RC:
        raise GitTimeout(exists.stderr)
    if exists.returncode != 0:
        return None
    out = _git(ws, "ls-tree", sha, "--", *SURFACE_PATHS)
    if out.returncode == GIT_TIMEOUT_RC:
        raise GitTimeout(out.stderr)
    if out.returncode != 0:
        return None
    return hashlib.sha256(out.stdout.encode()).hexdigest()


def plan_at(
    ws: Path, sha: str, *, max_lines: int = 40
) -> tuple[str, str] | None:
    """Read PLAN.md from an exact orchestrator-side commit."""
    if not re.fullmatch(r"[0-9a-fA-F]{7,40}", sha or ""):
        return None
    out = _git(ws, "show", f"{sha}:PLAN.md")
    if out.returncode == GIT_TIMEOUT_RC:
        raise GitTimeout(out.stderr)
    if out.returncode != 0:
        return None
    body = out.stdout
    excerpt = "".join(body.splitlines(keepends=True)[:max_lines])
    digest = "sha256:" + hashlib.sha256(body.encode()).hexdigest()[:12]
    return excerpt, digest


def merge_base_at(ws: Path, left: str, right: str) -> str | None:
    """Resolve a merge base, distinguishing unavailable refs from no changes."""
    out = _git(ws, "merge-base", left, right)
    if out.returncode == GIT_TIMEOUT_RC:
        raise GitTimeout(out.stderr)
    value = out.stdout.strip()
    return value if out.returncode == 0 and re.fullmatch(r"[0-9a-fA-F]{40}", value) else None


def numstat_at(
    ws: Path, base_sha: str, sha: str, *, max_files: int = 50
) -> list[dict] | None:
    """Per-file diffstat from an explicit PR base to an exact graded SHA."""
    if not all(
        re.fullmatch(r"[0-9a-fA-F]{7,40}", value or "")
        for value in (base_sha, sha)
    ):
        return None
    out = _git(ws, "diff", "--numstat", f"{base_sha}...{sha}")
    if out.returncode == GIT_TIMEOUT_RC:
        raise GitTimeout(out.stderr)
    if out.returncode != 0:
        return None
    rows: list[dict] = []
    for line in out.stdout.splitlines()[:max_files]:
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        added, removed, path = parts
        rows.append(
            {
                "file": path,
                "added": int(added) if added.isdigit() else 0,
                "removed": int(removed) if removed.isdigit() else 0,
            }
        )
    return rows


def acceptance_manifest_at(ws: Path, sha: str) -> dict | None:
    """Parse the committed RED manifest from the orchestrator's own git copy."""
    if not re.fullmatch(r"[0-9a-fA-F]{7,40}", sha or ""):
        return None
    out = _git(ws, "show", f"{sha}:tests/acceptance.json")
    if out.returncode == GIT_TIMEOUT_RC:
        raise GitTimeout(out.stderr)
    if out.returncode != 0:
        return None
    try:
        data = json.loads(out.stdout)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _node_exists_at(ws: Path, sha: str, node: str) -> bool:
    """Validate path::[Class::]function against committed text at ``sha``."""
    if "::" not in node:
        return False
    path, remainder = node.split("::", 1)
    node_parts = [part.split("[", 1)[0] for part in remainder.split("::")]
    name = node_parts[-1]
    exists = _git(ws, "cat-file", "-e", f"{sha}:{path}")
    if exists.returncode == GIT_TIMEOUT_RC:
        raise GitTimeout(exists.stderr)
    if exists.returncode != 0:
        return False
    blob = _git(ws, "show", f"{sha}:{path}")
    if blob.returncode == GIT_TIMEOUT_RC:
        raise GitTimeout(blob.stderr)
    if blob.returncode != 0:
        return False
    try:
        body = ast.parse(blob.stdout).body
    except SyntaxError:
        return False
    for class_name in node_parts[:-1]:
        owner = next(
            (
                item
                for item in body
                if isinstance(item, ast.ClassDef) and item.name == class_name
            ),
            None,
        )
        if owner is None:
            return False
        body = owner.body
    return any(
        isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
        and item.name == name
        for item in body
    )


def acceptance_coverage_at(
    ws: Path, sha: str, ac_codes: list[str]
) -> dict | None:
    """Compute v1 structural-only AC coverage from the graded git tree.

    Nodes must exist and be distinctly mapped. This does not establish that a
    test behaviorally asserts an AC: that semantic grading belongs to
    REVIEW-04 (v2), because this orchestrator does not execute the tests and a
    pod-authored pytest log is not trustworthy evidence.
    """
    manifest = acceptance_manifest_at(ws, sha)
    if manifest is None:
        return None

    valid_by_ac: dict[str, set[str]] = {}
    for code in ac_codes:
        raw_nodes = manifest.get(code) or []
        nodes = raw_nodes if isinstance(raw_nodes, list) else []
        valid_by_ac[code] = {
            node
            for node in nodes
            if isinstance(node, str) and _node_exists_at(ws, sha, node)
        }

    fanin: dict[str, int] = {}
    for nodes in valid_by_ac.values():
        for node in nodes:
            fanin[node] = fanin.get(node, 0) + 1
    total_count = len(ac_codes)
    eligible_by_ac = {
        code: {
            node
            for node in nodes
            if total_count <= 1 or fanin[node] < total_count
        }
        for code, nodes in valid_by_ac.items()
    }
    per_ac = {code: bool(nodes) for code, nodes in eligible_by_ac.items()}
    covered_count = sum(per_ac.values())
    distinct_nodes = set().union(*eligible_by_ac.values()) if eligible_by_ac else set()
    return {
        "total_count": total_count,
        "covered_count": covered_count,
        "coverage": round(covered_count / total_count, 3) if total_count else 0.0,
        "distinct_covering_nodes": len(distinct_nodes),
        "max_fanin": max(fanin.values(), default=0),
        "per_ac": per_ac,
    }


def refresh_contract(ws: Path, req) -> str | None:
    """Commit the current round's contract after the stage reset.

    This deliberately does not live in ensure_repo(), whose early return must
    protect an existing agent branch. Every kube stage/rerun calls this after
    reset, so preview re-derivations reach RED with fresh bytes.
    """
    acceptance_path = ws / "ACCEPTANCE.md"
    if not settings.acceptance_enabled():
        if not acceptance_path.exists():
            return head_sha(ws)
        acceptance_path.unlink()
        _git(ws, "add", "-A", "--", "ACCEPTANCE.md")
        if _git(ws, "diff", "--cached", "--quiet").returncode == 0:
            return head_sha(ws)
        _git(ws, "commit", "-q", "-m", f"{req.ref}: disable acceptance contract")
        return head_sha(ws)

    (ws / "SPEC.md").write_text(spec_md(req))
    acceptance_path.write_text(acceptance_md(req))
    _git(ws, "add", "-A", "--", "SPEC.md", "ACCEPTANCE.md")
    if _git(ws, "diff", "--cached", "--quiet").returncode == 0:
        return head_sha(ws)
    _git(ws, "commit", "-q", "-m", f"{req.ref}: refresh acceptance contract")
    return head_sha(ws)


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
