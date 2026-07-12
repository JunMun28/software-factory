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


def test_steer_appends_and_is_acked_next_step(client):
    hero = approved_request(client, title="Steer probe")
    client.post("/api/simulator/tick")  # step 1 done, run clearly in flight

    resp = client.post(f"/api/requests/{hero['id']}/steer",
                       json={"note": "Prefer the existing CSV parser", "operator_id": 1})
    assert resp.status_code == 201
    note_id = resp.json()["id"]

    notes = _events(client, hero["id"], "steer_note")
    assert len(notes) == 1 and notes[0]["actor"] == "Kim Park" and notes[0]["bot"] is False

    client.post("/api/simulator/tick")  # the very next step must acknowledge
    steps = _events(client, hero["id"], "step_summary")
    last = steps[-1]["payload"]
    assert note_id in last["acked_steer_ids"]
    assert "honoring note" in last["why"]

    client.post("/api/simulator/tick")  # acked notes are not re-acked
    steps = _events(client, hero["id"], "step_summary")
    assert "acked_steer_ids" not in (steps[-1]["payload"] or {})


def test_steer_409_when_not_in_flight(client):
    gated = submitted_request(client, title="Steer gate probe")  # spec gate
    resp = client.post(f"/api/requests/{gated['id']}/steer", json={"note": "x", "operator_id": 1})
    assert resp.status_code == 409

    hero = approved_request(client, title="Steer merge-gate probe")
    for _ in range(16):
        client.post("/api/simulator/tick")  # park it at the merge gate
    resp = client.post(f"/api/requests/{hero['id']}/steer", json={"note": "x", "operator_id": 1})
    assert resp.status_code == 409, "at a gate = waiting on a human, not steerable"


def test_trace_keyset(client):
    hero = approved_request(client, title="Trace probe")
    client.post("/api/simulator/tick")

    page = client.get(f"/api/requests/{hero['id']}/trace").json()
    assert page["items"] and page["cursor"] > 0
    kinds = {e["kind"] for e in page["items"]}
    assert "step_summary" in kinds and "gate_event" in kinds
    ids = [e["id"] for e in page["items"]]
    assert ids == sorted(ids), "ascending within the page"

    cursor = page["cursor"]
    assert client.get(f"/api/requests/{hero['id']}/trace",
                      params={"after": cursor}).json()["items"] == []
    client.post("/api/simulator/tick")
    newer = client.get(f"/api/requests/{hero['id']}/trace",
                       params={"after": cursor}).json()
    assert newer["items"] and all(e["id"] > cursor for e in newer["items"])

    assert client.get("/api/requests/999999/trace").status_code == 404


def test_detail_carries_run_and_evidence(client):
    hero = approved_request(client, title="Detail blocks probe")
    client.post("/api/simulator/tick")
    d = client.get(f"/api/requests/{hero['id']}").json()
    assert d["run"]["step"] == 1 and d["run"]["label"] == "reading SPEC.md"
    assert d["evidence"] is None  # not at a gate

    gated = submitted_request(client, title="Detail evidence probe")
    d = client.get(f"/api/requests/{gated['id']}").json()
    assert d["run"] is None
    assert d["evidence"]["kind"] == "spec" and d["evidence"]["total_lines"] >= 1


def test_mission_aggregate(client):
    gated = submitted_request(client, title="Mission gate probe")
    running = approved_request(client, title="Mission run probe")
    client.post("/api/simulator/tick")

    m = client.get("/api/mission").json()
    assert set(m) == {"gates", "runs", "stalled", "recent", "cursor"}
    assert m["cursor"] > 0

    gate = next(g for g in m["gates"] if g["request"]["id"] == gated["id"])
    assert gate["request"]["gate"] == "approve_spec"
    assert gate["evidence"]["kind"] == "spec"

    run = next(r for r in m["runs"] if r["request"]["id"] == running["id"])
    assert run["run"]["step"] >= 1 and run["run"]["health"] in ("healthy", "slow")

    assert all(s["needs_human"] for s in m["stalled"])
    assert all(g["request"]["needs_human"] is False for g in m["gates"])
    recent_ids = {r["request"]["id"] for r in m["recent"]}
    assert running["id"] in recent_ids, "Recently is an outcome history, independent of live bands"
    stalled_ids = {s["id"] for s in m["stalled"]}
    assert not (stalled_ids & recent_ids), "stalled and recent are exclusive too"


