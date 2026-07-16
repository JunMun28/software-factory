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


def _bare_repo(path: Path) -> Path:
    path.mkdir()
    init = _git(path, "init", "--bare", "-q", "-b", "main")
    assert init.returncode == 0, init.stderr
    return path


def _working_repo(path: Path, remote: Path) -> Path:
    path.mkdir()
    assert _git(path, "init", "-q", "-b", "main").returncode == 0
    _git(path, "config", "user.email", "factory@local")
    _git(path, "config", "user.name", "Factory Builder bot")
    (path / "tests").mkdir()
    (path / "tests" / "test_seed.py").write_text("def test_seed():\n    assert True\n")
    _commit_all(path, "baseline")
    _git(path, "remote", "add", "origin", str(remote))
    pushed = _git(path, "push", "-q", "-u", "origin", "main")
    assert pushed.returncode == 0, pushed.stderr
    return path


def _assert_token_not_persisted(ws: Path, token: str) -> None:
    config = _git(ws, "config", "--local", "--list").stdout
    remotes = _git(ws, "remote", "-v").stdout
    assert token not in config
    assert token not in remotes


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


def test_plan_and_numstat_are_read_at_recorded_shas(ws_root):
    req = _req()
    ws = workspace.ensure_repo(req, workspace.spec_md(req))
    base = workspace.head_sha(ws, "main")
    (ws / "PLAN.md").write_text("# Plan\n\n1. First\n2. Second\n")
    (ws / "src" / "feature.py").write_text("one = 1\ntwo = 2\n")
    head = _commit_all(ws, "plan and implementation")

    plan = workspace.plan_at(ws, head, max_lines=2)
    diffstat = workspace.numstat_at(ws, base, head)

    assert plan is not None
    assert plan[0] == "# Plan\n\n"
    assert plan[1].startswith("sha256:") and len(plan[1]) == 19
    assert {row["file"] for row in diffstat} >= {"PLAN.md", "src/feature.py"}
    assert workspace.plan_at(ws, "0" * 40) is None
    assert workspace.numstat_at(ws, "0" * 40, head) is None


def test_merge_base_at_returns_none_when_a_ref_is_unavailable(ws_root):
    req = _req()
    ws = workspace.ensure_repo(req, workspace.spec_md(req))
    head = workspace.head_sha(ws)

    assert workspace.merge_base_at(ws, "main", head) == workspace.head_sha(ws, "main")
    assert workspace.merge_base_at(ws, "missing-ref", head) is None


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


def test_github_https_url_is_token_free(monkeypatch):
    monkeypatch.setattr(settings, "GITHUB_OWNER", "acme", raising=False)
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "super-secret-token", raising=False)

    url = workspace.github_https_url("northwind")

    assert url == "https://github.com/acme/sf-app-northwind.git"
    assert "super-secret-token" not in url


def test_github_git_error_sanitizer_is_reusable(monkeypatch):
    token = "super-secret-token"
    monkeypatch.setattr(settings, "GITHUB_TOKEN", token)
    message = (
        "fatal: unable to access "
        "'https://x-access-token:super-secret-token@github.com/acme/"
        "sf-app-northwind.git/': denied; credential=super-secret-token"
    )

    sanitized = workspace.sanitize_github_git_error(message)

    assert "https://github.com/acme/sf-app-northwind.git/" in sanitized
    assert token not in sanitized
    assert "x-access-token:" not in sanitized
    assert "credential=<redacted>" in sanitized


def test_push_error_never_returns_the_token_or_authenticated_url(
    tmp_path, monkeypatch
):
    token = "super-secret-token"
    monkeypatch.setattr(settings, "GITHUB_TOKEN", token)
    monkeypatch.setattr(settings, "GITHUB_OWNER", "acme")
    ws = tmp_path / "workspace"
    ws.mkdir()
    authed_url = (
        "https://x-access-token:super-secret-token@github.com/"
        "acme/sf-app-northwind.git"
    )

    def fail_push(_ws, *args):
        assert args[0] == "push"
        return subprocess.CompletedProcess(
            args,
            1,
            "",
            f"fatal: unable to access '{authed_url}/': push denied for {token}",
        )

    monkeypatch.setattr(workspace, "_git", fail_push)

    error = workspace.push_branch_to_github(ws, "northwind", "REQ-1")
    assert "https://github.com/acme/sf-app-northwind.git/" in error
    assert token not in error
    assert "x-access-token:" not in error


def test_github_mode_requires_backbone_token_and_owner(monkeypatch):
    enabled = {
        "GIT_REMOTE_BASE": "git://api:9418",
        "GITHUB_TOKEN": "secret",
        "GITHUB_OWNER": "acme",
    }
    for name, value in enabled.items():
        monkeypatch.setattr(settings, name, value, raising=False)
    assert settings.github_enabled() is True

    for missing in enabled:
        for name, value in enabled.items():
            monkeypatch.setattr(settings, name, value, raising=False)
        monkeypatch.setattr(settings, missing, "", raising=False)
        assert settings.github_enabled() is False


