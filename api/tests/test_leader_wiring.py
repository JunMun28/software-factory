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
