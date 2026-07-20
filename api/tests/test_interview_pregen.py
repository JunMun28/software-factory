"""Background pre-generation: the answer POST never blocks on the model; the next
question is produced ahead of time and the API reports `thinking` until it lands.

The generation machinery (`_generate`) is exercised synchronously here; the async
thread + client poll is verified live in the browser. `interview_gen.SYNC` is flipped
off per-test to reach the async router branch without spawning real threads.
"""
import pytest
from sqlalchemy import event, select
from sqlalchemy.orm import object_session

from app import interview_gen
from app.db import SessionLocal, engine
from app.interview import DONE_SENTINEL, Question
from app.models import App, Attachment, InterviewTurn, Request
from app.routers import requests as requests_router


class _FakeBrain:
    def __init__(self, q):
        self._q = q

    def next_question(self, r):
        return self._q


_seq = 0


def _make(db, req_type="enh", answered=0):
    global _seq
    _seq += 1
    r = Request(ref=f"REQ-PG-{_seq}", title="T", description="d", type=req_type)
    for i in range(answered):
        r.turns.append(InterviewTurn(order=i, question=f"Q{i + 1}", answer=f"A{i + 1}"))
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


def _app_id(client):
    return client.get("/api/apps").json()[0]["id"]


def _new(client, **over):
    body = {"type": "enh", "title": "T", "description": "d", "app_id": _app_id(client), **over}
    return client.post("/api/requests", json=body).json()


# ── the background generator (_generate) ──

def test_generate_writes_pending_question(client, monkeypatch):
    q = Question(question="How often?", options=[{"t": "a", "d": "b"}])
    monkeypatch.setattr("app.interview_gen.get_brain", lambda: _FakeBrain(q))
    with SessionLocal() as db:
        rid = _make(db, answered=0).id
    interview_gen._generate(rid, 0)
    with SessionLocal() as db:
        pq = db.get(Request, rid).pending_question
        assert pq["question"] == "How often?" and pq["options"] == [{"t": "a", "d": "b"}]


def test_generate_calls_brain_with_detached_loaded_request(client, monkeypatch):
    class SessionProbeBrain:
        def next_question(self, r):
            assert object_session(r) is None
            assert r.app.name == "Interview probe"
            assert [turn.answer for turn in r.turns] == ["A1"]
            assert [attachment.filename for attachment in r.attachments] == ["evidence.txt"]
            return Question(question="What changed?")

    monkeypatch.setattr("app.interview_gen.get_brain", lambda: SessionProbeBrain())
    with SessionLocal() as db:
        global _seq
        _seq += 1
        app = App(
            key=f"interview-probe-{_seq}",
            name="Interview probe",
            owner="qa",
            repo="sf/interview-probe",
        )
        r = Request(
            ref=f"REQ-PG-{_seq}",
            title="T",
            description="d",
            type="enh",
            app=app,
        )
        r.turns.append(InterviewTurn(order=0, question="Q1", answer="A1"))
        r.attachments.append(
            Attachment(
                filename="evidence.txt",
                mime="text/plain",
                kind="doc",
                size=8,
                stored="interview-probe.txt",
            )
        )
        db.add(r)
        db.commit()
        rid = r.id

    interview_gen._generate(rid, answered_at_start=1)

    with SessionLocal() as db:
        assert db.get(Request, rid).pending_question["question"] == "What changed?"


def test_generate_does_not_clobber_pending_written_during_brain_call(client, monkeypatch):
    with SessionLocal() as db:
        rid = _make(db, answered=0).id

    class RacingBrain:
        def next_question(self, r):
            with SessionLocal() as db:
                current = db.get(Request, rid)
                current.pending_question = {
                    "question": "newer question",
                    "sub": None,
                    "options": None,
                    "final": False,
                }
                db.commit()
            return Question(question="stale question")

    monkeypatch.setattr("app.interview_gen.get_brain", lambda: RacingBrain())
    interview_gen._generate(rid, answered_at_start=0)

    with SessionLocal() as db:
        assert db.get(Request, rid).pending_question["question"] == "newer question"


def test_generate_writes_done_sentinel_when_brain_finishes(client, monkeypatch):
    monkeypatch.setattr("app.interview_gen.get_brain", lambda: _FakeBrain(None))
    with SessionLocal() as db:
        rid = _make(db, answered=2).id
    interview_gen._generate(rid, 2)
    with SessionLocal() as db:
        assert db.get(Request, rid).pending_question == DONE_SENTINEL


def test_generate_does_not_clobber_an_advanced_turn(client, monkeypatch):
    monkeypatch.setattr("app.interview_gen.get_brain", lambda: _FakeBrain(Question(question="stale?")))
    with SessionLocal() as db:
        rid = _make(db, answered=1).id
    # the submitter answered another question while generation was in flight
    with SessionLocal() as db:
        r = db.get(Request, rid)
        r.turns.append(InterviewTurn(order=1, question="Q2", answer="A2"))
        db.commit()
    interview_gen._generate(rid, answered_at_start=1)
    with SessionLocal() as db:
        assert db.get(Request, rid).pending_question is None  # stale generation dropped


def test_generate_does_not_overwrite_an_existing_pending(client, monkeypatch):
    monkeypatch.setattr("app.interview_gen.get_brain", lambda: _FakeBrain(Question(question="new?")))
    with SessionLocal() as db:
        r = _make(db, answered=0)
        r.pending_question = {"question": "already here", "sub": None, "options": None, "final": False}
        db.commit()
        rid = r.id
    interview_gen._generate(rid, 0)
    with SessionLocal() as db:
        assert db.get(Request, rid).pending_question["question"] == "already here"


