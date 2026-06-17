"""ClaudeRunner tests — a fake executor stands in for the claude CLI, so these
prove the FACTORY's guarantees (gates, isolation, escalation), not the model."""
import subprocess
from pathlib import Path

import pytest
from helpers import approved_request

from app import claude_runner
from app.claude_exec import ClaudeResult, extract_json
from app.claude_runner import ClaudeRunner, workspace_for
from app.db import SessionLocal
from app.models import Request


@pytest.fixture()
def ws_root(tmp_path, monkeypatch):
    monkeypatch.setattr(claude_runner, "WORKSPACES", tmp_path / "workspaces")
    return tmp_path


def _approved_request(client, title):
    return approved_request(
        client, title=title,
        description="Add a monthly_export function that returns the export format name.",
    )


# collects cleanly, fails as an assertion (the RED gate rejects import-time errors)
GOOD_TEST = (
    "import expenses\n\n"
    "def test_monthly_export_is_csv():\n"
    "    assert hasattr(expenses, 'monthly_export'), 'monthly_export not implemented yet'\n"
    "    assert expenses.monthly_export() == 'csv'\n"
)
GOOD_IMPL = "\n\ndef monthly_export() -> str:\n    return 'csv'\n"


def honest_executor(prompt: str, *, cwd: str | None = None, **kw) -> ClaudeResult:
    ws = Path(cwd)
    if "architect" in prompt:
        (ws / "PLAN.md").write_text("# PLAN\nAdd monthly_export() to src/expenses.py returning 'csv'.\n")
    elif "test-author" in prompt:
        (ws / "tests" / "test_feature.py").write_text(GOOD_TEST)
    elif "implementer" in prompt:
        with (ws / "src" / "expenses.py").open("a") as f:
            f.write(GOOD_IMPL)
    elif "reviewer" in prompt:
        (ws / "REVIEW.md").write_text("APPROVE\nImplements the spec; tests are meaningful.\n")
    return ClaudeResult(ok=True, text="done")


def cheating_executor(prompt: str, *, cwd: str | None = None, **kw) -> ClaudeResult:
    ws = Path(cwd)
    if "architect" in prompt:
        (ws / "PLAN.md").write_text("# PLAN\n")
    elif "test-author" in prompt:
        (ws / "tests" / "test_feature.py").write_text(GOOD_TEST)
    elif "implementer" in prompt:
        # reward hacking: weaken the test instead of implementing
        (ws / "tests" / "test_feature.py").write_text("def test_monthly_export_is_csv():\n    assert True\n")
    return ClaudeResult(ok=True, text="done")


def lazy_test_author(prompt: str, *, cwd: str | None = None, **kw) -> ClaudeResult:
    ws = Path(cwd)
    if "architect" in prompt:
        (ws / "PLAN.md").write_text("# PLAN\n")
    elif "test-author" in prompt:
        (ws / "tests" / "test_feature.py").write_text("def test_nothing():\n    assert True\n")
    return ClaudeResult(ok=True, text="done")


def test_full_pipeline_to_merge(client, ws_root):
    d = _approved_request(client, "Monthly export format")
    ClaudeRunner(executor=honest_executor).run_pipeline(d["id"])

    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["stage"] == "review" and out["gate"] == "approve_merge" and not out["needs_human"]

    titles = [e["title"] for e in client.get("/api/events", params={"request_id": d["id"]}).json()]
    assert any(t.startswith("Architecture plan committed") for t in titles)
    assert any(t.startswith("RED: failing tests authored") for t in titles)
    assert any("touched no test files" in t for t in titles)
    assert any("merge gate" in t for t in titles)

    ws = workspace_for(Request(ref=out["ref"]))
    assert (ws / "PLAN.md").exists() and (ws / "REVIEW.md").exists()

    # the human merge gate: approving merges the work branch into main
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        ClaudeRunner(executor=honest_executor).approve_merge(db, req, "Kim P.")
    final = client.get(f"/api/requests/{d['id']}").json()
    assert final["status"] == "done" and final["stage"] == "done"
    log = claude_runner._git(ws, "log", "--oneline", "main").stdout
    assert "merge (approved by Kim P.)" in log


def test_isolation_gate_catches_cheating_implementer(client, ws_root):
    d = _approved_request(client, "Cheater detection")
    ClaudeRunner(executor=cheating_executor).run_pipeline(d["id"])

    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is True
    assert "Test-isolation gate" in out["needs_human_reason"]
    # the weakened test was rolled back to the frozen RED version
    ws = workspace_for(Request(ref=out["ref"]))
    assert "monthly_export" in (ws / "tests" / "test_feature.py").read_text()


def test_red_gate_rejects_non_failing_tests(client, ws_root):
    d = _approved_request(client, "Lazy test author")
    ClaudeRunner(executor=lazy_test_author).run_pipeline(d["id"])
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is True
    assert "RED gate" in out["needs_human_reason"]


