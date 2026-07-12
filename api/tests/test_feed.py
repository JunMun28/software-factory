"""The channel feed contract (ADR 0012): comments ride the one event log;
the subject feed serves a tail page + keyset increments."""


def test_comment_rides_the_event_log(client):
    reqs = client.get("/api/requests").json()
    target = next(r for r in reqs if r["app_key"] == "northwind")
    before = client.get("/api/events", params={"request_id": target["id"]}).json()

    c = client.post(f"/api/requests/{target['id']}/comments",
                    json={"body": "Feed-rail check.", "operator_id": 1}).json()

    after = client.get("/api/events", params={"request_id": target["id"]}).json()
    assert len(after) == len(before) + 1
    ev = after[-1]
    assert ev["kind"] == "comment" and ev["actor"] == "Kim Park" and ev["bot"] is False
    assert ev["payload"]["comment_id"] == c["id"]
    assert ev["payload"]["body"] == "Feed-rail check."


def test_subject_feed_tail_then_increment(client):
    page = client.get("/api/subjects/northwind/feed", params={"limit": 5}).json()
    items, cursor = page["items"], page["cursor"]
    assert 0 < len(items) <= 5
    ids = [e["id"] for e in items]
    assert ids == sorted(ids), "tail page must be ascending"
    assert cursor == ids[-1]
    assert all(e["subject_id"] == items[0]["subject_id"] for e in items)

    # nothing new yet → empty increment, cursor stable
    inc = client.get("/api/subjects/northwind/feed", params={"after": cursor}).json()
    assert inc["items"] == [] and inc["cursor"] == cursor

    # a new comment shows up as exactly one increment past the cursor
    reqs = client.get("/api/requests").json()
    target = next(r for r in reqs if r["app_key"] == "northwind")
    client.post(f"/api/requests/{target['id']}/comments", json={"body": "Incremental check.", "operator_id": 1})
    inc2 = client.get("/api/subjects/northwind/feed", params={"after": cursor}).json()
    assert len(inc2["items"]) == 1
    assert inc2["items"][0]["payload"]["body"] == "Incremental check."
    assert inc2["cursor"] > cursor


def test_subject_feed_unknown_app_404(client):
    assert client.get("/api/subjects/nope/feed").status_code == 404
