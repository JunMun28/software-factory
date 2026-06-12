"""Supervision revamp backend (spec 2026-06-12): step events, run-state,
steer, trace, mission aggregate, gate evidence."""

from helpers import approved_request


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