def test_extract_json_handles_fences_and_prose():
    assert extract_json('{"a": 1}') == {"a": 1}
    assert extract_json('Sure! Here you go:\n```json\n{"q": "x?"}\n```\nanything else?') == {"q": "x?"}
    assert extract_json("no json here") is None


# ---------- the gates must be able to RUN (a pytest-less venv must not pass RED) ----------

def test_pytest_missing_is_not_an_honest_failure(tmp_path, monkeypatch):
    # what a pytest-less interpreter does: rc=1 with "No module named pytest"
    real_run = subprocess.run

    def fake_run(cmd, **kw):
        if "pytest" in cmd:
            return subprocess.CompletedProcess(
                cmd, 1, stdout="", stderr="/venv/bin/python: No module named pytest")
        return real_run(cmd, **kw)

    monkeypatch.setattr(subprocess, "run", fake_run)  # _pytest lives in ws_exec now
    proc = claude_runner._pytest(tmp_path)
    assert proc.returncode == 127  # surfaced as "the gate cannot run", never as a RED pass


def test_red_gate_escalates_when_pytest_cannot_run(client, ws_root, monkeypatch):
    monkeypatch.setattr(claude_runner, "_pytest", lambda ws: subprocess.CompletedProcess(
        [], 127, stdout="", stderr="pytest is not installed in the runner environment"))
    d = _approved_request(client, "Gate cannot run")
    ClaudeRunner(executor=honest_executor).run_pipeline(d["id"])
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is True
    assert "RED gate cannot run" in out["needs_human_reason"]


# ---------- Retry resumes at the stuck stage with a clean workspace ----------

def wrong_implementer(prompt: str, *, cwd: str | None = None, **kw) -> ClaudeResult:
    ws = Path(cwd)
    if "architect" in prompt:
        (ws / "PLAN.md").write_text("# PLAN\n")
    elif "test-author" in prompt:
        (ws / "tests" / "test_feature.py").write_text(GOOD_TEST)
    elif "implementer" in prompt:
        with (ws / "src" / "expenses.py").open("a") as f:
            f.write("\n\ndef monthly_export() -> str:\n    return 'xml'\n")  # wrong: suite stays red
    return ClaudeResult(ok=True, text="done")


def test_retry_resumes_at_build_with_clean_workspace(client, ws_root):
    d = _approved_request(client, "Retry resume")
    ClaudeRunner(executor=wrong_implementer).run_pipeline(d["id"])
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is True and "GREEN gate" in out["needs_human_reason"]
    assert out["stage"] == "build"

    # Retry clears the flag; the re-run resumes at build, not architecture
    client.post(f"/api/requests/{d['id']}/retry", json={"note": "fixed the agent"})
    ClaudeRunner(executor=honest_executor).run_pipeline(d["id"])

    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["gate"] == "approve_merge" and out["needs_human"] is False
    titles = [e["title"] for e in client.get("/api/events", params={"request_id": d["id"]}).json()]
    assert sum(t.startswith("Architecture plan committed") for t in titles) == 1  # not re-run
    # the failed attempt's stray uncommitted edit was discarded before the re-run
    ws = workspace_for(Request(ref=out["ref"]))
    assert "return 'xml'" not in (ws / "src" / "expenses.py").read_text()


def test_review_emits_verification_for_merge_evidence(client, ws_root):
    from app import supervision

    d = _approved_request(client, "Verification evidence")
    ClaudeRunner(executor=honest_executor).run_pipeline(d["id"])

    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["gate"] == "approve_merge" and not out["needs_human"]

    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        ev = supervision.evidence(db, req)

    assert ev is not None and ev["kind"] == "merge"
    assert ev["tests_passed"] == ev["tests_total"] and ev["tests_total"] >= 1
    assert ev["diff_added"] > 0 and ev["files_changed"] >= 1
    assert "APPROVE" in (ev["reviewer_verdict"] or "")


def test_review_escalates_when_verification_cannot_be_built(client, ws_root, monkeypatch):
    monkeypatch.setattr(claude_runner, "build_payload", lambda ws, req: {"tests_total": 0})
    d = _approved_request(client, "Verification cannot build")
    ClaudeRunner(executor=honest_executor).run_pipeline(d["id"])
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is True
    assert "Verification could not be built" in out["needs_human_reason"]
    assert out["gate"] != "approve_merge"


def test_review_escalates_when_diff_is_empty(client, ws_root, monkeypatch):
    # a green suite whose work branch shows no diff is not honest evidence — the
    # merge gate must not be raised on a "+0 -0 · 0 files" report (a silent
    # git-diff failure that returned no shortstat would land here too)
    monkeypatch.setattr(claude_runner, "build_payload",
                        lambda ws, req: {"tests_total": 3, "files_changed": 0})
    d = _approved_request(client, "Verification empty diff")
    ClaudeRunner(executor=honest_executor).run_pipeline(d["id"])
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is True
    assert "Verification could not be built" in out["needs_human_reason"]
    assert out["gate"] != "approve_merge"
