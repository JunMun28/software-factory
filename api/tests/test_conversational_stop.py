from app.interview import is_stop_signal


def test_stop_phrases_detected():
    assert is_stop_signal("that's enough")
    assert is_stop_signal("stop asking")
    assert is_stop_signal("no more questions please")
    assert not is_stop_signal("that's enough context, here is what else broke: ...")  # long answer wins
    assert not is_stop_signal("add a stop button to the toolbar")
    # bare exact phrases still stop when they ARE the whole message
    assert is_stop_signal("stop")
    assert is_stop_signal("no more")
    # ...but must never false-positive as a prefix on a real, legitimate answer
    assert not is_stop_signal("no more than 5 users allowed")
    assert not is_stop_signal("stop the duplicate emails from firing")


def test_answering_with_stop_ends_a_new_app_interview(client):
    created = client.post("/api/requests", json={
        "type": "new", "description": "Build a scheduling tool", "title": "Scheduler",
    }).json()
    rid = created["id"]
    # kick the interview so a question is pending
    client.get(f"/api/requests/{rid}/interview")
    r = client.post(f"/api/requests/{rid}/interview", json={"answer": "that's enough"})
    body = r.json()
    assert body["done"] is True
    # the stop answer itself must be persisted as a real turn, not discarded
    assert body["turns"][-1]["answer"] == "that's enough"
