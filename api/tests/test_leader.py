"""Leader election: sqlite = always-leader with real epochs; the fencing
contract (stale epoch loses) is dialect-independent and tested here."""
from sqlalchemy import select

from app.db import SessionLocal, engine, migrate
from app.leader import LeaderElector
from app.models import LeaderEpoch


def test_sqlite_acquire_is_leader_and_bumps_epoch():
    migrate()
    e1 = LeaderElector(engine)
    assert e1.try_acquire() is True
    assert e1.is_leader() is True
    first = e1.epoch
    e1.release()
    e2 = LeaderElector(engine)
    assert e2.try_acquire() is True
    assert e2.epoch == first + 1  # every acquisition is a new fencing epoch


def test_epoch_row_is_singleton():
    migrate()
    e = LeaderElector(engine)
    e.try_acquire()
    with SessionLocal() as db:
        rows = db.execute(select(LeaderEpoch)).scalars().all()
    assert len(rows) == 1 and rows[0].id == 1
    e.release()


def test_verify_true_while_held():
    migrate()
    e = LeaderElector(engine)
    e.try_acquire()
    assert e.verify() is True
    e.release()
    assert e.is_leader() is False