def test_generate_closes_the_check_then_commit_window(client, monkeypatch, caplog):
    """A write after the generator's snapshot wins without a SQLite BUSY failure."""
    monkeypatch.setattr("app.interview_gen.get_brain", lambda: _FakeBrain(Question(question="stale?")))
    with SessionLocal() as db:
        rid = _make(db, answered=0).id

    raced = False

    def write_newer_question(_conn, _cursor, statement, _parameters, _context, _many):
        nonlocal raced
        if raced or not statement.lstrip().upper().startswith("UPDATE REQUESTS"):
            return
        if "pending_question" not in statement:
            return
        raced = True
        with SessionLocal() as race_db:
            current = race_db.get(Request, rid)
            current.pending_question = {
                "question": "newer question",
                "sub": None,
                "options": None,
                "final": False,
            }
            race_db.commit()

    caplog.set_level("ERROR", logger="factory.interview")
    event.listen(engine, "before_cursor_execute", write_newer_question)
    try:
        interview_gen._generate(rid, answered_at_start=0)
    finally:
        event.remove(engine, "before_cursor_execute", write_newer_question)

    assert raced is True
    assert "interview pre-generation failed" not in caplog.text
    with SessionLocal() as db:
        assert db.get(Request, rid).pending_question["question"] == "newer question"


def test_sse_resolver_drops_a_question_when_answer_count_advances(client, monkeypatch):
    with SessionLocal() as db:
        request = _make(db, answered=1)
        rid = request.id

        class AdvancingBrain:
            def next_question(self, _request):
                with SessionLocal() as race_db:
                    current = race_db.get(Request, rid)
                    current.turns.append(InterviewTurn(order=1, question="Q2", answer="A2"))
                    race_db.commit()
                return Question(question="stale question")

        monkeypatch.setattr(requests_router, "get_brain", lambda: AdvancingBrain())
        requests_router._resolve_interview(db, request)

    with SessionLocal() as db:
        assert db.get(Request, rid).pending_question is None


def test_direct_answer_does_not_clobber_question_written_during_generation(client, monkeypatch):
    request = _new(client)
    rid = request["id"]

    class RacingBrain:
        def next_question(self, _request):
            with SessionLocal() as race_db:
                current = race_db.get(Request, rid)
                current.pending_question = {
                    "question": "newer direct question",
                    "sub": None,
                    "options": None,
                    "final": False,
                }
                race_db.commit()
            return Question(question="stale direct question")

    monkeypatch.setattr(requests_router, "get_brain", lambda: RacingBrain())
    monkeypatch.setattr(interview_gen, "SYNC", False)
    response = client.post(
        f"/api/requests/{rid}/interview",
        json={"answer": "Answer the elected question"},
    )

    assert response.status_code == 200
    with SessionLocal() as db:
        turn = db.scalar(select(InterviewTurn).where(InterviewTurn.request_id == rid))
        assert turn.question == "newer direct question"
        assert turn.answer == "Answer the elected question"


def test_sync_get_does_not_clobber_question_written_during_generation(client, monkeypatch):
    request = _new(client)
    rid = request["id"]

    class RacingBrain:
        def next_question(self, _request):
            with SessionLocal() as race_db:
                current = race_db.get(Request, rid)
                current.pending_question = {
                    "question": "newer sync question",
                    "sub": None,
                    "options": None,
                    "final": False,
                }
                race_db.commit()
            return Question(question="stale sync question")

    monkeypatch.setattr(requests_router, "get_brain", lambda: RacingBrain())
    monkeypatch.setattr(interview_gen, "SYNC", True)
    response = client.get(f"/api/requests/{rid}/interview")

    assert response.status_code == 200
    assert response.json()["question"] == "newer sync question"
    with SessionLocal() as db:
        assert db.get(Request, rid).pending_question["question"] == "newer sync question"


# ── the async router contract (thinking flag) ──

@pytest.fixture
def async_mode(monkeypatch):
    monkeypatch.setattr(interview_gen, "SYNC", False)


def test_get_reports_thinking_and_kicks_generation(client, async_mode, monkeypatch):
    seen = []
    monkeypatch.setattr(interview_gen, "ensure_next_question", lambda rid: (seen.append(rid) or True))
    r = _new(client)
    st = client.get(f"/api/requests/{r['id']}/interview").json()
    assert st["thinking"] is True and st["question"] is None and st["done"] is False
    assert seen == [r["id"]]  # generation was kicked off exactly once


def test_get_returns_a_ready_pending_question(client, async_mode):
    r = _new(client)
    with SessionLocal() as db:
        req = db.get(Request, r["id"])
        req.pending_question = {"question": "Ready?", "sub": None, "options": None, "final": False}
        db.commit()
    st = client.get(f"/api/requests/{r['id']}/interview").json()
    assert st["thinking"] is False and st["question"] == "Ready?"


def test_done_sentinel_reports_done(client, async_mode):
    r = _new(client)
    with SessionLocal() as db:
        req = db.get(Request, r["id"])
        req.pending_question = DONE_SENTINEL
        db.commit()
    st = client.get(f"/api/requests/{r['id']}/interview").json()
    assert st["done"] is True


def test_answer_records_turn_and_reports_thinking(client, async_mode, monkeypatch):
    monkeypatch.setattr(interview_gen, "ensure_next_question", lambda rid: True)
    r = _new(client)
    with SessionLocal() as db:  # a question is on screen
        req = db.get(Request, r["id"])
        req.pending_question = {"question": "Q1?", "sub": None, "options": None, "final": False}
        db.commit()
    st = client.post(f"/api/requests/{r['id']}/interview", json={"answer": "my answer"}).json()
    assert st["thinking"] is True and st["question"] is None  # next Q generating in the background
    assert st["turns"][-1]["answer"] == "my answer"  # the answer was recorded immediately
