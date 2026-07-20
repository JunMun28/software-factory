"""Concurrent intake mutations have one database-elected winner."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from sqlalchemy import inspect, select
from sqlalchemy.exc import IntegrityError

from app import interview_gen, prototype_gen
from app.db import SessionLocal, engine
from app.interview import DONE_SENTINEL
from app.models import InterviewTurn, PrototypeTurn, Request
from app.routers import requests as requests_router


def _new(client, request_type: str = "enh") -> int:
    body = {
        "type": request_type,
        "title": f"Concurrency probe {uuid4().hex[:8]}",
        "description": "Exercise one-winner intake writes.",
    }
    if request_type == "new":
        body["new_app_name"] = "Concurrency probe"
    return client.post("/api/requests", json=body).json()["id"]


def _post_pair(client, url: str, body: dict):
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(client.post, url, json=body) for _ in range(2)]
        return [future.result(timeout=10) for future in futures]


def _synchronize_request_loads(monkeypatch, *, load_prototype_turns: bool = False) -> None:
    """Hold both request snapshots at the endpoint's check-then-act seam."""
    original = requests_router.get_request
    barrier = Barrier(2)

    def synchronized(db, rid):
        request = original(db, rid)
        if load_prototype_turns:
            _ = request.prototype_turns
        barrier.wait(timeout=5)
        return request

    monkeypatch.setattr(requests_router, "get_request", synchronized)


def _assert_one_winner(responses) -> None:
    assert sorted(response.status_code for response in responses) == [200, 409]
    conflict = next(response for response in responses if response.status_code == 409)
    assert set(conflict.json()) == {"detail"}
    assert conflict.json()["detail"]


def test_two_answers_have_one_winner_and_one_turn(client, monkeypatch):
    rid = _new(client)
    with SessionLocal() as db:
        request = db.get(Request, rid)
        request.pending_question = {
            "question": "What changed?",
            "sub": None,
            "options": None,
            "final": False,
        }
        db.commit()

    monkeypatch.setattr(interview_gen, "SYNC", False)
    _synchronize_request_loads(monkeypatch)
    responses = _post_pair(
        client,
        f"/api/requests/{rid}/interview",
        {"answer": "The same answer from two tabs"},
    )

    _assert_one_winner(responses)
    with SessionLocal() as db:
        turns = list(
            db.scalars(
                select(InterviewTurn)
                .where(InterviewTurn.request_id == rid)
                .order_by(InterviewTurn.order)
            )
        )
        assert [(turn.order, turn.answer) for turn in turns] == [
            (0, "The same answer from two tabs")
        ]
        assert db.get(Request, rid).pending_question is None


def test_two_prototype_instructions_have_one_winner_and_one_turn(client, monkeypatch):
    rid = _new(client, "new")
    client.get(f"/api/requests/{rid}/prototype")  # resolve the auto first draft

    monkeypatch.setattr(prototype_gen, "SYNC", False)
    _synchronize_request_loads(monkeypatch)
    responses = _post_pair(
        client,
        f"/api/requests/{rid}/prototype",
        {"instruction": "Make the heading clearer"},
    )

    _assert_one_winner(responses)
    with SessionLocal() as db:
        turns = list(
            db.scalars(
                select(PrototypeTurn)
                .where(
                    PrototypeTurn.request_id == rid,
                    PrototypeTurn.instruction == "Make the heading clearer",
                )
                .order_by(PrototypeTurn.order)
            )
        )
        assert [(turn.order, turn.mode) for turn in turns] == [(1, "pending")]


def test_two_prototype_restores_have_one_winner_and_one_history_entry(client, monkeypatch):
    rid = _new(client, "new")
    client.get(f"/api/requests/{rid}/prototype")

    monkeypatch.setattr(prototype_gen, "SYNC", False)
    _synchronize_request_loads(monkeypatch, load_prototype_turns=True)
    responses = _post_pair(
        client,
        f"/api/requests/{rid}/prototype/restore",
        {"order": 0},
    )

    _assert_one_winner(responses)
    with SessionLocal() as db:
        restored = list(
            db.scalars(
                select(PrototypeTurn)
                .where(
                    PrototypeTurn.request_id == rid,
                    PrototypeTurn.note == "Reverted to an earlier version.",
                )
                .order_by(PrototypeTurn.order)
            )
        )
        assert [(turn.order, turn.mode) for turn in restored] == [(1, "rewrite")]


