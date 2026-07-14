"""Epoch-fenced compare-and-swap transition tests."""
import uuid

import pytest

from app.db import SessionLocal, migrate
from app.models import Request
from app.transitions import cas_status


@pytest.fixture(scope="module", autouse=True)
def _restore_app_leadership(restore_app_leadership):
    yield


def _fresh_request(db):
    request = Request(
        ref=f"REQ-{uuid.uuid4().hex[:8]}",
        title="CAS transition fixture",
        description="Exercise status and epoch fencing.",
        type="enh",
        status="queued_for_pipeline",
    )
    db.add(request)
    db.commit()
    return request


def test_cas_moves_exactly_once(make_elector):
    migrate()
    elector = make_elector()
    elector.try_acquire()
    with SessionLocal() as db:
        request = _fresh_request(db)
        assert cas_status(
            db, request.id, "queued_for_pipeline", "running", elector.epoch
        ) is True
        db.commit()
        assert cas_status(
            db, request.id, "queued_for_pipeline", "running", elector.epoch
        ) is False
        db.rollback()


def test_stale_epoch_cannot_write(make_elector):
    migrate()
    elector = make_elector()
    elector.try_acquire()
    stale = elector.epoch
    elector.release()
    elector.try_acquire()
    with SessionLocal() as db:
        request = _fresh_request(db)
        assert cas_status(
            db, request.id, "queued_for_pipeline", "running", stale
        ) is False
        db.rollback()
        assert cas_status(
            db, request.id, "queued_for_pipeline", "running", elector.epoch
        ) is True
        db.commit()


def test_true_cas_is_not_durable_until_caller_commits(make_elector):
    """The regression pin for caller-owned transactions: this test FAILS if
    cas_status ever commits internally again (the write would survive the
    caller's rollback and the fence could be bypassed via committed intents)."""
    migrate()
    elector = make_elector()
    elector.try_acquire()
    with SessionLocal() as db:
        request = _fresh_request(db)
        req_id = request.id  # capture before rollback expires the instance
        assert cas_status(
            db, req_id, "queued_for_pipeline", "running", elector.epoch
        ) is True
        db.rollback()  # caller aborts — e.g. a sibling intent insert failed
    with SessionLocal() as db2:
        assert db2.get(Request, req_id).status == "queued_for_pipeline"


def test_cas_missing_row_returns_false(make_elector):
    migrate()
    elector = make_elector()
    elector.try_acquire()
    with SessionLocal() as db:
        assert cas_status(
            db, -1, "queued_for_pipeline", "running", elector.epoch
        ) is False
        db.rollback()
