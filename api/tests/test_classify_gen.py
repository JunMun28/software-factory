"""Focused concurrency and session-lifetime tests for background classification."""

import threading
from contextlib import contextmanager

from sqlalchemy import select

from app import classify_gen
from app.db import SessionLocal
from app.models import BrainCall, Request


def _pending_request(
    client,
    source_description: str,
    *,
    generation_token: str = "test-generation-token",
) -> int:
    response = client.post(
        "/api/requests",
        json={"type": "enh", "title": "Classify worker probe", "description": "original"},
    )
    assert response.status_code == 201
    rid = response.json()["id"]
    with SessionLocal() as db:
        request = db.get(Request, rid)
        assert request is not None
        request.classification_result = {
            "status": "pending",
            "source_description": source_description,
            "generation_token": generation_token,
        }
        db.commit()
    return rid


def test_acquire_suppresses_duplicate_until_release_permits_retry():
    rid = -80_008
    classify_gen.release(rid)
    try:
        assert classify_gen.acquire(rid) is True
        assert classify_gen.acquire(rid) is False
        classify_gen.release(rid)
        assert classify_gen.acquire(rid) is True
    finally:
        classify_gen.release(rid)


def test_ensure_classification_starts_a_daemon_thread(client, monkeypatch):
    rid = _pending_request(client, "thread probe", generation_token="thread-token")
    real_thread = classify_gen.threading.Thread
    created = []
    created_args = []
    started = []

    def capture_thread(*args, **kwargs):
        thread = real_thread(*args, **kwargs)
        created.append(thread)
        created_args.append(kwargs["args"])
        thread.start = lambda: started.append(thread)
        return thread

    monkeypatch.setattr(classify_gen.threading, "Thread", capture_thread)
    try:
        assert classify_gen.ensure_classification(rid) is True
        assert started == created
        assert len(created) == 1
        assert created[0].daemon is True
        assert created_args == [(rid, "thread probe", "thread-token")]
    finally:
        classify_gen.release(rid)


def test_generate_holds_no_session_during_brain_call(client, monkeypatch):
    rid = _pending_request(client, "session probe")
    real_session_factory = classify_gen.SessionLocal
    active_contexts = 0

    @contextmanager
    def tracking_session_factory():
        nonlocal active_contexts
        with real_session_factory() as db:
            active_contexts += 1
            try:
                yield db
            finally:
                active_contexts -= 1

    class InspectingBrain:
        def classify(self, description: str) -> dict:
            assert description == "session probe"
            assert active_contexts == 0
            return {"type": "bug", "confidence": 0.61}

    monkeypatch.setattr(classify_gen, "SessionLocal", tracking_session_factory)
    monkeypatch.setattr(classify_gen.interview, "get_brain", lambda: InspectingBrain())

    classify_gen._generate(rid, "session probe", "test-generation-token")

    assert active_contexts == 0
    with real_session_factory() as db:
        request = db.get(Request, rid)
        assert request is not None
        assert request.classification_result == {
            "status": "succeeded",
            "source_description": "session probe",
            "type": "bug",
            "confidence": 0.61,
        }
        call = db.scalar(
            select(BrainCall).where(
                BrainCall.dedup_key == f"classify:{rid}:test-generation-token"
            )
        )
        assert call is not None
        assert call.status == "ok"


def test_older_token_cannot_overwrite_newer_same_description(client, monkeypatch):
    rid = _pending_request(
        client,
        "same description",
        generation_token="newer-generation-token",
    )

    class OldBrain:
        def classify(self, description: str) -> dict:
            assert description == "same description"
            return {"type": "bug", "confidence": 0.99}

    monkeypatch.setattr(classify_gen.interview, "get_brain", lambda: OldBrain())

    classify_gen._generate(rid, "same description", "older-generation-token")

    with SessionLocal() as db:
        request = db.get(Request, rid)
        assert request is not None
        assert request.classification_result == {
            "status": "pending",
            "source_description": "same description",
            "generation_token": "newer-generation-token",
        }


def test_repeated_kick_uses_a_new_token_for_the_same_description(client, monkeypatch):
    rid = _pending_request(client, "same description")
    monkeypatch.setattr(classify_gen, "ensure_classification", lambda _rid: True)

    assert classify_gen.kick(rid, "same description") is True
    with SessionLocal() as db:
        first = db.get(Request, rid).classification_result["generation_token"]

    assert classify_gen.kick(rid, "same description") is True
    with SessionLocal() as db:
        second = db.get(Request, rid).classification_result["generation_token"]

    assert isinstance(first, str) and first
    assert isinstance(second, str) and second
    assert first != second


def test_kick_pending_write_holds_generation_lock(client, monkeypatch):
    rid = _pending_request(client, "kick lock probe")
    real_session_factory = classify_gen.SessionLocal
    entered_session = threading.Event()
    allow_session = threading.Event()
    outcome = {}
    kick_thread = None

    def pausing_session_factory():
        if threading.current_thread() is kick_thread:
            entered_session.set()
            assert allow_session.wait(2), "test did not release the kick DB write"
        return real_session_factory()

    def run_kick():
        outcome["result"] = classify_gen.kick(rid, "kick lock probe")

    monkeypatch.setattr(classify_gen, "SessionLocal", pausing_session_factory)
    monkeypatch.setattr(classify_gen, "ensure_classification", lambda _rid: True)
    kick_thread = threading.Thread(target=run_kick)
    kick_thread.start()
    assert entered_session.wait(1), "kick did not reach its pending DB write"
    try:
        lock_was_free = classify_gen._lock.acquire(blocking=False)
        if lock_was_free:
            classify_gen._lock.release()
        assert lock_was_free is False
    finally:
        allow_session.set()
        kick_thread.join(2)

    assert not kick_thread.is_alive()
    assert outcome == {"result": True}


def test_generate_final_write_holds_generation_lock(client, monkeypatch):
    rid = _pending_request(client, "worker lock probe", generation_token="worker-token")
    real_session_factory = classify_gen.SessionLocal
    brain_returned = threading.Event()
    entered_session = threading.Event()
    allow_session = threading.Event()
    worker_thread = None

    class ImmediateBrain:
        def classify(self, description: str) -> dict:
            assert description == "worker lock probe"
            brain_returned.set()
            return {"type": "bug", "confidence": 0.71}

    def pausing_session_factory():
        if threading.current_thread() is worker_thread and brain_returned.is_set():
            entered_session.set()
            assert allow_session.wait(2), "test did not release the worker DB write"
        return real_session_factory()

    monkeypatch.setattr(classify_gen, "SessionLocal", pausing_session_factory)
    monkeypatch.setattr(classify_gen.interview, "get_brain", lambda: ImmediateBrain())
    worker_thread = threading.Thread(
        target=classify_gen._generate,
        args=(rid, "worker lock probe", "worker-token"),
    )
    worker_thread.start()
    assert entered_session.wait(1), "worker did not reach its final DB write"
    try:
        lock_was_free = classify_gen._lock.acquire(blocking=False)
        if lock_was_free:
            classify_gen._lock.release()
        assert lock_was_free is False
    finally:
        allow_session.set()
        worker_thread.join(2)

    assert not worker_thread.is_alive()
    with real_session_factory() as db:
        request = db.get(Request, rid)
        assert request is not None
        assert request.classification_result == {
            "status": "succeeded",
            "source_description": "worker lock probe",
            "type": "bug",
            "confidence": 0.71,
        }
