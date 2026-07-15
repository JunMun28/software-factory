from fastapi.testclient import TestClient

from app import main
from app.leader import get_elector


def test_health_reports_leadership(client):
    body = client.get("/api/health").json()
    assert body["leader"] is True  # sqlite: always leader
    assert isinstance(body["epoch"], int) and body["epoch"] >= 1


def test_tick_pass_skips_standby_then_runs_after_acquire(monkeypatch):
    elector = get_elector()
    acquire_results = iter((False, True))
    tick_calls = []
    monkeypatch.setattr(elector, "verify", lambda: False)
    monkeypatch.setattr(elector, "try_acquire", lambda: next(acquire_results))
    monkeypatch.setattr(main.simulator, "tick", lambda db: tick_calls.append(db))

    main._tick_once(elector)
    assert tick_calls == []

    main._tick_once(elector)
    assert len(tick_calls) == 1


def test_health_reports_standby_when_elector_is_not_leader(monkeypatch):
    elector = get_elector()
    elector.release()
    app = main.create_app(auto_tick=0)

    try:
        with monkeypatch.context() as patch:
            patch.setattr(elector, "try_acquire", lambda: False)
            patch.setattr(elector, "is_leader", lambda: False)
            with TestClient(app) as standby_client:
                body = standby_client.get("/api/health").json()
        assert body["leader"] is False
    finally:
        elector.try_acquire()


# ---------- leader-only guards (Plan B1 task 2) ----------

def test_escalate_orphans_is_leader_only(client, monkeypatch):
    """A standby replica must never escalate — it re-runs startup chores too."""
    from helpers import approved_request

    from app import startup
    from app.db import SessionLocal

    d = approved_request(client, title="Orphan gating")
    monkeypatch.setattr(get_elector(), "is_leader", lambda: False)
    with SessionLocal() as db:
        startup.escalate_orphans(db)
    out = client.get(f"/api/requests/{d['id']}").json()
    assert out["needs_human"] is False  # untouched: we were not the leader


def test_sim_tick_endpoint_is_leader_only(client, monkeypatch):
    elector = get_elector()
    monkeypatch.setattr(elector, "verify", lambda: False)
    monkeypatch.setattr(elector, "try_acquire", lambda: False)
    out = client.post("/api/simulator/tick").json()
    assert out["moved"] == []
    assert "leader" in out["note"]
