"""The prototype is a file the agent edits, not text it retypes.

The old contract had the model emit the whole document in a fenced block every turn,
so a one-line change cost a full rewrite in both directions (~5k tokens each way on a
real mock), and "patch" mode existed only because the model was reconstructing bytes it
could not see. Handing it prototype.html removes both problems — and collapses the three
reply modes to one question: did the file change?
"""
import os
import tempfile

_tmp = tempfile.mkdtemp()
os.environ.setdefault("FACTORY_DB_URL", f"sqlite:///{_tmp}/test.db")
os.environ["FACTORY_UPLOADS"] = f"{_tmp}/uploads"

from pathlib import Path  # noqa: E402

import pytest  # noqa: E402

from app import agent_brain, settings  # noqa: E402
from app.agent_brain import PROTOTYPE_FILE, AgentBrain  # noqa: E402
from app.agent_exec import AgentResult  # noqa: E402
from app.models import Request  # noqa: E402

SEED = "<!doctype html><html><body><h1 data-pid='t'>Old</h1></body></html>"
BUILT = "<!doctype html><html><body><h1 data-pid='t'>New</h1></body></html>"


def _req() -> Request:
    return Request(ref="REQ-PF", title="Shift swap", description="d", type="new")


@pytest.fixture
def agent(monkeypatch):
    """Stand in for the CLI: record how it was invoked, and let each test decide what
    the agent leaves in the working directory."""
    seen = {}

    def fake_run_agent(prompt, **kw):
        seen.update(kw)
        seen["prompt"] = prompt
        target = Path(kw["cwd"]) / PROTOTYPE_FILE
        seen["seeded"] = target.read_text() if target.exists() else None
        writes = seen.get("writes")
        if writes is not None:
            target.write_text(writes)
        return AgentResult(ok=True, text=seen.get("reply", "Built the screen."))

    monkeypatch.setattr(agent_brain, "run_agent", fake_run_agent)
    return seen


# ── the working directory is the build directory ──

def test_first_draft_reads_back_the_file_the_agent_wrote(agent):
    agent["writes"] = BUILT
    result = AgentBrain().generate_prototype(_req())
    assert result["mode"] == "rewrite"
    assert result["html"] == BUILT
    assert result["note"] == "Built the screen."
    assert agent["seeded"] is None  # nothing to seed on a first draft


def test_an_edit_turn_seeds_the_current_document(agent):
    agent["writes"] = BUILT
    result = AgentBrain().generate_prototype(_req(), instruction="rename it", current_html=SEED)
    assert agent["seeded"] == SEED  # the agent found the real document on disk
    assert result["html"] == BUILT


def test_the_document_is_no_longer_sent_in_the_edit_prompt(agent):
    """The whole point: the mock stops making a round trip through the prompt."""
    agent["writes"] = BUILT
    AgentBrain().generate_prototype(_req(), instruction="rename it", current_html=SEED)
    assert SEED not in agent["prompt"]
    assert PROTOTYPE_FILE in agent["prompt"]


# ── what "no change" means ──

def test_an_untouched_file_on_an_edit_turn_is_a_chat_answer(agent):
    """The agent answered a question instead of changing anything — not a new revision."""
    agent["writes"] = None  # leaves the seed exactly as found
    agent["reply"] = "The table already sorts by date."
    result = AgentBrain().generate_prototype(_req(), instruction="does it sort?", current_html=SEED)
    assert result["mode"] == "chat"
    assert result["html"] is None
    assert result["note"] == "The table already sorts by date."


def test_a_rewritten_but_identical_file_is_not_a_revision(agent):
    agent["writes"] = SEED
    result = AgentBrain().generate_prototype(_req(), instruction="tidy up", current_html=SEED)
    assert result["mode"] == "chat" and result["html"] is None


def test_no_file_on_a_first_draft_falls_back_to_the_scripted_floor(agent):
    """Nothing written with no document to fall back on is a failed build, not a chat."""
    agent["writes"] = None
    result = AgentBrain().generate_prototype(_req())
    assert result["mode"] == "rewrite"
    assert result["html"] and "<!doctype html>" in result["html"].lower()  # scripted floor


# ── the sandbox the build runs in ──

def test_the_builder_gets_an_editor_and_no_shell(agent):
    agent["writes"] = BUILT
    AgentBrain().generate_prototype(_req())
    assert agent["allow_edits"] is True
    assert agent["allow_bash"] is False  # its cwd holds untrusted uploads


def test_narration_is_streamed_through(agent):
    agent["writes"] = BUILT
    chunks: list[str] = []
    AgentBrain().generate_prototype(_req(), on_delta=chunks.append)
    assert agent["on_delta"] is not None


# ── routing ──

def test_the_api_brain_delegates_prototypes_to_the_cli(agent, monkeypatch):
    """The API brain is faster everywhere else, but it has no filesystem — it can only
    rebuild the document by retyping it."""
    from app.brain_api import ApiBrain

    monkeypatch.setattr(settings, "PROTOTYPE_VIA", "cli")
    agent["writes"] = BUILT
    result = ApiBrain().generate_prototype(_req())
    assert result["html"] == BUILT
    assert agent["allow_edits"] is True  # went through the file-based CLI path


# ── the reply is prose, whatever the model does with it ──

def test_a_stray_marker_or_fence_never_reaches_the_reader(agent):
    agent["writes"] = BUILT
    agent["reply"] = "Added the filter row.\n===PROTO===\n```html\n<html></html>\n```"
    result = AgentBrain().generate_prototype(_req(), instruction="add filters", current_html=SEED)
    assert result["note"] == "Added the filter row."
    assert "```" not in result["note"] and "PROTO" not in result["note"]
