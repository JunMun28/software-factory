"""Behavioral tests through the public API (PRD: test external behavior, mock at seams).

The LLM seam is the ScriptedBrain — deterministic, offline. The GitHub seam does not
exist in the prototype (the simulator stands in for CI), so no network is mocked.
"""


def test_seeded_world(client):
    apps = client.get("/api/apps").json()
    assert {a["name"] for a in apps} >= {"Northwind Expenses", "Vendor Portal", "FieldOps"}
    reqs = client.get("/api/requests").json()
    refs = {r["ref"] for r in reqs}
    assert "REQ-2041" in refs
    hero = next(r for r in reqs if r["ref"] == "REQ-2041")
    assert hero["gate"] == "approve_spec" and hero["stage"] == "spec"


def test_submitter_flow_end_to_end(client):
    apps = client.get("/api/apps").json()
    nw = next(a for a in apps if a["key"] == "northwind")

    # S1 — persist-first draft
    r = client.post("/api/requests", json={
        "type": "enh", "title": "Bulk-archive old reports",
        "description": "Archiving reports one at a time takes forever.",
        "app_id": nw["id"],
    }).json()
    assert r["status"] == "draft" and r["ref"].startswith("REQ-")

    # S2 — scripted interview: 3 questions then done
    st = client.get(f"/api/requests/{r['id']}/interview").json()
    assert st["done"] is False and st["question"]
    st = client.post(f"/api/requests/{r['id']}/interview", json={"answer": "It takes about an hour a week."}).json()
    assert st["asked"] == 1 and st["options"]  # Q2 carries options
    st = client.post(f"/api/requests/{r['id']}/interview", json={"answer": "A few hundred"}).json()
    assert st["final"] is True
    st = client.post(f"/api/requests/{r['id']}/interview", json={"skip": True}).json()
    assert st["done"] is True and st["asked"] == 3

    # Review → submit: spec drafted, gate raised
    d = client.post(f"/api/requests/{r['id']}/submit").json()
    assert d["status"] == "pending_approval" and d["gate"] == "approve_spec" and d["stage"] == "spec"
    detail = client.get(f"/api/requests/{r['id']}").json()
    lines = detail["spec_lines"]
    assert any(line["assume"] for line in lines)            # always one explicit assumption
    assert all(line["prov"] or line["assume"] for line in lines)  # every line grounded or flagged
    # submit is idempotent
    d2 = client.post(f"/api/requests/{r['id']}/submit").json()
    assert d2["status"] == "pending_approval"

    # it shows up in the inbox as a gate
    inbox = client.get("/api/inbox").json()
    assert any(i["id"] == r["id"] for i in inbox)


def test_approve_ledger_and_idempotent_replay(client):
    reqs = client.get("/api/requests").json()
    hero = next(r for r in reqs if r["ref"] == "REQ-2041")
    before = client.get("/api/events", params={"request_id": hero["id"]}).json()

    d = client.post(f"/api/requests/{hero['id']}/approve", json={"actor": "Kim P."}).json()
    assert d["status"] == "approved" and d["stage"] == "architecture"
    assert d["repo_ready"] and d["spec_pr_open"] and d["stage2_fired"]

    # replay must not double-fire (ADR 0006)
    d2 = client.post(f"/api/requests/{hero['id']}/approve", json={"actor": "Kim P."}).json()
    assert d2["status"] == "approved"
    after = client.get("/api/events", params={"request_id": hero["id"]}).json()
    approvals = [e for e in after if e["kind"] == "gate_event" and e["title"].startswith("Spec approved")]
    assert len(approvals) == 1
    assert len(after) == len(before) + 1


def test_illegal_approve_rejected(client):
    reqs = client.get("/api/requests").json()
    intake = next(r for r in reqs if r["status"] == "submitted" and not r["needs_human"])
    resp = client.post(f"/api/requests/{intake['id']}/approve", json={})
    assert resp.status_code == 409