def test_push_then_fetch_roundtrips_the_work_branch(tmp_path, monkeypatch):
    remote = _bare_repo(tmp_path / "github.git")
    producer = _working_repo(tmp_path / "producer", remote)
    branch = workspace.work_branch("REQ-1")
    _git(producer, "checkout", "-q", "-b", branch)
    (producer / "tests" / "test_remote.py").write_text(
        "def test_remote():\n    assert True\n"
    )
    sha = _commit_all(producer, "REQ-1: GREEN")
    monkeypatch.setattr(workspace, "_authed_url", lambda slug: str(remote))
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "super-secret-token", raising=False)

    assert workspace.push_branch_to_github(producer, "northwind", "REQ-1") is None

    mirror = tmp_path / "mirror"
    clone = subprocess.run(
        ["git", "clone", "-q", str(remote), str(mirror)],
        capture_output=True,
        text=True,
    )
    assert clone.returncode == 0, clone.stderr
    assert workspace.fetch_ref_from_github(
        mirror, "northwind", "REQ-1", sha
    ) is None
    assert workspace.head_sha(mirror, branch) == sha
    assert workspace.surface_hash_at(mirror, sha) is not None
    _assert_token_not_persisted(producer, "super-secret-token")
    _assert_token_not_persisted(mirror, "super-secret-token")


