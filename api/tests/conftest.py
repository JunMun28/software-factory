import os
import tempfile

import pytest

# point the app at a throwaway DB before anything imports app.db — setdefault so a
# pre-set URL (the test-mssql CI job's mssql+pyodbc URL) survives and the suite
# actually runs against that database instead of silently falling back to SQLite
_tmp = tempfile.mkdtemp()
os.environ.setdefault("FACTORY_DB_URL", f"sqlite:///{_tmp}/test.db")
# generate interview questions inline (no background thread) so tests are deterministic
os.environ.setdefault("FACTORY_INTERVIEW_PREGEN", "sync")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import create_app  # noqa: E402


def _truncate_all():
    """Wipe every row in CI when the suite shares a real network database."""
    from sqlalchemy import delete

    from app.db import Base, engine

    if engine.dialect.name != "sqlite" and os.environ.get("CI"):
        with engine.begin() as conn:
            for table in reversed(Base.metadata.sorted_tables):
                conn.execute(delete(table))


@pytest.fixture(scope="module")
def restore_app_leadership():
    """Give module-local electors exclusive use of the MSSQL leader lock."""
    from app.leader import get_elector

    app_elector = get_elector()
    app_elector.release()
    yield
    app_elector.try_acquire()


@pytest.fixture
def make_elector():
    """Create electors and release all of them after each test."""
    from app.db import engine
    from app.leader import LeaderElector

    electors = []

    def make():
        elector = LeaderElector(engine)
        electors.append(elector)
        return elector

    yield make

    for elector in reversed(electors):
        elector.release()


@pytest.fixture(scope="session")
def client():
    app = create_app(auto_tick=0)
    _truncate_all()
    with TestClient(app) as c:
        yield c