def test_send_back_respond_loop(client):
    reqs = client.get("/api/requests").json()
    target = next(r for r in reqs if r["ref"] == "REQ-2042")
    d = client.post(f"/api/requests/{target['id']}/send-back",
                    json={"note": "Which CSV columns are required?", "actor": "Kim P."}).json()
    assert d["status"] == "sent_back" and d["send_back_rounds"] == 1 and d["gate"] is None

    d = client.post(f"/api/requests/{target['id']}/respond",
                    json={"note": "Vendor name, tax id, and bank account.", "actor": "Priya S."}).json()
    assert d["status"] == "pending_approval" and d["gate"] == "approve_spec"
    detail = client.get(f"/api/requests/{target['id']}").json()
    assert any(line["prov"] == "reply 1" for line in detail["spec_lines"])


def test_events_keyset_cursor(client):
    all_events = client.get("/api/events").json()
    assert all_events == sorted(all_events, key=lambda e: e["id"])
    mid = all_events[len(all_events) // 2]["id"]
    newer = client.get("/api/events", params={"after": mid}).json()
    assert newer and all(e["id"] > mid for e in newer)


def test_subject_axis_filter(client):
    nw = client.get("/api/events", params={"subject": "northwind"}).json()
    assert nw
    apps = {e["subject_id"] for e in nw}
    assert len(apps) == 1


def test_simulator_drives_stages_to_merge_gate(client):
    reqs = client.get("/api/requests").json()
    hero = next(r for r in reqs if r["ref"] == "REQ-2041")  # approved in earlier test → architecture
    assert hero["stage"] == "architecture"

    for _ in range(10):
        client.post("/api/simulator/tick")
    hero = client.get(f"/api/requests/{hero['id']}").json()
    assert hero["stage"] == "review" and hero["gate"] == "approve_merge"

    # ticking past the gate must NOT advance it — humans gate the irreversible
    client.post("/api/simulator/tick")
    hero2 = client.get(f"/api/requests/{hero['id']}").json()
    assert hero2["stage"] == "review"

    d = client.post(f"/api/requests/{hero['id']}/approve", json={"actor": "Kim P."}).json()
    assert d["stage"] == "done" and d["status"] == "done"
    evs = client.get("/api/events", params={"request_id": hero["id"]}).json()
    assert any("Deployed" in e["title"] for e in evs)


def test_retry_clears_escalation(client):
    reqs = client.get("/api/requests").json()
    stuck = next(r for r in reqs if r["needs_human"])
    d = client.post(f"/api/requests/{stuck['id']}/retry", json={"note": "flaky — run it again"}).json()
    assert d["needs_human"] is False
    evs = client.get("/api/events", params={"request_id": stuck["id"]}).json()
    assert any(e["kind"] == "recovery_action" for e in evs)


def test_cancel_terminal_and_idempotent(client):
    reqs = client.get("/api/requests").json()
    intake = next(r for r in reqs if r["status"] == "submitted")
    d = client.post(f"/api/requests/{intake['id']}/cancel", json={"actor": "Kim P."}).json()
    assert d["status"] == "cancelled"
    d2 = client.post(f"/api/requests/{intake['id']}/cancel", json={"actor": "Kim P."}).json()
    assert d2["status"] == "cancelled"


def test_registry_crud(client):
    a = client.post("/api/apps", json={"name": "Lab Scheduler", "owner": "lab-eng", "repo": "micron/lab-sched"}).json()
    assert a["key"] == "lab-scheduler"
    dup = client.post("/api/apps", json={"name": "Lab Scheduler"})
    assert dup.status_code == 409
    upd = client.patch(f"/api/apps/{a['id']}", json={
        "name": "Lab Scheduler", "owner": "lab-platform", "repo": "micron/lab-sched", "provisioning": "Auto", "muted": False,
    }).json()
    assert upd["owner"] == "lab-platform"


def test_comments(client):
    reqs = client.get("/api/requests").json()
    r = reqs[0]
    c = client.post(f"/api/requests/{r['id']}/comments", json={"body": "Looks fine to me."}).json()
    assert c["author"] == "Kim P."
    cs = client.get(f"/api/requests/{r['id']}/comments").json()
    assert any(x["body"] == "Looks fine to me." for x in cs)
