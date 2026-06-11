"""The one place an agent CLI is invoked (ADR 0011).

Everything agent-shaped goes through `run_claude` so tests can inject a fake
executor and the rest of the app never touches subprocess. Two CLIs sit behind
the same call, switched per call with FACTORY_CLI:

  codex  (default, for now) — `codex exec`; the no-edits contract is enforced
         by codex's OS sandbox (read-only vs workspace-write)
  claude — `claude -p`; no-edits enforced by a tool disallow list
"""
import json
import logging
import os
import signal
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import settings

CLAUDE_BIN = settings.CLAUDE_BIN
CLAUDE_MODEL = settings.CLAUDE_MODEL
CODEX_BIN = settings.CODEX_BIN
CODEX_MODEL = settings.CODEX_MODEL

log = logging.getLogger("factory.claude")


def brain_mode() -> str:
    return os.environ.get("FACTORY_BRAIN", "scripted")


def runner_mode() -> str:
    return os.environ.get("FACTORY_RUNNER", "sim")


def agent_cli() -> str:
    """Which CLI drives the real brain/runner: codex (default, for now) or claude."""
    return os.environ.get("FACTORY_CLI", "codex")


@dataclass
class ClaudeResult:
    ok: bool
    text: str
    error: str = ""


def _claude_cmd(prompt: str, *, allow_edits: bool, max_turns: int) -> list[str]:
    cmd = [
        CLAUDE_BIN, "-p", prompt,
        "--output-format", "json",
        "--model", CLAUDE_MODEL,
        "--max-turns", str(max_turns),
        "--permission-mode", "bypassPermissions" if allow_edits else "default",
    ]
    if not allow_edits:
        cmd += ["--disallowed-tools", "Edit,Write,NotebookEdit,Bash"]
    return cmd


def _codex_cmd(prompt: str, *, allow_edits: bool, last_message: str) -> list[str]:
    # codex exec has no turn cap — the stage timeout is the autonomy bound
    cmd = [
        CODEX_BIN, "exec",
        "--skip-git-repo-check",  # the brain runs outside a repo; workspaces are throwaway repos
        "--color", "never",
        "--sandbox", "workspace-write" if allow_edits else "read-only",
        "--output-last-message", last_message,
    ]
    if CODEX_MODEL:
        cmd += ["--model", CODEX_MODEL]
    cmd.append(prompt)
    return cmd


def _communicate(cmd: list[str], cwd: str | None, timeout: int):
    """Spawn → wait → kill-the-whole-tree on timeout. Returns (rc, out, err);
    rc is None when the binary is missing, 124 on timeout."""
    try:
        # own session so a timeout can kill the WHOLE tree — the CLI spawns its
        # own bash/pytest children, and killing only the parent leaves orphans
        # holding the pipes open (the timeout would not actually bound the stage)
        proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, start_new_session=True)
    except FileNotFoundError:
        return None, "", ""
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)  # session leader ⇒ pgid == pid
        except ProcessLookupError:
            pass
        proc.communicate()  # reap; pipes close once the group is dead
        log.error("agent stage timed out after %ss — process group %s killed", timeout, proc.pid)
        return 124, "", ""
    return proc.returncode, out, err


def run_claude(prompt: str, *, cwd: str | None = None, allow_edits: bool = False,
               timeout: int = 300, max_turns: int = 25) -> ClaudeResult:
    """Run the agent CLI headless; returns its final text. Bounded autonomy:
    timeout always; max_turns additionally caps claude (codex has no turn cap)."""
    if agent_cli() == "claude":
        return _run_claude_cli(prompt, cwd=cwd, allow_edits=allow_edits,
                               timeout=timeout, max_turns=max_turns)
    return _run_codex_cli(prompt, cwd=cwd, allow_edits=allow_edits, timeout=timeout)


def _run_claude_cli(prompt: str, *, cwd: str | None, allow_edits: bool,
                    timeout: int, max_turns: int) -> ClaudeResult:
    cmd = _claude_cmd(prompt, allow_edits=allow_edits, max_turns=max_turns)
    rc, out, err = _communicate(cmd, cwd, timeout)
    if rc is None:
        return ClaudeResult(ok=False, text="", error="claude CLI not found")
    if rc == 124:
        return ClaudeResult(ok=False, text="", error=f"stage exceeded its {timeout}s bound")
    if rc != 0:
        log.error("claude exited rc=%s\nstderr: %s\nstdout: %s",
                  rc, (err or "")[-800:], (out or "")[-800:])
        return ClaudeResult(ok=False, text=out, error=(err or out)[-500:])
    try:
        payload = json.loads(out)
        return ClaudeResult(ok=True, text=payload.get("result", ""))
    except (json.JSONDecodeError, AttributeError):
        return ClaudeResult(ok=True, text=out)


def _run_codex_cli(prompt: str, *, cwd: str | None, allow_edits: bool,
                   timeout: int) -> ClaudeResult:
    # codex streams its whole event log to stdout; the agent's final message —
    # the part the brain/runner actually consume — arrives via -o <file>
    fd, last_path = tempfile.mkstemp(prefix="codex-last-", suffix=".md")
    os.close(fd)
    try:
        cmd = _codex_cmd(prompt, allow_edits=allow_edits, last_message=last_path)
        rc, out, err = _communicate(cmd, cwd, timeout)
        if rc is None:
            return ClaudeResult(ok=False, text="", error="codex CLI not found")
        if rc == 124:
            return ClaudeResult(ok=False, text="", error=f"stage exceeded its {timeout}s bound")
        if rc != 0:
            log.error("codex exited rc=%s\nstderr: %s\nstdout: %s",
                      rc, (err or "")[-800:], (out or "")[-800:])
            return ClaudeResult(ok=False, text=out, error=(err or out)[-500:])
        try:
            last = Path(last_path).read_text().strip()
        except OSError:
            last = ""
        return ClaudeResult(ok=True, text=last or out)
    finally:
        Path(last_path).unlink(missing_ok=True)


def extract_json(text: str) -> dict | list | None:
    """Pull the first JSON object/array out of a model reply (handles ``` fences)."""
    s = text.strip()
    if "```" in s:
        for chunk in s.split("```"):
            chunk = chunk.strip().removeprefix("json").strip()
            if chunk.startswith(("{", "[")):
                s = chunk
                break
    start = min((i for i in (s.find("{"), s.find("[")) if i >= 0), default=-1)
    if start < 0:
        return None
    for end in range(len(s), start, -1):
        try:
            return json.loads(s[start:end])
        except json.JSONDecodeError:
            continue
    return None
