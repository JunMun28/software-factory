"""ADR 0013 architecture-hardening tests.

Each test pins one fix from the stability/scalability review: a request can
never be silently stranded (Retry re-drives, restarts escalate, crashed stages
escalate), a cancel always wins, a failed merge is never reported as done,
and the poll path is O(new) instead of O(history).
"""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from helpers import approved_request, submitted_request

from app import agent_runner
from app.agent_exec import AgentResult
from app.agent_runner import AgentRunner, workspace_for
from app.db import SessionLocal
from app.main import create_app
from app.models import Request


class RecordingRunner(AgentRunner):
    """Counts start() calls instead of spawning threads — proves dispatch wiring."""

    def __init__(self):
        super().__init__(executor=lambda *a, **k: AgentResult(ok=True, text=""))
        self.started: list[int] = []

    def start(self, request_id: int) -> None:
        self.started.append(request_id)


@pytest.fixture()
def agent_client(monkeypatch):
    """A client in agent mode with a recording (non-executing) runner."""
    monkeypatch.setenv("FACTORY_RUNNER", "agent")
    runner = RecordingRunner()
    app = create_app(auto_tick=0, runner=runner)
    with TestClient(app) as c:
        yield c, runner


def _spec_gated_request(client, title="Hardening probe"):
    return submitted_request(client, title=title, description="x")


# ---------- Retry re-drives the real pipeline ----------

def test_retry_restarts_agent_pipeline(agent_client):
    client, runner = agent_client
    r = _spec_gated_request(client, "Retry re-drive")
    client.post(f"/api/requests/{r['id']}/approve", json={"operator_id": 1})
    assert runner.started == [r["id"]]  # approve dispatched the pipeline

    # escalate it mid-build (what a gate failure does), then Retry
    with SessionLocal() as db:
        req = db.get(Request, r["id"])
        req.stage, req.needs_human, req.needs_human_reason = "build", True, "GREEN gate: boom"
        db.commit()
    out = client.post(f"/api/requests/{r['id']}/retry", json={"operator_id": 1}).json()
    assert out["needs_human"] is False and out["status"] == "approved"
    assert runner.started == [r["id"], r["id"]]  # retry re-drove it — the dead-end is gone


def test_approve_replay_never_double_starts(agent_client):
    client, runner = agent_client
    r = _spec_gated_request(client, "Replay single-start")
    client.post(f"/api/requests/{r['id']}/approve", json={"operator_id": 1})
    client.post(f"/api/requests/{r['id']}/approve", json={"operator_id": 1})  # replay
    assert runner.started == [r["id"]]  # exactly one pipeline


# ---------- restart orphans are escalated, not invisible ----------

def test_startup_rescan_escalates_orphans(monkeypatch):
    monkeypatch.setenv("FACTORY_RUNNER", "agent")
    # strand a request the way a container restart does: approved, mid-stage, unflagged
    pre = create_app(auto_tick=0, runner=RecordingRunner())
    with TestClient(pre) as c:
        r = _spec_gated_request(c, "Orphaned by restart")
        c.post(f"/api/requests/{r['id']}/approve", json={"operator_id": 1})
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
    return AgentResult(ok=True, text="")


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
    return AgentResult(ok=True, text="done")


@pytest.fixture()
def ws_root(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_runner, "WORKSPACES", tmp_path / "workspaces")
    return tmp_path


def _approved(client, title):
    return approved_request(client, title=title, description="x")


def test_crashed_stage_escalates(client, ws_root):
    d = _approved(client, "Crash containment")
    AgentRunner(executor=crashing_executor).run_pipeline(d["id"])
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is True
    assert "crashed" in out["needs_human_reason"]


def test_empty_review_escalates_not_crashes(client, ws_root):
    d = _approved(client, "Empty review handling")
    AgentRunner(executor=empty_review_executor).run_pipeline(d["id"])
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
    assert client.post(f"/api/requests/{d['id']}/approve", json={"operator_id": 1}).status_code == 409
    assert d["id"] not in [x["id"] for x in client.get("/api/inbox").json()]


def test_escalation_dropped_on_cancelled(client, ws_root):
    d = _approved(client, "Late escalation")
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        req.status = "cancelled"
        db.commit()
        AgentRunner(executor=crashing_executor)._escalate(db, req, "stage failed after cancel")
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
        AgentRunner(executor=crashing_executor).approve_merge(db, req, "Kim P.")
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
    return AgentResult(ok=True, text="done")


def test_isolation_gate_catches_config_cheat(client, ws_root):
    d = _approved(client, "Config cheat detection")
    AgentRunner(executor=config_cheating_executor).run_pipeline(d["id"])
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is True
    assert "Test-isolation gate" in out["needs_human_reason"]
    ws = workspace_for(Request(ref=out["ref"]))
    assert "collect_ignore" not in (ws / "conftest.py").read_text()  # reverted


# ---------- migrate() never strands old rows on NULL ----------

def test_migrate_defaults_new_not_null_columns(client):
    """ADR 0013: adding a NOT NULL column must never 500 an existing DB —
    pre-existing rows take the model's default, not NULL."""
    from sqlalchemy import text

    from app.db import engine, migrate

    with engine.connect() as conn:  # simulate a DB from before the column existed
        conn.execute(text("ALTER TABLE requests DROP COLUMN repo_ready"))
        conn.commit()
    assert "requests.repo_ready" in migrate()
    resp = client.get("/api/requests")
    assert resp.status_code == 200
    assert all(r["repo_ready"] is False for r in resp.json())


# ---------- a double submit drafts exactly one spec ----------

def test_submit_replay_never_drafts_twice(client):
    r = submitted_request(client, title="Submit replay", description="x")
    before = client.get(f"/api/requests/{r['id']}").json()["spec_lines"]
    d2 = client.post(f"/api/requests/{r['id']}/submit", json={}).json()
    assert d2["status"] == "pending_approval"
    assert client.get(f"/api/requests/{r['id']}").json()["spec_lines"] == before
    evs = client.get("/api/events", params={"request_id": r["id"]}).json()
    assert sum(e["title"].startswith("Draft spec generated") for e in evs) == 1


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