def test_prototype_restore_rejects_an_unresolved_instruction(client, monkeypatch):
    rid = _new(client, "new")
    initial = client.get(f"/api/requests/{rid}/prototype").json()["html"]
    monkeypatch.setattr(prototype_gen, "SYNC", False)
    instructed = client.post(
        f"/api/requests/{rid}/prototype",
        json={"instruction": "Make the heading clearer"},
    )

    response = client.post(
        f"/api/requests/{rid}/prototype/restore",
        json={"order": 0},
    )

    assert instructed.status_code == 200
    assert response.status_code == 409
    with SessionLocal() as db:
        request = db.get(Request, rid)
        assert request.prototype_html == initial
        assert [(turn.order, turn.mode) for turn in request.prototype_turns] == [
            (0, "rewrite"),
            (1, "pending"),
        ]


def test_two_reopens_have_one_winner_and_one_added_note(client, monkeypatch):
    rid = _new(client)
    with SessionLocal() as db:
        request = db.get(Request, rid)
        request.turns.append(InterviewTurn(order=0, question="Q1", answer="A1"))
        request.pending_question = DONE_SENTINEL
        db.commit()

    monkeypatch.setattr(interview_gen, "SYNC", False)
    _synchronize_request_loads(monkeypatch)
    responses = _post_pair(
        client,
        f"/api/requests/{rid}/interview/reopen",
        {"note": "Please also support the warehouse team"},
    )

    _assert_one_winner(responses)
    with SessionLocal() as db:
        notes = list(
            db.scalars(
                select(InterviewTurn).where(
                    InterviewTurn.request_id == rid,
                    InterviewTurn.answer == "Please also support the warehouse team",
                )
            )
        )
        request = db.get(Request, rid)
        assert [(turn.order, turn.question) for turn in notes] == [(1, "Anything else to add?")]
        assert request.reopen_ceiling == 4


def test_two_escalation_accepts_have_one_winner(client, monkeypatch):
    rid = _new(client, "bug")
    with SessionLocal() as db:
        request = db.get(Request, rid)
        request.summary = {"overview": "Old bug summary", "sections": [], "at_turns": 0}
        request.pending_question = {
            "question": "Where does it fail?",
            "sub": None,
            "options": None,
            "final": False,
        }
        db.commit()

    monkeypatch.setattr(interview_gen, "SYNC", False)
    _synchronize_request_loads(monkeypatch)
    responses = _post_pair(
        client,
        f"/api/requests/{rid}/interview/escalate",
        {"accept": True, "to_type": "new"},
    )

    _assert_one_winner(responses)
    with SessionLocal() as db:
        request = db.get(Request, rid)
        assert request.type == "new"
        assert request.summary is None
        assert request.pending_question is None


@pytest.mark.parametrize(
    ("model", "values"),
    [
        (InterviewTurn, {"question": "Duplicate order", "answer": "A"}),
        (PrototypeTurn, {"instruction": "Duplicate order", "mode": "pending"}),
    ],
)
def test_turn_order_unique_indexes_reject_duplicate_orders(client, model, values):
    rid = _new(client, "new")
    with SessionLocal() as db:
        db.add_all(
            [
                model(request_id=rid, order=0, **values),
                model(request_id=rid, order=0, **values),
            ]
        )
        with pytest.raises(IntegrityError):
            db.commit()


def test_turn_order_indexes_are_named_unique_composites(client):
    expected = {
        "interview_turns": "uq_interview_turns_request_order",
        "prototype_turns": "uq_prototype_turns_request_order",
    }
    schema = inspect(engine)
    for table, name in expected.items():
        index = next(item for item in schema.get_indexes(table) if item["name"] == name)
        assert index["column_names"] == ["request_id", "order"]
        assert index["unique"] == 1
