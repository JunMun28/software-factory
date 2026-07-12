import os
os.environ["FACTORY_INTERVIEW_PREGEN"] = "sync"  # deterministic inline generation

from app.interview import is_stop_signal


def test_stop_phrases_detected():
    assert is_stop_signal("that's enough")
    assert is_stop_signal("stop asking")
    assert is_stop_signal("no more questions please")
    assert not is_stop_signal("that's enough context, here is what else broke: ...")  # long answer wins
    assert not is_stop_signal("add a stop button to the toolbar")


def test_answering_with_stop_ends_a_new_app_interview(client):
    created = client.post("/api/requests", json={
        "type": "new", "description": "Build a scheduling tool", "title": "Scheduler",
    }).json()
    rid = created["id"]
    # kick the interview so a question is pending
    client.get(f"/api/requests/{rid}/interview")
    r = client.post(f"/api/requests/{rid}/interview", json={"answer": "that's enough"})
    assert r.json()["done"] is True
