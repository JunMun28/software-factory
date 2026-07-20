"""Review-step AI summary + 'Add more detail' reopen.

The interview finishes and the submitter lands on Review, which shows an AI summary
(cached, refreshed when the interview grows) with two actions: add more detail
(reopen) or submit. Brain calls run through the deterministic ScriptedBrain here.
"""
from sqlalchemy.orm import object_session

from app import summary_gen
from app.db import SessionLocal
from app.interview import ScriptedBrain, question_ceiling
from app.models import App, Attachment, InterviewTurn, Request


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


def test_background_summary_calls_brain_with_detached_loaded_request(client, monkeypatch):
    class SessionProbeBrain:
        def summarize(self, r):
            assert object_session(r) is None
            assert r.app.name == "Summary probe"
            assert [turn.answer for turn in r.turns] == ["A1"]
            assert [attachment.filename for attachment in r.attachments] == ["brief.txt"]
            return {"overview": "Detached summary", "sections": []}

    monkeypatch.setattr("app.summary_gen.get_brain", lambda: SessionProbeBrain())
    with SessionLocal() as db:
        app = App(key="summary-probe", name="Summary probe", owner="qa", repo="sf/summary-probe")
        r = Request(ref="REQ-SUM-BG", title="T", description="d", type="enh", app=app)
        r.turns.append(InterviewTurn(order=0, question="Q1", answer="A1"))
        r.attachments.append(
            Attachment(
                filename="brief.txt",
                mime="text/plain",
                kind="doc",
                size=5,
                stored="summary-probe.txt",
            )
        )
        db.add(r)
        db.commit()
        rid = r.id

    summary_gen._generate(rid, expected_turns=1)

    with SessionLocal() as db:
        assert db.get(Request, rid).summary == {
            "overview": "Detached summary",
            "sections": [],
            "at_turns": 1,
        }


def test_background_summary_drops_result_when_interview_advances_during_call(client, monkeypatch):
    with SessionLocal() as db:
        r = Request(ref="REQ-SUM-RACE", title="T", description="d", type="enh")
        r.turns.append(InterviewTurn(order=0, question="Q1", answer="A1"))
        db.add(r)
        db.commit()
        rid = r.id

    class RacingBrain:
        def summarize(self, r):
            with SessionLocal() as db:
                current = db.get(Request, rid)
                current.turns.append(InterviewTurn(order=1, question="Q2", answer="A2"))
                db.commit()
            return {"overview": "Stale summary", "sections": []}

    monkeypatch.setattr("app.summary_gen.get_brain", lambda: RacingBrain())
    summary_gen._generate(rid, expected_turns=1)

    with SessionLocal() as db:
        assert db.get(Request, rid).summary is None


def test_sync_summary_calls_brain_with_detached_loaded_request(client, monkeypatch):
    class SessionProbeBrain:
        def summarize(self, r):
            assert object_session(r) is None
            assert r.app.name == "Sync summary probe"
            assert [turn.answer for turn in r.turns] == ["A1"]
            assert [attachment.filename for attachment in r.attachments] == ["sync-brief.txt"]
            return {"overview": "Detached sync summary", "sections": []}

    monkeypatch.setattr("app.summary_gen.get_brain", lambda: SessionProbeBrain())
    with SessionLocal() as db:
        app = App(
            key="sync-summary-probe",
            name="Sync summary probe",
            owner="qa",
            repo="sf/sync-summary-probe",
        )
        r = Request(ref="REQ-SUM-SYNC", title="T", description="d", type="enh", app=app)
        r.turns.append(InterviewTurn(order=0, question="Q1", answer="A1"))
        r.attachments.append(
            Attachment(
                filename="sync-brief.txt",
                mime="text/plain",
                kind="doc",
                size=5,
                stored="sync-summary-probe.txt",
            )
        )
        db.add(r)
        db.commit()
        result = summary_gen.generate_sync(r, db)
        rid = r.id

    assert result == {
        "overview": "Detached sync summary",
        "sections": [],
        "at_turns": 1,
    }
    with SessionLocal() as db:
        assert db.get(Request, rid).summary == result


def test_sync_summary_persists_retry_when_interview_advances_during_call(client, monkeypatch):
    calls = 0
    with SessionLocal() as db:
        r = Request(ref="REQ-SUM-SYNC-RACE", title="T", description="d", type="enh")
        r.turns.append(InterviewTurn(order=0, question="Q1", answer="A1"))
        db.add(r)
        db.commit()
        rid = r.id

        class RacingBrain:
            def summarize(self, request):
                nonlocal calls
                calls += 1
                assert object_session(request) is None
                if calls == 1:
                    assert [turn.answer for turn in request.turns] == ["A1"]
                    with SessionLocal() as race_db:
                        current = race_db.get(Request, rid)
                        current.turns.append(InterviewTurn(order=1, question="Q2", answer="A2"))
                        race_db.commit()
                    return {"overview": "One-answer summary", "sections": []}
                assert [turn.answer for turn in request.turns] == ["A1", "A2"]
                return {"overview": "Two-answer summary", "sections": []}

        monkeypatch.setattr("app.summary_gen.get_brain", lambda: RacingBrain())
        result = summary_gen.generate_sync(r, db)

    assert calls == 2
    assert result["overview"] == "Two-answer summary"
    with SessionLocal() as db:
        assert db.get(Request, rid).summary == {
            "overview": "Two-answer summary",
            "sections": [],
            "at_turns": 2,
        }


def test_summary_claim_changes_when_non_turn_prompt_input_changes(client):
    rid = _create(client, type="enh")
    first = client.get(f"/api/requests/{rid}/summary").json()
    assert first["overview"] == "gamified guitar app"

    client.patch(
        f"/api/requests/{rid}",
        json={"description": "A practice planner with weekly goals"},
    )
    second = client.get(f"/api/requests/{rid}/summary").json()

    assert second["overview"] == "A practice planner with weekly goals"
    with SessionLocal() as db:
        stored = db.get(Request, rid).summary
        assert stored is not None
        assert stored["overview"] == "A practice planner with weekly goals"


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
