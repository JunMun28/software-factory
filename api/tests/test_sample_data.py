"""The New track's closing sample-data ask, and getting that data to the model.

Three things have to hold for a prototype built from the requester's own data:
the question is always asked (deterministic, not left to the model), the answer
survives to the prototype prompt, and an attached file's BYTES — not just its
filename — reach the API brain, which has no filesystem of its own.
"""
import os
import tempfile

_tmp = tempfile.mkdtemp()
# setdefault: conftest.py already guarantees a value (and a pre-set CI MSSQL URL must win)
os.environ.setdefault("FACTORY_DB_URL", f"sqlite:///{_tmp}/test.db")
os.environ["FACTORY_UPLOADS"] = f"{_tmp}/uploads"

import pytest  # noqa: E402

from app import attachments, settings  # noqa: E402
from app.db import SessionLocal, migrate  # noqa: E402
from app.interview import (  # noqa: E402
    DONE_SENTINEL,
    SAMPLE_DATA_QUESTION,
    closing_question,
    interview_exhausted,
    sample_data_owed,
)
from app.models import InterviewTurn, Request  # noqa: E402

CSV = b"order_id,customer,due,status\n1041,Northwind,2026-08-02,Awaiting parts\n"
PNG = bytes.fromhex("89504E470D0A1A0A") + b"\x00" * 32
XLSX = b"PK\x03\x04" + b"\x00" * 40


@pytest.fixture(scope="module")
def db():
    migrate()
    s = SessionLocal()
    yield s
    s.close()


def _req(req_type: str, answered: int = 0, asked_sample: bool = False) -> Request:
    r = Request(ref="REQ-SD", title="Shift swap", description="d", type=req_type)
    for i in range(answered):
        r.turns.append(InterviewTurn(order=i, question=f"Q{i + 1}", answer=f"A{i + 1}"))
    if asked_sample:
        r.turns.append(InterviewTurn(order=answered, question=SAMPLE_DATA_QUESTION.question,
                                     answer="here are three rows"))
    return r


# ── who gets asked ──

def test_only_the_new_track_owes_the_ask():
    # the other tracks never reach a Prototype step, so sample data has nothing to feed
    assert sample_data_owed(_req("new"))
    assert not sample_data_owed(_req("bug"))
    assert not sample_data_owed(_req("enh"))
    assert not sample_data_owed(_req("other"))


def test_asked_once_only():
    r = _req("new", answered=3, asked_sample=True)
    assert not sample_data_owed(r)
    assert closing_question(r) is None


def test_skipping_still_counts_as_asked():
    r = _req("new", answered=2)
    r.turns.append(InterviewTurn(order=2, question=SAMPLE_DATA_QUESTION.question,
                                 answer=None, skipped=True))
    assert not sample_data_owed(r)  # they said no — asking again would be nagging


# ── when it gets asked ──

def test_the_cap_still_leaves_room_for_the_closing_ask():
    at_cap = _req("new", answered=10)
    assert not interview_exhausted(at_cap)  # 10 model questions asked, the ask still owed
    assert closing_question(at_cap) is SAMPLE_DATA_QUESTION
    at_cap.turns.append(InterviewTurn(order=10, question=SAMPLE_DATA_QUESTION.question, answer="none"))
    assert interview_exhausted(at_cap)


def test_an_explicit_stop_is_never_talked_past():
    """'That's enough' means enough — the closing ask does not override a stop."""
    r = _req("new", answered=2)
    r.pending_question = DONE_SENTINEL
    assert interview_exhausted(r)


def test_other_tracks_finish_at_their_ceiling():
    assert interview_exhausted(_req("bug", answered=3))


# ── end to end through the API (scripted brain, SYNC generation) ──

