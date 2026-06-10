"""ADR 0013 architecture-hardening tests.

Each test pins one fix from the stability/scalability review: a request can
never be silently stranded (Retry re-drives, restarts escalate, crashed stages
escalate), a cancel always wins, a failed merge is never reported as done,
and the poll path is O(new) instead of O(history).
"""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import claude_runner
from app.claude_exec import ClaudeResult
from app.claude_runner import ClaudeRunner, workspace_for
from app.db import SessionLocal
from app.main import create_app
from app.models import Request


class RecordingRunner(ClaudeRunner):
    """Counts start() calls instead of spawning threads — proves dispatch wiring."""

    def __init__(self):
        super().__init__(executor=lambda *a, **k: ClaudeResult(ok=True, text=""))
        self.started: list[int] = []

    def start(self, request_id: int) -> None:
        self.started.append(request_id)


@pytest.fixture()
def claude_client(monkeypatch):
    """A client in claude mode with a recording (non-executing) runner."""
    monkeypatch.setenv("FACTORY_RUNNER", "claude")
    runner = RecordingRunner()
    app = create_app(auto_tick=0, runner=runner)
    with TestClient(app) as c:
        yield c, runner


def _spec_gated_request(client, title="Hardening probe"):
    apps = client.get("/api/apps").json()
    r = client.post("/api/requests", json={
        "type": "enh", "title": title, "description": "x", "app_id": apps[0]["id"],
    }).json()
    client.post(f"/api/requests/{r['id']}/submit", json={})
    return r


# ---------- Retry re-drives the real pipeline ----------

def test_retry_restarts_claude_pipeline(claude_client):
    client, runner = claude_client
    r = _spec_gated_request(client, "Retry re-drive")
    client.post(f"/api/requests/{r['id']}/approve", json={"actor": "Kim P."})
    assert runner.started == [r["id"]]  # approve dispatched the pipeline

    # escalate it mid-build (what a gate failure does), then Retry
    with SessionLocal() as db:
        req = db.get(Request, r["id"])
        req.stage, req.needs_human, req.needs_human_reason = "build", True, "GREEN gate: boom"
        db.commit()
    out = client.post(f"/api/requests/{r['id']}/retry", json={"actor": "Kim P."}).json()
    assert out["needs_human"] is False and out["status"] == "approved"
    assert runner.started == [r["id"], r["id"]]  # retry re-drove it — the dead-end is gone


def test_approve_replay_never_double_starts(claude_client):
    client, runner = claude_client
    r = _spec_gated_request(client, "Replay single-start")
    client.post(f"/api/requests/{r['id']}/approve", json={"actor": "Kim P."})
    client.post(f"/api/requests/{r['id']}/approve", json={"actor": "Kim P."})  # replay
    assert runner.started == [r["id"]]  # exactly one pipeline


# ---------- restart orphans are escalated, not invisible ----------

def test_startup_rescan_escalates_orphans(monkeypatch):
    monkeypatch.setenv("FACTORY_RUNNER", "claude")
    # strand a request the way a container restart does: approved, mid-stage, unflagged
    pre = create_app(auto_tick=0, runner=RecordingRunner())
    with TestClient(pre) as c:
        r = _spec_gated_request(c, "Orphaned by restart")
        c.post(f"/api/requests/{r['id']}/approve", json={"actor": "Kim P."})
    # "restart": a fresh app boots over the same DB
    post = create_app(auto_tick=0, runner=RecordingRunner())
    with TestClient(post) as c:
        out = c.get(f"/api/requests/{r['id']}").json()
        assert out["needs_human"] is True
        assert "restart" in out["needs_human_reason"].lower()
        inbox_ids = [x["id"] for x in c.get("/api/inbox").json()]
        assert r["id"] in inbox_ids  # visible again — Retry can re-drive it


# ---------- crashed stages escalate instead of dying silently ----------

def crashing_executor(prompt, **kw):
    if "architect" in prompt:
        raise RuntimeError("the CLI ate itself")
    return ClaudeResult(ok=True, text="")


def empty_review_executor(prompt, **kw):
    ws = Path(kw["cwd"])
    if "architect" in prompt:
        (ws / "PLAN.md").write_text("# PLAN\n")
    elif "test-author" in prompt:
        (ws / "tests" / "test_feature.py").write_text(
            "import expenses\n\ndef test_new():\n    assert hasattr(expenses, 'nope'), 'missing'\n")
    elif "implementer" in prompt:
        with (ws / "src" / "expenses.py").open("a") as f:
            f.write("\n\nnope = True\n")
    elif "reviewer" in prompt:
        (ws / "REVIEW.md").write_text("")  # used to IndexError and kill the thread
    return ClaudeResult(ok=True, text="done")


