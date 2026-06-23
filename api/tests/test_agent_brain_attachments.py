import os
import tempfile

_tmp = tempfile.mkdtemp()
os.environ["FACTORY_DB_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["FACTORY_UPLOADS"] = f"{_tmp}/uploads"

import pytest  # noqa: E402

from app import attachments  # noqa: E402
from app.db import SessionLocal, migrate  # noqa: E402
from app.models import Request  # noqa: E402

PNG = bytes.fromhex("89504E470D0A1A0A") + b"\x00" * 32


@pytest.fixture(scope="module")
def db():
    migrate()
    s = SessionLocal()
    yield s
    s.close()


def test_draft_spec_passes_workdir_and_images(db, monkeypatch):
    r = Request(ref="REQ-7777", title="Export crash", description="boom", type="bug")
    db.add(r)
    db.commit()
    attachments.save(db, r, filename="shot.png", data=PNG, source="describe")
    db.refresh(r)

    seen = {}

    def fake_run_agent(prompt, **kw):
        seen["cwd"] = kw.get("cwd")
        seen["images"] = kw.get("images")
        seen["prompt"] = prompt
        from app.agent_exec import AgentResult
        return AgentResult(ok=True, text='{"lines":[{"text":"Fix export.","prov":"request","assume":false}],"open_note":"x"}')

    monkeypatch.setattr("app.agent_brain.run_agent", fake_run_agent)
    from app.agent_brain import AgentBrain

    lines, note = AgentBrain().draft_spec(r)
    assert seen["cwd"] and os.path.isdir(seen["cwd"]) is False  # rmtree'd after the call
    assert seen["images"] and seen["images"][0].endswith("shot.png")
    assert "shot.png" in seen["prompt"]
    assert lines and lines[0].text == "Fix export."
