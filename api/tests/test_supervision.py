"""Supervision revamp backend (spec 2026-06-12): step events, run-state,
steer, trace, mission aggregate, gate evidence."""

from helpers import approved_request, submitted_request


def _events(client, rid, kind=None):
    evs = client.get("/api/events", params={"request_id": rid}).json()
    return [e for e in evs if kind is None or e["kind"] == kind]


def test_tick_emits_step_summary(client):
    hero = approved_request(client, title="Step summary probe")
    client.post("/api/simulator/tick")
    steps = _events(client, hero["id"], "step_summary")
    assert steps, "first tick after approval must emit a step_summary"
    p = steps[0]["payload"]
    assert p["step"] == 1 and p["of"] == 4
    assert p["label"] == "reading SPEC.md"
    assert p["why"]
    assert steps[0]["stage"] == "architecture"


def test_stage_advances_after_full_step_plan(client):
    hero = approved_request(client, title="Full plan probe")
    for _ in range(4):
        client.post("/api/simulator/tick")
    d = client.get(f"/api/requests/{hero['id']}").json()
    assert d["stage"] == "build"
    titles = [e["title"] for e in _events(client, hero["id"], "milestone_summary")]
    assert any("Architecture plan drafted" in t for t in titles)
    assert any("ADRs signed" in t for t in titles)


def test_verification_emitted_at_merge_gate(client):
    hero = approved_request(client, title="Verification probe")
    for _ in range(16):
        client.post("/api/simulator/tick")
    d = client.get(f"/api/requests/{hero['id']}").json()
    assert d["stage"] == "review" and d["gate"] == "approve_merge"
    ver = _events(client, hero["id"], "verification")
    assert len(ver) == 1, "exactly one verification report at the gate"
    p = ver[0]["payload"]
    assert p["tests_passed"] == 8 and p["tests_total"] == 8
    assert p["reviewer_verdict"] == "no blocking findings"
    assert p["diff_added"] == 412 and p["files_changed"] == 9
    titles = [e["title"] for e in _events(client, hero["id"], "milestone_summary")]
    assert any(t.startswith("GREEN:") for t in titles)
    assert any("Review report posted" in t for t in titles)


def test_run_state_derivation(client):
    from app.db import SessionLocal
    from app.models import Request
    from app.supervision import run_state

    hero = approved_request(client, title="Run state probe")
    with SessionLocal() as db:
        r = db.get(Request, hero["id"])
        rs = run_state(db, r)
        assert rs == {"step": 0, "of": 4, "label": None, "health": "no_signal",
                      "seconds_since_event": rs["seconds_since_event"]}

    client.post("/api/simulator/tick")
    with SessionLocal() as db:
        r = db.get(Request, hero["id"])
        rs = run_state(db, r)
        assert rs["step"] == 1 and rs["of"] == 4
        assert rs["label"] == "reading SPEC.md"
        assert rs["health"] == "healthy"  # event written milliseconds ago


def test_run_state_ignores_pre_retry_step_events(client):
    """Retry resets sim_step/stage_entered_at with the stage unchanged — step
    events from the failed attempt must not leak into the fresh run's state."""
    from app.db import SessionLocal
    from app.models import Request, utcnow
    from app.supervision import run_state

    hero = approved_request(client, title="Retry stale probe")
    client.post("/api/simulator/tick")  # one step event exists
    with SessionLocal() as db:
        r = db.get(Request, hero["id"])
        assert run_state(db, r)["step"] == 1  # sanity: the event counts now
        r.stage_entered_at = utcnow()  # what Retry / gate-raise do
        db.commit()
        rs = run_state(db, r)
        assert rs["step"] == 0
        assert rs["health"] == "no_signal"


def test_run_state_none_unless_in_flight(client):
    from app.db import SessionLocal
    from app.models import Request
    from app.supervision import run_state

    gated = submitted_request(client, title="Gated probe")  # at the spec gate
    with SessionLocal() as db:
        r = db.get(Request, gated["id"])
        assert run_state(db, r) is None


def test_evidence_for_spec_gate(client):
    from app.db import SessionLocal
    from app.models import Request
    from app.supervision import evidence

    gated = submitted_request(client, title="Spec evidence probe")
    with SessionLocal() as db:
        r = db.get(Request, gated["id"])
        ev = evidence(db, r)
        assert ev is not None and ev["kind"] == "spec"
        assert ev["total_lines"] >= 1
        assert isinstance(ev["assumptions"], list)


def test_evidence_for_merge_gate(client):
    from app.db import SessionLocal
    from app.models import Request
    from app.supervision import evidence

    hero = approved_request(client, title="Merge evidence probe")
    for _ in range(16):
        client.post("/api/simulator/tick")
    with SessionLocal() as db:
        r = db.get(Request, hero["id"])
        assert r.gate == "approve_merge"
        ev = evidence(db, r)
        assert ev["kind"] == "merge"
        assert ev["tests_passed"] == 8 and ev["tests_total"] == 8
        assert ev["reviewer_verdict"] == "no blocking findings"
