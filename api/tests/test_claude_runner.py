"""ClaudeRunner tests — a fake executor stands in for the claude CLI, so these
prove the FACTORY's guarantees (gates, isolation, escalation), not the model."""
from pathlib import Path

import pytest

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
    apps = client.get("/api/apps").json()
    r = client.post("/api/requests", json={
        "type": "enh", "title": title,
        "description": "Add a monthly_export function that returns the export format name.",
        "app_id": apps[0]["id"],
    }).json()
    client.post(f"/api/requests/{r['id']}/submit", json={})
    d = client.post(f"/api/requests/{r['id']}/approve", json={"actor": "Kim P."}).json()
    assert d["status"] == "approved"
    return d


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
