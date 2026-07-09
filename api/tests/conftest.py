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


@pytest.fixture(scope="session")
def client():
    app = create_app(auto_tick=0)
    with TestClient(app) as c:
        yield c
