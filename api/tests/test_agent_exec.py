"""Agent-CLI seam tests (ADR 0011) — argv shape per CLI and missing-binary
handling. No real CLI is ever spawned: builders are pure, and the dispatch
tests point at binaries that do not exist."""
import json

from app import agent_exec, settings
from app.agent_exec import _claude_cmd, _codex_cmd, _opencode_cmd, _parse_opencode_json, run_agent


def test_default_cli_is_opencode(monkeypatch):
    monkeypatch.delenv("FACTORY_CLI", raising=False)
    assert agent_exec.agent_cli() == "opencode"


def test_codex_cmd_sandboxes_instead_of_tool_lists():
    ro = _codex_cmd("p", allow_edits=False, last_message="/tmp/x")
    rw = _codex_cmd("p", allow_edits=True, last_message="/tmp/x")
    assert ro[ro.index("--sandbox") + 1] == "read-only"
    assert rw[rw.index("--sandbox") + 1] == "workspace-write"
    assert ro[-1] == "p"  # the prompt rides last, never swallowed by a flag
    assert "--output-last-message" in ro  # the final message is what the brain consumes


def test_claude_cmd_keeps_tool_disallow_list():
    ro = _claude_cmd("p", allow_edits=False, max_turns=5)
    assert "--disallowed-tools" in ro
    rw = _claude_cmd("p", allow_edits=True, max_turns=5)
    assert "--disallowed-tools" not in rw
    assert rw[rw.index("--permission-mode") + 1] == "bypassPermissions"


def test_codex_cmd_appends_image_flags():
    from app.agent_exec import _codex_cmd

    cmd = _codex_cmd("hi", allow_edits=False, last_message="/tmp/last.md",
                     images=["/tmp/a.png", "/tmp/b.jpg"])
    assert cmd.count("--image") == 2
    ai = cmd.index("--image")
    assert cmd[ai + 1] == "/tmp/a.png"
    assert cmd[-1] == "hi"  # the prompt stays last
    assert "--sandbox" in cmd and cmd[cmd.index("--sandbox") + 1] == "read-only"


def test_opencode_cmd_shape():
    cmd = _opencode_cmd("p", allow_edits=False)
    assert cmd[:2] == [agent_exec.OPENCODE_BIN, "run"]
    assert cmd[cmd.index("--format") + 1] == "json"  # machine-clean reply
    assert cmd[-1].startswith("p")  # the prompt rides last, never swallowed by a flag
    assert "HEADLESS" in cmd[-1]  # adapter appends the single-turn autonomy directive
    # read-only vs write is NOT in argv — it rides OPENCODE_CONFIG (a hard sandbox)
    assert not any(a in ("read-only", "workspace-write", "--sandbox") for a in cmd)


def test_opencode_cmd_pins_workspace_with_dir():
    # headless opencode resolves its project from --dir, not the subprocess cwd — the stage
    # agent must be pinned to the per-request workspace or it reads the wrong tree
    cmd = _opencode_cmd("p", allow_edits=True, cwd="/tmp/ws/req-1")
    assert cmd[cmd.index("--dir") + 1] == "/tmp/ws/req-1"
    assert "--dir" not in _opencode_cmd("p", allow_edits=False)  # omitted when no cwd


def test_opencode_cmd_guards_foreign_model():
    # a claude/codex id (no "provider/") must not be fed to opencode — fall back to the default
    foreign = _opencode_cmd("p", allow_edits=False, model="claude-sonnet-5")
    assert foreign[foreign.index("--model") + 1] == settings.OPENCODE_MODEL
    # a real opencode id passes straight through
    native = _opencode_cmd("p", allow_edits=False, model="anthropic/claude-x")
    assert native[native.index("--model") + 1] == "anthropic/claude-x"


def test_opencode_cmd_attaches_images():
    cmd = _opencode_cmd("hi", allow_edits=False, images=["/tmp/a.png", "/tmp/b.jpg"])
    assert cmd.count("--file") == 2
    assert cmd[cmd.index("--file") + 1] == "/tmp/a.png"
    assert cmd[-1].startswith("hi")  # the prompt stays last


def test_opencode_parses_final_text_from_ndjson():
    stream = "\n".join([
        "some banner noise",
        json.dumps({"type": "step_start", "part": {}}),
        json.dumps({"type": "text", "part": {"text": "PLAN "}}),
        json.dumps({"type": "text", "part": {"text": "ready"}}),
        json.dumps({"type": "step_finish", "part": {"tokens": {}}}),
    ])
    assert _parse_opencode_json(stream) == "PLAN ready"


def test_opencode_configs_are_a_hard_sandbox():
    # the read-only/write guarantee lives in these two files, so assert their contract directly
    ro = json.loads(settings.OPENCODE_RO_CONFIG.read_text())["permission"]
    rw = json.loads(settings.OPENCODE_RW_CONFIG.read_text())["permission"]
    assert ro["edit"] == "deny" and ro["bash"] == "deny"  # no-edits = fail closed
    assert rw["edit"] == "allow" and rw["bash"] == "allow"  # build needs FS + shell
    assert rw["webfetch"] == "deny"  # ...but no network, matching codex workspace-write


def test_missing_opencode_binary_fails_closed(monkeypatch):
    monkeypatch.setenv("FACTORY_CLI", "opencode")
    monkeypatch.setattr(agent_exec, "OPENCODE_BIN", "definitely-not-a-binary-9f2")
    res = run_agent("hello")
    assert res.ok is False and "opencode CLI not found" in res.error


def test_missing_codex_binary_fails_closed(monkeypatch):
    monkeypatch.setenv("FACTORY_CLI", "codex")
    monkeypatch.setattr(agent_exec, "CODEX_BIN", "definitely-not-a-binary-9f2")
    res = run_agent("hello")
    assert res.ok is False and "codex CLI not found" in res.error


def test_missing_claude_binary_fails_closed(monkeypatch):
    monkeypatch.setenv("FACTORY_CLI", "claude")
    monkeypatch.setattr(agent_exec, "CLAUDE_BIN", "definitely-not-a-binary-9f2")
    res = run_agent("hello")
    assert res.ok is False and "claude CLI not found" in res.error
