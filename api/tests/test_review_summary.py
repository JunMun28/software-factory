"""Review-step AI summary + 'Add more detail' reopen.

The interview finishes and the submitter lands on Review, which shows an AI summary
(cached, refreshed when the interview grows) with two actions: add more detail
(reopen) or submit. Brain calls run through the deterministic ScriptedBrain here.
"""
from app.interview import ScriptedBrain, question_ceiling
from app.models import InterviewTurn, Request


def _req(req_type: str, answered: int = 0) -> Request:
    r = Request(ref="REQ-SUM", title="Fast export", description="Export is slow", type=req_type)
    for i in range(answered):
        r.turns.append(InterviewTurn(order=i, question=f"Q{i + 1}", answer=f"A{i + 1}"))
    return r


# ── reopen overrides the type ceiling with a small allowance ──

def test_reopen_ceiling_overrides_budget():
    r = _req("new", answered=4)  # base ceiling 99
    assert question_ceiling(r) == 99
    r.reopen_ceiling = 6  # a reopen caps it near where it resumed — not a full new-app grill
    assert question_ceiling(r) == 6


# ── ScriptedBrain summary fallback ──

def _all_items(summary: dict) -> list[str]:
    """Flatten every bullet across the spec's structured sections."""
    return [it for sec in (summary.get("sections") or []) for it in (sec.get("items") or [])]


def test_scripted_summary_from_answers():
    r = _req("enh")
    r.turns.append(InterviewTurn(order=0, question="How many?", answer="A few hundred rows"))
    s = ScriptedBrain().summarize(r)
    assert s["overview"]  # never empty — falls back to description/title
    assert s["sections"] and all("title" in sec and "items" in sec for sec in s["sections"])
    assert "A few hundred rows" in _all_items(s)  # the answer lands in a structured section


# ── endpoints (SYNC brain via the test client) ──

def _create(client, type="new"):
    body = {"type": type, "title": "FretJourney", "description": "gamified guitar app",
            "new_app_name": "FretJourney"}
    return client.post("/api/requests", json=body).json()["id"]


def _drive_to_done(client, rid):
    for _ in range(12):
        st = client.get(f"/api/requests/{rid}/interview").json()
        if st["done"]:
            return st
        client.post(f"/api/requests/{rid}/interview", json={"answer": "ok"})
    return client.get(f"/api/requests/{rid}/interview").json()


def test_summary_endpoint_returns_spec(client):
    rid = _create(client)
    _drive_to_done(client, rid)
    s = client.get(f"/api/requests/{rid}/summary").json()
    assert s["thinking"] is False
    assert s["overview"]  # a written (or fallback) overview is present
    assert isinstance(s["sections"], list)  # structured spec sections


def test_reopen_records_note_and_refreshes_summary(client):
    rid = _create(client)
    _drive_to_done(client, rid)
    before = client.get(f"/api/requests/{rid}/summary").json()
    assert "left-handed mode" not in " ".join(_all_items(before))

    reopened = client.post(f"/api/requests/{rid}/interview/reopen",
                           json={"note": "please support left-handed mode"})
    assert reopened.status_code == 200
    turns = reopened.json()["turns"]
    assert any(t["answer"] == "please support left-handed mode" for t in turns)  # recorded as a turn

    after = client.get(f"/api/requests/{rid}/summary").json()
    # the cache is keyed on answer count → the new turn forces a regenerate that includes it
    assert any("left-handed mode" in it for it in _all_items(after))


def test_reopen_empty_note_is_noop(client):
    rid = _create(client)
    st = _drive_to_done(client, rid)
    n_turns = len(st["turns"])
    reopened = client.post(f"/api/requests/{rid}/interview/reopen", json={"note": "  "})
    assert reopened.status_code == 200
    assert len(reopened.json()["turns"]) == n_turns  # nothing added