def test_fetch_ref_handles_the_checked_out_workspace_branch(ws_root, monkeypatch):
    remote = _bare_repo(ws_root / "github.git")
    req = _req()
    ws = workspace.ensure_repo(req, workspace.spec_md(req))
    branch = workspace.work_branch(req.ref)
    assert _git(ws, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip() == branch
    monkeypatch.setattr(workspace, "_authed_url", lambda slug: str(remote))
    assert _git(ws, "push", "-q", str(remote), "main:main").returncode == 0
    assert workspace.push_branch_to_github(ws, "northwind", req.ref) is None
    agent = ws_root / "agent"
    clone = subprocess.run(
        ["git", "clone", "-q", "-b", branch, str(remote), str(agent)],
        capture_output=True,
        text=True,
    )
    assert clone.returncode == 0, clone.stderr
    _git(agent, "config", "user.email", "agent@sf.local")
    _git(agent, "config", "user.name", "sf-agent")
    (agent / "tests" / "test_agent.py").write_text(
        "def test_agent():\n    assert True\n"
    )
    remote_sha = _commit_all(agent, "agent GREEN")
    pushed = _git(agent, "push", "-q", "origin", f"{branch}:{branch}")
    assert pushed.returncode == 0, pushed.stderr

    assert workspace.fetch_ref_from_github(
        ws, "northwind", req.ref, remote_sha
    ) is None
    assert workspace.head_sha(ws, branch) == remote_sha
    assert _git(ws, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip() == "main"


def test_reported_sha_mismatch_does_not_move_the_local_work_branch(
    tmp_path, monkeypatch
):
    remote = _bare_repo(tmp_path / "github.git")
    producer = _working_repo(tmp_path / "producer", remote)
    branch = workspace.work_branch("REQ-1")
    _git(producer, "checkout", "-q", "-b", branch)
    (producer / "feature.txt").write_text("local graded head\n")
    local_sha = _commit_all(producer, "local graded head")
    monkeypatch.setattr(workspace, "_authed_url", lambda slug: str(remote))
    assert workspace.push_branch_to_github(producer, "northwind", "REQ-1") is None
    (producer / "feature.txt").write_text("untrusted reported head\n")
    _commit_all(producer, "remote agent head")
    assert workspace.push_branch_to_github(producer, "northwind", "REQ-1") is None
    _git(producer, "checkout", "-q", "main")
    _git(producer, "branch", "-f", branch, local_sha)

    assert workspace.fetch_ref_from_github(
        producer, "northwind", "REQ-1", "0" * 40
    ) == "fetched head is not the reported SHA 000000000000"
    assert workspace.head_sha(producer, branch) == local_sha


def test_fetch_main_updates_the_local_mirror(tmp_path, monkeypatch):
    remote = _bare_repo(tmp_path / "github.git")
    producer = _working_repo(tmp_path / "producer", remote)
    mirror = tmp_path / "mirror"
    clone = subprocess.run(
        ["git", "clone", "-q", str(remote), str(mirror)],
        capture_output=True,
        text=True,
    )
    assert clone.returncode == 0, clone.stderr
    (producer / "merged.txt").write_text("merged on github\n")
    merged_sha = _commit_all(producer, "merge pull request")
    pushed = _git(producer, "push", "-q", "origin", "main")
    assert pushed.returncode == 0, pushed.stderr
    monkeypatch.setattr(workspace, "_authed_url", lambda slug: str(remote))

    assert workspace.fetch_main_from_github(mirror, "northwind") is None
    assert workspace.head_sha(mirror, "main") == merged_sha
    assert (mirror / "merged.txt").read_text() == "merged on github\n"


def test_fetch_main_checkout_failure_never_resets_the_current_branch(
    tmp_path, monkeypatch
):
    remote = _bare_repo(tmp_path / "github.git")
    producer = _working_repo(tmp_path / "producer", remote)
    branch = workspace.work_branch("REQ-1")
    _git(producer, "checkout", "-q", "-b", branch)
    (producer / "feature.txt").write_text("must survive\n")
    work_sha = _commit_all(producer, "work must survive")
    monkeypatch.setattr(workspace, "_authed_url", lambda slug: str(remote))
    real_git = workspace._git
    calls = []

    def fail_main_checkout(ws, *args):
        calls.append(args)
        if args == ("checkout", "-q", "main"):
            return subprocess.CompletedProcess(args, 1, "", "checkout failed")
        return real_git(ws, *args)

    monkeypatch.setattr(workspace, "_git", fail_main_checkout)

    err = workspace.fetch_main_from_github(producer, "northwind")
    assert not any(args and args[0] == "reset" for args in calls)
    assert workspace.head_sha(producer, branch) == work_sha
    assert err == "could not check out local main"


def test_force_push_uses_a_lease_and_rewinds_the_work_branch(tmp_path, monkeypatch):
    remote = _bare_repo(tmp_path / "github.git")
    producer = _working_repo(tmp_path / "producer", remote)
    branch = workspace.work_branch("REQ-1")
    _git(producer, "checkout", "-q", "-b", branch)
    (producer / "feature.txt").write_text("graded\n")
    graded_sha = _commit_all(producer, "graded")
    monkeypatch.setattr(workspace, "_authed_url", lambda slug: str(remote))
    assert workspace.push_branch_to_github(producer, "northwind", "REQ-1") is None
    (producer / "feature.txt").write_text("post-grade drift\n")
    drift_sha = _commit_all(producer, "drift")
    assert workspace.push_branch_to_github(producer, "northwind", "REQ-1") is None
    assert _git(producer, "reset", "-q", "--hard", graded_sha).returncode == 0
    real_git = workspace._git
    calls = []

    def git_spy(ws, *args):
        calls.append(args)
        return real_git(ws, *args)

    monkeypatch.setattr(workspace, "_git", git_spy)

    assert workspace.push_branch_to_github(
        producer, "northwind", "REQ-1", force=True
    ) is None
    lease = f"--force-with-lease=refs/heads/{branch}:{drift_sha}"
    assert any(args[:3] == ("push", lease, str(remote)) for args in calls)
    remote_sha = _git(producer, "ls-remote", str(remote), f"refs/heads/{branch}")
    assert remote_sha.stdout.split()[0] == graded_sha


def test_force_push_reports_remote_head_lookup_failure(tmp_path, monkeypatch):
    remote = _bare_repo(tmp_path / "github.git")
    producer = _working_repo(tmp_path / "producer", remote)
    branch = workspace.work_branch("REQ-1")
    _git(producer, "checkout", "-q", "-b", branch)
    token = "super-secret-token"
    authed_url = (
        "https://x-access-token:super-secret-token@github.com/"
        "acme/sf-app-northwind.git"
    )
    monkeypatch.setattr(settings, "GITHUB_TOKEN", token)
    monkeypatch.setattr(settings, "GITHUB_OWNER", "acme")
    real_git = workspace._git

    def fail_ls_remote(ws, *args):
        if args[0] == "ls-remote":
            return subprocess.CompletedProcess(
                args,
                1,
                "",
                f"fatal: unable to access '{authed_url}/': lookup denied for {token}",
            )
        return real_git(ws, *args)

    monkeypatch.setattr(workspace, "_git", fail_ls_remote)

    error = workspace.push_branch_to_github(
        producer, "northwind", "REQ-1", force=True
    )
    assert "https://github.com/acme/sf-app-northwind.git/" in error
    assert token not in error
    assert "x-access-token:" not in error


def test_github_fetch_errors_are_specific(tmp_path, monkeypatch):
    remote = _bare_repo(tmp_path / "github.git")
    mirror = _working_repo(tmp_path / "mirror", remote)
    monkeypatch.setattr(workspace, "_authed_url", lambda slug: str(remote))

    assert workspace.fetch_ref_from_github(
        mirror, "northwind", "REQ-404"
    ) == "fetch work/req-404 from github failed"

    branch = workspace.work_branch("REQ-1")
    _git(mirror, "checkout", "-q", "-b", branch)
    sha = _commit_all(mirror, "work branch")
    assert workspace.push_branch_to_github(mirror, "northwind", "REQ-1") is None
    _git(mirror, "checkout", "-q", "main")
    assert workspace.fetch_ref_from_github(
        mirror, "northwind", "REQ-1", "0" * 40
    ) == "fetched head is not the reported SHA 000000000000"
    assert workspace.fetch_ref_from_github(mirror, "northwind", "REQ-1", sha) is None
