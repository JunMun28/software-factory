"""Epoch-fenced compare-and-swap transition tests."""
import uuid

from app.db import SessionLocal, engine, migrate
from app.leader import LeaderElector
from app.models import Request
from app.transitions import cas_status


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


def test_cas_moves_exactly_once():
    migrate()
    elector = LeaderElector(engine)
    elector.try_acquire()
    with SessionLocal() as db:
        request = _fresh_request(db)
        assert cas_status(
            db, request.id, "queued_for_pipeline", "running", elector.epoch
        ) is True
        assert cas_status(
            db, request.id, "queued_for_pipeline", "running", elector.epoch
        ) is False


def test_stale_epoch_cannot_write():
    migrate()
    elector = LeaderElector(engine)
    elector.try_acquire()
    stale = elector.epoch
    elector.release()
    elector.try_acquire()
    with SessionLocal() as db:
        request = _fresh_request(db)
        assert cas_status(
            db, request.id, "queued_for_pipeline", "running", stale
        ) is False
        assert cas_status(
            db, request.id, "queued_for_pipeline", "running", elector.epoch
        ) is True
