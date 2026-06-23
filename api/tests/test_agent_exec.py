"""Agent-CLI seam tests (ADR 0011) — argv shape per CLI and missing-binary
handling. No real CLI is ever spawned: builders are pure, and the dispatch
tests point at binaries that do not exist."""
from app import claude_exec
from app.claude_exec import _claude_cmd, _codex_cmd, run_claude


def test_default_cli_is_codex(monkeypatch):
    monkeypatch.delenv("FACTORY_CLI", raising=False)
    assert claude_exec.agent_cli() == "codex"


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


def test_missing_codex_binary_fails_closed(monkeypatch):
    monkeypatch.setenv("FACTORY_CLI", "codex")
    monkeypatch.setattr(claude_exec, "CODEX_BIN", "definitely-not-a-binary-9f2")
    res = run_claude("hello")
    assert res.ok is False and "codex CLI not found" in res.error


def test_missing_claude_binary_fails_closed(monkeypatch):
    monkeypatch.setenv("FACTORY_CLI", "claude")
    monkeypatch.setattr(claude_exec, "CLAUDE_BIN", "definitely-not-a-binary-9f2")
    res = run_claude("hello")
    assert res.ok is False and "claude CLI not found" in res.error
