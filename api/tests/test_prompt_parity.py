"""The two runners share ONE prompt store (docker/sf-agent/prompts/*.md).

The sf-agent image bakes these files for pod runs; the in-process AgentRunner
reads them through harness.stage_prompt. These tests pin that contract so the
stores can never silently drift again, and pin the HARNESS_VERSION lineage
digest (self-harness analysis 2026-07-16)."""
import shutil

import pytest
from helpers import approved_request
from test_agent_runner import honest_executor

from app import agent_runner, harness, settings
from app.agent_exec import AgentResult
from app.agent_runner import AgentRunner
from app.db import SessionLocal
from app.models import Request

HEADLESS = "You are headless: act now, in this one turn, and never ask for confirmation."


@pytest.fixture()
def ws_root(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_runner, "WORKSPACES", tmp_path / "workspaces")
    return tmp_path


def test_prompt_files_exist_and_feed_the_loader():
    for stage in harness.STAGES:
        path = settings.PROMPTS / f"{stage}.md"
        assert path.is_file(), f"missing prompt store file {path}"
        text = path.read_text().strip()
        assert text, f"{path} is empty"
        assert HEADLESS in text, f"{path} lost the headless directive"
        assert harness.stage_prompt(stage) == text


def test_unknown_stage_is_a_hard_error():
    with pytest.raises(KeyError):
        harness.stage_prompt("deploy")


def test_agent_runner_builds_every_stage_prompt_from_the_shared_store(client, ws_root):
    d = approved_request(
        client, title="Prompt parity",
        description="Add a monthly_export function that returns the export format name.",
    )
    prompts: list[str] = []

    def recording_executor(prompt: str, **kwargs) -> AgentResult:
        prompts.append(prompt)
        return honest_executor(prompt, **kwargs)

    AgentRunner(executor=recording_executor).run_pipeline(d["id"])

    assert len(prompts) == 4
    for stage, prompt in zip(harness.STAGES, prompts, strict=True):
        base = harness.stage_prompt(stage)
        assert prompt.startswith(base), (
            f"{stage} prompt no longer starts with docker/sf-agent/prompts/{stage}.md"
        )
    # the in-process review contract (REVIEW.md artifact) is appended, not baked
    # into the shared base the pod path consumes verbatim
    assert "REVIEW.md" in prompts[3]
    assert "REVIEW.md" not in harness.stage_prompt("review")


def test_harness_version_is_a_stable_12_hex_content_digest(tmp_path):
    assert len(harness.HARNESS_VERSION) == 12
    assert all(c in "0123456789abcdef" for c in harness.HARNESS_VERSION)

    copy = tmp_path / "prompts"
    shutil.copytree(settings.PROMPTS, copy)
    assert harness.compute_version(copy) == harness.HARNESS_VERSION  # same content, same version

    (copy / "green.md").write_text((copy / "green.md").read_text() + "\nBe careful.\n")
    assert harness.compute_version(copy) != harness.HARNESS_VERSION  # any prompt edit bumps it


def test_pending_feedback_is_injected_once_then_cleared(client, ws_root):
    d = approved_request(
        client, title="Feedback consumption",
        description="Add a monthly_export function that returns the export format name.",
    )
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        req.pending_feedback = "The export drops the header row — keep it."
        prompt, _ = AgentRunner()._stage_prompt(db, req, "BASE")
        assert prompt.startswith("BASE")
        assert "The export drops the header row" in prompt
        assert req.pending_feedback is None  # consumed by exactly one stage run