def test_seeded_run_has_step_trace(client):
    """The seeded steps 1-3 (of=6) are append-only — later ticks add steps
    but never remove them, so this asserts in any test order."""
    sso = next(r for r in client.get("/api/requests").json() if r["ref"] == "REQ-2029")
    steps = _events(client, sso["id"], "step_summary")
    build_steps = [s for s in steps if s["payload"]["of"] == 6 and s["payload"]["step"] <= 3]
    assert len(build_steps) >= 3, "seed must include the in-flight step trace"
    labels = [s["payload"]["label"] for s in build_steps[:3]]
    assert labels[0] == "authoring failing tests"
    assert labels[2] == "implementing the change"


def test_channel_feed_excludes_trace_kinds(client):
    hero = approved_request(client, title="Feed firehose probe")
    client.post("/api/simulator/tick")
    app_key = hero["app_key"]
    feed = client.get(f"/api/subjects/{app_key}/feed").json()
    kinds = {e["kind"] for e in feed["items"]}
    assert "step_summary" not in kinds and "verification" not in kinds and "steer_note" not in kinds
    trace = client.get(f"/api/requests/{hero['id']}/trace").json()
    assert "step_summary" in {e["kind"] for e in trace["items"]}


def test_send_back_clears_escalation(client):
    from app.db import SessionLocal
    from app.models import Request

    gated = submitted_request(client, title="Send-back escalation probe")
    with SessionLocal() as db:  # simulate a prior escalation on a gated item
        r = db.get(Request, gated["id"])
        r.needs_human = True
        r.needs_human_reason = "spec generation flaked"
        db.commit()

    d = client.post(f"/api/requests/{gated['id']}/send-back",
                    json={"note": "Which CSV source?", "operator_id": 1}).json()
    assert d["needs_human"] is False and d["needs_human_reason"] is None


def test_run_state_slow_health(client, monkeypatch):
    from app import settings
    from app.db import SessionLocal
    from app.models import Request
    from app.supervision import run_state

    hero = approved_request(client, title="Slow health probe")
    client.post("/api/simulator/tick")
    monkeypatch.setattr(settings, "RUN_SLOW_AFTER_SECONDS", 0.0)
    with SessionLocal() as db:
        r = db.get(Request, hero["id"])
        assert run_state(db, r)["health"] == "slow"


def test_steer_unconsumed_when_run_reaches_gate(client):
    # 4 arch + 6 build + 3 review steps = 13 ticks to exhaust the review plan;
    # at that point gate is still None so steer is still in_flight → 201.
    # Tick 14 raises the merge gate; the gate raise must NOT ack the note.
    hero = approved_request(client, title="Steer race probe")
    for _ in range(13):
        client.post("/api/simulator/tick")
    resp = client.post(f"/api/requests/{hero['id']}/steer", json={"note": "too late", "operator_id": 1})
    assert resp.status_code == 201
    note_id = resp.json()["id"]

    client.post("/api/simulator/tick")  # raises the merge gate; must NOT ack
    d = client.get(f"/api/requests/{hero['id']}").json()
    assert d["gate"] == "approve_merge"
    acked = {i for e in _events(client, hero["id"], "step_summary")
             for i in (e["payload"] or {}).get("acked_steer_ids", [])}
    assert note_id not in acked, "gate raise must not consume the note"


def test_merge_gate_without_verification_has_no_evidence(client):
    from app.db import SessionLocal
    from app.models import Request

    gated = submitted_request(client, title="No evidence probe")
    with SessionLocal() as db:  # simulate a legacy/pre-revamp DB row at the merge gate
        r = db.get(Request, gated["id"])
        r.gate = "approve_merge"
        db.commit()
    d = client.get(f"/api/requests/{gated['id']}").json()
    assert d["evidence"] is None  # UI renders "no evidence recorded"