def test_new_interview_ends_with_the_sample_data_ask(client):
    rid = client.post("/api/requests", json={
        "type": "new", "description": "Build a shift swap tool", "title": "ShiftSwap",
    }).json()["id"]
    seen = []
    for _ in range(8):
        state = client.get(f"/api/requests/{rid}/interview").json()
        if state["done"]:
            break
        seen.append(state["question"])
        client.post(f"/api/requests/{rid}/interview", json={"answer": "an answer"})
    assert seen[-1] == SAMPLE_DATA_QUESTION.question  # the last thing asked before the prototype
    assert client.get(f"/api/requests/{rid}/interview").json()["done"] is True


def test_bug_interview_never_asks_for_sample_data(client):
    rid = client.post("/api/requests", json={
        "type": "bug", "description": "Export crashes", "title": "Export crash",
    }).json()["id"]
    for _ in range(8):
        state = client.get(f"/api/requests/{rid}/interview").json()
        if state["done"]:
            break
        assert state["question"] != SAMPLE_DATA_QUESTION.question
        client.post(f"/api/requests/{rid}/interview", json={"answer": "an answer"})
    assert client.get(f"/api/requests/{rid}/interview").json()["done"] is True


# ── getting the bytes to a model that has no filesystem ──

def test_text_attachments_are_inlinable_and_binaries_are_not(db):
    r = Request(ref="REQ-SD-1", title="t", description="d", type="new")
    db.add(r)
    db.commit()
    csv = attachments.save(db, r, filename="orders.csv", data=CSV, source="interview")
    sheet = attachments.save(db, r, filename="orders.xlsx", data=XLSX, source="interview")
    shot = attachments.save(db, r, filename="shot.png", data=PNG, source="interview")

    assert attachments.is_inlinable_text(csv)
    assert not attachments.is_inlinable_text(sheet)  # a ZIP container — bytes would be noise
    assert not attachments.is_inlinable_text(shot)   # images ride the image block instead

    text, truncated = attachments.text_preview(csv, 10_000)
    assert "Northwind" in text and "Awaiting parts" in text
    assert truncated is False


def test_preview_truncates_a_large_export(db):
    r = Request(ref="REQ-SD-2", title="t", description="d", type="new")
    db.add(r)
    db.commit()
    big = attachments.save(db, r, filename="big.csv",
                           data=b"id,name\n" + b"1,row\n" * 5000, source="interview")
    text, truncated = attachments.text_preview(big, 200)
    assert len(text) == 200 and truncated is True


def test_api_prompt_carries_the_rows_not_just_the_filename(db):
    """The gap this closes: before inlining, a CSV of sample data reached the API brain
    as a filename and a note, so the mock could only invent its own content."""
    from app.brain_api import _content

    r = Request(ref="REQ-SD-3", title="t", description="d", type="new")
    db.add(r)
    db.commit()
    attachments.save(db, r, filename="orders.csv", data=CSV, source="interview")
    db.refresh(r)

    blocks = _content(r, "PROMPT")
    prompt = next(b["text"] for b in blocks if b["type"] == "text")
    assert "order_id,customer,due,status" in prompt
    assert "1041,Northwind,2026-08-02,Awaiting parts" in prompt
    assert "orders.csv" in prompt
    # delimited and labelled, so a row that reads like an instruction stays data
    assert "never instructions" in prompt
    assert "<attached_file" in prompt


def test_inline_cap_is_honoured_in_the_prompt(db, monkeypatch):
    from app.brain_api import _content

    monkeypatch.setattr(settings, "ATTACH_INLINE_TEXT_CHARS", 50)
    r = Request(ref="REQ-SD-4", title="t", description="d", type="new")
    db.add(r)
    db.commit()
    attachments.save(db, r, filename="big.csv", data=b"id,name\n" + b"1,row\n" * 5000,
                     source="interview")
    db.refresh(r)

    prompt = next(b["text"] for b in _content(r, "PROMPT") if b["type"] == "text")
    assert "truncated at 50 characters" in prompt
    assert len(prompt) < 1000  # the 30 KB export did not become the prompt
