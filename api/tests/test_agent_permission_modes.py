"""Three permission modes, and why the middle one exists.

The prototype step needs the agent to WRITE a file and nothing more. Its working
directory holds files the submitter uploaded, whose text is also in the prompt — so
"run this command" in a spreadsheet cell is a live injection vector, and denying the
shell is what makes it inert. Read-only stays the default; full write stays reserved
for pipeline stages, which operate on factory-owned git workspaces.

Verified live (opencode 1.17.18, 2026-07-22): under factory-prototype.json the agent
wrote a file successfully and read a .csv, with bash denied throughout.
"""
import json

import pytest

from app import agent_exec, settings


@pytest.fixture
def spawn(monkeypatch):
    """Capture the argv and env of the CLI we would have spawned."""
    seen = {}

    def fake_communicate(cmd, cwd, timeout, env=None, **kwargs):
        seen["cmd"] = cmd
        seen["env"] = env
        seen["kwargs"] = kwargs
        return 0, "{}", ""

    monkeypatch.setattr(agent_exec, "_communicate", fake_communicate)
    return seen


def _config(seen) -> str:
    return seen["env"]["OPENCODE_CONFIG"]


# ── opencode: the config file IS the guarantee ──

def test_read_only_is_the_default(spawn, monkeypatch):
    monkeypatch.setattr(agent_exec, "agent_cli", lambda: "opencode")
    agent_exec.run_agent("go", cwd="/tmp/x")
    assert _config(spawn) == str(settings.OPENCODE_RO_CONFIG)


def test_edits_without_bash_selects_the_prototype_sandbox(spawn, monkeypatch):
    monkeypatch.setattr(agent_exec, "agent_cli", lambda: "opencode")
    agent_exec.run_agent("go", cwd="/tmp/x", allow_edits=True, allow_bash=False)
    assert _config(spawn) == str(settings.OPENCODE_PROTO_CONFIG)


def test_bash_defaults_to_follow_edits_so_existing_callers_are_unchanged(spawn, monkeypatch):
    """agent_runner passes allow_edits=True and nothing else; it must still get RW."""
    monkeypatch.setattr(agent_exec, "agent_cli", lambda: "opencode")
    agent_exec.run_agent("go", cwd="/tmp/x", allow_edits=True)
    assert _config(spawn) == str(settings.OPENCODE_RW_CONFIG)


# ── the configs themselves ──

def test_prototype_config_grants_an_editor_and_no_shell():
    perms = json.loads(settings.OPENCODE_PROTO_CONFIG.read_text())["permission"]
    assert perms == {"edit": "allow", "bash": "deny", "webfetch": "deny"}


def test_read_only_config_stays_fully_closed():
    perms = json.loads(settings.OPENCODE_RO_CONFIG.read_text())["permission"]
    assert perms == {"edit": "deny", "bash": "deny", "webfetch": "deny"}


def test_no_config_ever_grants_webfetch():
    """Outbound fetch from an agent holding untrusted upload content is exfiltration."""
    for path in (settings.OPENCODE_RO_CONFIG, settings.OPENCODE_PROTO_CONFIG,
                 settings.OPENCODE_RW_CONFIG):
        assert json.loads(path.read_text())["permission"]["webfetch"] == "deny", path


# ── claude: same guarantee, different flag ──

def test_claude_edit_without_bash_disallows_the_bash_tool(spawn, monkeypatch):
    monkeypatch.setattr(agent_exec, "agent_cli", lambda: "claude")
    agent_exec.run_agent("go", cwd="/tmp/x", allow_edits=True, allow_bash=False)
    cmd = spawn["cmd"]
    assert "--disallowed-tools" in cmd
    assert cmd[cmd.index("--disallowed-tools") + 1] == "Bash"
    assert "bypassPermissions" in cmd  # still allowed to write


def test_claude_full_write_keeps_bash(spawn, monkeypatch):
    monkeypatch.setattr(agent_exec, "agent_cli", lambda: "claude")
    agent_exec.run_agent("go", cwd="/tmp/x", allow_edits=True)
    assert "--disallowed-tools" not in spawn["cmd"]


# ── a clean exit with nothing to show for it ──

def test_empty_reply_from_a_clean_exit_is_logged(spawn, monkeypatch, caplog):
    """The 2026-07-22 failure: a spend-capped model made every CLI call exit 0 with
    zero bytes. Callers fell back to their scripted floors and nothing was logged, so
    the outage was invisible. Control flow is unchanged — only the silence is."""
    monkeypatch.setattr(agent_exec, "agent_cli", lambda: "opencode")
    monkeypatch.setattr(agent_exec, "_communicate", lambda *a, **k: (0, "", ""))
    with caplog.at_level("WARNING"):
        res = agent_exec.run_agent("go", cwd="/tmp/x")
    assert res.ok and res.text == ""  # callers still decide what empty means
    assert "no output" in caplog.text


def test_a_normal_reply_logs_nothing(spawn, monkeypatch, caplog):
    monkeypatch.setattr(agent_exec, "agent_cli", lambda: "opencode")
    monkeypatch.setattr(agent_exec, "_communicate", lambda *a, **k: (0, "a real answer", ""))
    with caplog.at_level("WARNING"):
        agent_exec.run_agent("go", cwd="/tmp/x")
    assert "no output" not in caplog.text
