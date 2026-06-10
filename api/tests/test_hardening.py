"""Production-hardening tests: validation, limits, edge transitions, ops endpoints.

Each test creates its own resources so it is independent of test_api's mutations
(the suite shares one app/db per session).
"""


def _new_request(client, **over):
    apps = client.get("/api/apps").json()
    body = {
        "type": "enh", "title": over.pop("title", "Hardening fixture"),
        "description": over.pop("description", "A fixture request for hardening tests."),
        "app_id": over.pop("app_id", apps[0]["id"]),
        **over,
    }
    r = client.post("/api/requests", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _submitted(client, **over):
    r = _new_request(client, **over)
    d = client.post(f"/api/requests/{r['id']}/submit", json={}).json()
    assert d["status"] == "pending_approval"
    return d


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_bad_type_rejected(client):
    resp = client.post("/api/requests", json={"type": "exploit", "title": "x"})
    assert resp.status_code == 422


def test_oversize_title_rejected(client):
    resp = client.post("/api/requests", json={"type": "bug", "title": "x" * 201})
    assert resp.status_code == 422


def test_oversize_description_rejected(client):
    resp = client.post("/api/requests", json={"type": "bug", "description": "x" * 5001})
    assert resp.status_code == 422


def test_bad_urgency_rejected(client):
    resp = client.post("/api/requests", json={"type": "bug", "urgency": "apocalyptic"})
    assert resp.status_code == 422


def test_oversize_interview_answer_rejected(client):
    r = _new_request(client)
    resp = client.post(f"/api/requests/{r['id']}/interview", json={"answer": "x" * 2001})
    assert resp.status_code == 422


def test_empty_comment_rejected(client):
    r = _new_request(client)
    resp = client.post(f"/api/requests/{r['id']}/comments", json={"body": ""})
    assert resp.status_code == 422


def test_interview_hard_cap(client):
    """US10: the interview stops after 3 turns — a 4th answer must not add a turn."""
    r = _new_request(client)
    for ans in ["one", "two", "three"]:
        client.post(f"/api/requests/{r['id']}/interview", json={"answer": ans})
    st = client.post(f"/api/requests/{r['id']}/interview", json={"answer": "four"}).json()
    assert st["done"] is True
    assert len(st["turns"]) == 3


def test_submit_without_interview_still_grounds_spec(client):
    """The interview is enrichment, not a blocker (PRD hardening #4)."""
    d = _submitted(client, title="No-interview request", description="Just the description.")
    detail = client.get(f"/api/requests/{d['id']}").json()
    assert detail["spec_lines"], "spec must generate from the description alone"
    assert any(line["assume"] for line in detail["spec_lines"])


def test_edit_locked_after_submission(client):
    d = _submitted(client)
    resp = client.patch(f"/api/requests/{d['id']}", json={"type": "enh", "title": "rewrite", "description": "x"})
    assert resp.status_code == 409


def test_respond_requires_sent_back(client):
    d = _submitted(client)
    resp = client.post(f"/api/requests/{d['id']}/respond", json={"note": "hello?"})
    assert resp.status_code == 409


def test_send_back_requires_pending(client):
    r = _new_request(client)  # still draft
    resp = client.post(f"/api/requests/{r['id']}/send-back", json={"note": "too early"})
    assert resp.status_code == 409


def test_cancel_clears_gate_and_leaves_inbox(client):
    d = _submitted(client)
    assert any(i["id"] == d["id"] for i in client.get("/api/inbox").json())
    c = client.post(f"/api/requests/{d['id']}/cancel", json={"actor": "Kim P."}).json()
    assert c["status"] == "cancelled" and c["gate"] is None and c["needs_human"] is False
    assert not any(i["id"] == d["id"] for i in client.get("/api/inbox").json())


def test_tick_ignores_cancelled_items(client):
    d = _submitted(client)
    client.post(f"/api/requests/{d['id']}/approve", json={"actor": "Kim P."})
    client.post(f"/api/requests/{d['id']}/cancel", json={"actor": "Kim P."})
    before = len(client.get("/api/events", params={"request_id": d["id"]}).json())
    client.post("/api/simulator/tick")
    after = len(client.get("/api/events", params={"request_id": d["id"]}).json())
    assert after == before, "cancelled Work items must not advance"


def test_stage_clock_advances_with_stages(client):
    d = _submitted(client)
    a = client.post(f"/api/requests/{d['id']}/approve", json={"actor": "Kim P."}).json()
    clock_arch = a["stage_entered_at"]
    client.post("/api/simulator/tick")  # arch step 1
    client.post("/api/simulator/tick")  # arch step 2 → advance to build
    b = client.get(f"/api/requests/{d['id']}").json()
    assert b["stage"] == "build" and b["stage_entered_at"] > clock_arch


def test_unknown_subject_404(client):
    assert client.get("/api/events", params={"subject": "nope"}).status_code == 404


def test_events_limit_respected(client):
    evs = client.get("/api/events", params={"limit": 5}).json()
    assert len(evs) <= 5


def test_unknown_request_404(client):
    assert client.get("/api/requests/999999").status_code == 404
    assert client.post("/api/requests/999999/approve", json={}).status_code == 404
