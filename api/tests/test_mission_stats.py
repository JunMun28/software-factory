"""Factory gauges (console gap #2): mission stats + the tick heartbeat.

Stats are derived per poll from the audit trail and event log — never stored —
so these tests assert honest behavior at the edges (no history → None) and
that real decisions move the medians.
"""
from helpers import submitted_request

from app import heartbeat


def test_stats_ride_the_mission_poll(client):
    m = client.get("/api/mission").json()
    assert "stats" in m
    stats = m["stats"]
    assert set(stats) == {"cycle_median_h", "gate_wait_median_h", "shipped_7d", "oldest_gate_h"}
    # the seeded world has live gates → an oldest-gate age must exist
    assert stats["oldest_gate_h"] is not None and stats["oldest_gate_h"] >= 0


def test_gate_wait_median_reflects_a_decision(client):
    r = submitted_request(client, title="Stats fixture: decide me")
    d = client.post(f"/api/requests/{r['id']}/approve", json={"operator_id": 1})
    assert d.status_code == 200
    stats = client.get("/api/mission").json()["stats"]
    # the fixture's raise→approve happened within this test run: a sub-hour wait
    assert stats["gate_wait_median_h"] is not None
    assert stats["gate_wait_median_h"] < 1.0


def test_health_reports_tick_age_and_deploy_switch(client):
    heartbeat.reset()
    h = client.get("/api/health").json()
    assert h["tick_age_s"] is None  # no completed pass yet — say so, don't fake 0
    assert h["deploy_enabled"] in (True, False)

    heartbeat.beat()
    h = client.get("/api/health").json()
    assert h["tick_age_s"] is not None and h["tick_age_s"] >= 0
