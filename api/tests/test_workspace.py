"""Git-as-workspace primitives (Plan B2 task 3) — real git in tmp dirs.

Everything trust-critical about the kube pipeline's git backbone is proven
here without any cluster: repo creation, the push contract agent pods rely on
(updateInstead on a checked-out branch), the SHA-pinned frozen-surface hash,
attempt resets, and the SHA-precondition merge.
"""
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import settings, workspace
from app.ws_exec import _git


def _req(ref="REQ-7001"):
    line = SimpleNamespace(text="exports monthly totals", assume=False, prov="interview")
    return SimpleNamespace(
        ref=ref,
        title="Test subject",
        app_name="Northwind",
        spec_lines=[line],
    )


@pytest.fixture()
def ws_root(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "WORKSPACES", tmp_path / "workspaces")
    return tmp_path


def _commit_all(ws: Path, msg: str) -> str:
    _git(ws, "add", "-A")
    _git(ws, "commit", "-q", "-m", msg)
    return _git(ws, "rev-parse", "HEAD").stdout.strip()


def test_ensure_repo_builds_the_contract(ws_root):
    req = _req()
    ws = workspace.ensure_repo(req, workspace.spec_md(req))
    assert (ws / ".git").exists() and (ws / "SPEC.md").exists()
    assert _git(ws, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip() == "work/req-7001"
    assert _git(ws, "config", "receive.denyCurrentBranch").stdout.strip() == "updateInstead"
    assert _git(ws, "rev-parse", workspace.BASELINE_TAG).returncode == 0
    head = workspace.head_sha(ws)
    # idempotent: a second call never moves anything (pushed work is sacred)
    workspace.ensure_repo(req, "REPLACED — must not be written")
    assert workspace.head_sha(ws) == head
    assert "REPLACED" not in (ws / "SPEC.md").read_text()


def test_agent_push_contract_updateInstead(ws_root, tmp_path):
    """What an agent pod does: clone the work branch, commit, push back —
    against the orchestrator's NON-BARE repo with the branch checked out."""
    req = _req()
    ws = workspace.ensure_repo(req, workspace.spec_md(req))
    clone = tmp_path / "podclone"
    subprocess.run(
        ["git", "clone", "-q", "-b", "work/req-7001", str(ws), str(clone)],
        check=True,
    )
    _git(clone, "config", "user.email", "agent@sf.local")
    _git(clone, "config", "user.name", "sf-agent")
    (clone / "PLAN.md").write_text("# plan\n")
    _commit_all(clone, "REQ-7001: architecture")
    push = _git(clone, "push", "-q", "origin", "HEAD:work/req-7001")
    assert push.returncode == 0, push.stderr
    assert (ws / "PLAN.md").exists()  # updateInstead refreshed the working tree
    assert workspace.head_sha(ws) == workspace.head_sha(clone)


def test_surface_hash_pins_the_test_surface(ws_root):
    req = _req()
    ws = workspace.ensure_repo(req, workspace.spec_md(req))
    base = workspace.head_sha(ws)
    h0 = workspace.surface_hash_at(ws, base)
    (ws / "src" / "extra.py").write_text("x = 1\n")
    src_only = _commit_all(ws, "src change")
    assert workspace.surface_hash_at(ws, src_only) == h0  # src/ is free
    (ws / "tests" / "test_sneaky.py").write_text("def test_x():\n    assert True\n")
    tests_touched = _commit_all(ws, "tests change")
    assert workspace.surface_hash_at(ws, tests_touched) != h0  # tests/ is frozen
    assert workspace.surface_hash_at(ws, "0" * 40) is None  # unknown SHA = None


def test_reset_branch_discards_half_pushed_work(ws_root):
    req = _req()
    ws = workspace.ensure_repo(req, workspace.spec_md(req))
    graded = workspace.head_sha(ws)
    (ws / "junk.py").write_text("broken = True\n")
    _commit_all(ws, "half-pushed work from a killed pod")
    assert workspace.reset_branch(ws, req.ref, graded)
    assert workspace.head_sha(ws) == graded
    assert not (ws / "junk.py").exists()


def test_reset_branch_missing_work_branch_does_not_reset_main(ws_root):
    req = _req()
    ws = workspace.ensure_repo(req, workspace.spec_md(req))
    _git(ws, "checkout", "-q", "main")
    (ws / "main-only.txt").write_text("must survive\n")
    main_sha = _commit_all(ws, "main-only commit")
    _git(ws, "branch", "-D", workspace.work_branch(req.ref))

    assert workspace.reset_branch(ws, req.ref, workspace.BASELINE_TAG) is False
    assert workspace.head_sha(ws, "main") == main_sha
    assert (ws / "main-only.txt").read_text() == "must survive\n"


def test_merge_graded_enforces_the_sha_precondition(ws_root):
    req = _req()
    ws = workspace.ensure_repo(req, workspace.spec_md(req))
    (ws / "src" / "feature.py").write_text("done = True\n")
    graded = _commit_all(ws, "REQ-7001: GREEN")
    # branch moved past the graded SHA → refuse
    (ws / "src" / "later.py").write_text("late = True\n")
    _commit_all(ws, "post-grade drift")
    err = workspace.merge_graded(ws, req.ref, graded, "op")
    assert err and "graded SHA" in err
    # rewind to the graded SHA → merge succeeds, main contains it
    workspace.reset_branch(ws, req.ref, graded)
    assert workspace.merge_graded(ws, req.ref, graded, "op") is None
    on_main = _git(ws, "merge-base", "--is-ancestor", graded, "main")
    assert on_main.returncode == 0
    assert _git(ws, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip() == "main"


def test_repo_url_uses_the_remote_base(monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    assert workspace.repo_url("REQ-7001") == "git://api:9418/req-7001"
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "")
    assert workspace.repo_url("REQ-7001") == ""