@pytest.fixture()
def ws_root(tmp_path, monkeypatch):
    monkeypatch.setattr(claude_runner, "WORKSPACES", tmp_path / "workspaces")
    return tmp_path


def _approved(client, title):
    r = _spec_gated_request(client, title)
    d = client.post(f"/api/requests/{r['id']}/approve", json={"actor": "Kim P."}).json()
    assert d["status"] == "approved"
    return d


def test_crashed_stage_escalates(client, ws_root):
    d = _approved(client, "Crash containment")
    ClaudeRunner(executor=crashing_executor).run_pipeline(d["id"])
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is True
    assert "crashed" in out["needs_human_reason"]


def test_empty_review_escalates_not_crashes(client, ws_root):
    d = _approved(client, "Empty review handling")
    ClaudeRunner(executor=empty_review_executor).run_pipeline(d["id"])
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is True
    assert "REVIEW.md" in out["needs_human_reason"]
    assert out["gate"] is None  # no merge gate over a failed review


# ---------- a cancel always wins ----------

def test_cancelled_request_cannot_reach_merge(client, ws_root):
    d = _approved(client, "Cancel wins")
    # the resurrection shape: cancelled while the gate was (or was being) raised
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        req.status, req.gate = "cancelled", "approve_merge"
        db.commit()
    assert client.post(f"/api/requests/{d['id']}/approve", json={}).status_code == 409
    assert d["id"] not in [x["id"] for x in client.get("/api/inbox").json()]


def test_escalation_dropped_on_cancelled(client, ws_root):
    d = _approved(client, "Late escalation")
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        req.status = "cancelled"
        db.commit()
        ClaudeRunner(executor=crashing_executor)._escalate(db, req, "stage failed after cancel")
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is False  # the late escalation was dropped


# ---------- honest merge ----------

def test_merge_failure_escalates_instead_of_done(client, ws_root):
    d = _approved(client, "Honest deploy")
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        req.stage, req.gate = "review", "approve_merge"
        db.commit()
        # no workspace exists (rebuilt container / lost volume)
        ClaudeRunner(executor=crashing_executor).approve_merge(db, req, "Kim P.")
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["status"] != "done"
    assert out["needs_human"] is True
    assert "Merge failed" in out["needs_human_reason"]


# ---------- isolation gate covers pytest config ----------

def config_cheating_executor(prompt, **kw):
    ws = Path(kw["cwd"])
    if "architect" in prompt:
        (ws / "PLAN.md").write_text("# PLAN\n")
    elif "test-author" in prompt:
        (ws / "tests" / "test_feature.py").write_text(
            "import expenses\n\ndef test_feature():\n    assert hasattr(expenses, 'nope'), 'missing'\n")
    elif "implementer" in prompt:
        # reward hacking one level up: deselect the RED test via pytest config
        (ws / "conftest.py").write_text("collect_ignore = ['tests/test_feature.py']\n")
    return ClaudeResult(ok=True, text="done")


def test_isolation_gate_catches_config_cheat(client, ws_root):
    d = _approved(client, "Config cheat detection")
    ClaudeRunner(executor=config_cheating_executor).run_pipeline(d["id"])
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is True
    assert "Test-isolation gate" in out["needs_human_reason"]
    ws = workspace_for(Request(ref=out["ref"]))
    assert "collect_ignore" not in (ws / "conftest.py").read_text()  # reverted


# ---------- poll path is O(new) ----------

def test_events_cursor_is_the_tail(client):
    cursor = client.get("/api/events/cursor").json()["cursor"]
    evs = client.get("/api/events", params={"limit": 500}).json()
    assert cursor == max(e["id"] for e in evs)
    # nothing newer than the cursor — a fresh client replays zero history
    assert client.get("/api/events", params={"after": cursor}).json() == []


def test_health_touches_the_db(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok" and body["db"] == "ok"


def test_patch_is_a_real_patch(client):
    apps = client.get("/api/apps").json()
    r = client.post("/api/requests", json={
        "type": "enh", "title": "Patch semantics", "description": "keep me",
        "app_id": apps[0]["id"], "urgency": "high",
    }).json()
    out = client.patch(f"/api/requests/{r['id']}", json={"urgency": "low"}).json()
    assert out["urgency"] == "low"
    assert out["description"] == "keep me"  # unsent fields stay untouched
    assert out["type"] == "enh"
