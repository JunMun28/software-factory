"""Background pre-generation: the answer POST never blocks on the model; the next
question is produced ahead of time and the API reports `thinking` until it lands.

The generation machinery (`_generate`) is exercised synchronously here; the async
thread + client poll is verified live in the browser. `interview_gen.SYNC` is flipped
off per-test to reach the async router branch without spawning real threads.
"""
import pytest

from app import interview_gen
from app.db import SessionLocal
from app.interview import DONE_SENTINEL, Question
from app.models import InterviewTurn, Request


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
