import os
import tempfile

import pytest

# point the app at a throwaway DB before anything imports app.db
_tmp = tempfile.mkdtemp()
os.environ["FACTORY_DB_URL"] = f"sqlite:///{_tmp}/test.db"
# generate interview questions inline (no background thread) so tests are deterministic
os.environ.setdefault("FACTORY_INTERVIEW_PREGEN", "sync")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import create_app  # noqa: E402


def _truncate_all():
    """Wipe every row (schema stays) — on a real network DB (MSSQL/Azure SQL) the
    session-scoped client fixture reuses one database for the whole run, so a
    leftover row from an earlier test can bleed into a later one. SQLite tests get
    a fresh throwaway file per run (see FACTORY_DB_URL above) so this is a no-op
    there in practice, but it's cheap enough to always be correct."""
    from sqlalchemy import delete

    from app.db import Base, engine

    with engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            conn.execute(delete(table))


@pytest.fixture(scope="session")
def client():
    app = create_app(auto_tick=0)
    if not os.environ["FACTORY_DB_URL"].startswith("sqlite"):
        _truncate_all()
    with TestClient(app) as c:
        yield c
