"""Leader election: sqlite = always-leader with real epochs; the fencing
contract (stale epoch loses) is dialect-independent and tested here."""
import pytest
from sqlalchemy import select

from app.db import SessionLocal, migrate
from app.models import LeaderEpoch


@pytest.fixture(scope="module", autouse=True)
def _restore_app_leadership(restore_app_leadership):
    yield


def test_sqlite_acquire_is_leader_and_bumps_epoch(make_elector):
    migrate()
    e1 = make_elector()
    assert e1.try_acquire() is True
    assert e1.is_leader() is True
    first = e1.epoch
    e1.release()
    e2 = make_elector()
    assert e2.try_acquire() is True
    assert e2.epoch == first + 1  # every acquisition is a new fencing epoch


def test_epoch_row_is_singleton(make_elector):
    migrate()
    e = make_elector()
    e.try_acquire()
    with SessionLocal() as db:
        rows = db.execute(select(LeaderEpoch)).scalars().all()
    assert len(rows) == 1 and rows[0].id == 1
    e.release()


def test_verify_true_while_held(make_elector):
    migrate()
    e = make_elector()
    e.try_acquire()
    assert e.verify() is True
    e.release()
    assert e.is_leader() is False


def test_reacquire_same_instance_bumps_epoch(make_elector):
    migrate()
    e = make_elector()
    e.try_acquire()
    first = e.epoch
    e.release()
    e.try_acquire()
    assert e.epoch == first + 1


def test_verify_false_after_release(make_elector):
    migrate()
    e = make_elector()
    e.try_acquire()
    e.release()
    assert e.verify() is False
