"""The one place the Claude Code CLI is invoked (ADR 0011).

Everything Claude-shaped goes through `run_claude` so tests can inject a fake
executor and the rest of the app never touches subprocess.
"""
import json
import logging
import os
import signal
import subprocess
from dataclasses import dataclass

from . import settings

CLAUDE_BIN = settings.CLAUDE_BIN
CLAUDE_MODEL = settings.CLAUDE_MODEL

log = logging.getLogger("factory.claude")


def brain_mode() -> str:
    return os.environ.get("FACTORY_BRAIN", "scripted")


def runner_mode() -> str:
    return os.environ.get("FACTORY_RUNNER", "sim")


@dataclass
class ClaudeResult:
    ok: bool
    text: str
    error: str = ""


def run_claude(prompt: str, *, cwd: str | None = None, allow_edits: bool = False,
               timeout: int = 300, max_turns: int = 25) -> ClaudeResult:
    """Run Claude Code headless; returns its final text. Bounded autonomy: turn cap + timeout."""
    cmd = [
        CLAUDE_BIN, "-p", prompt,
        "--output-format", "json",
        "--model", CLAUDE_MODEL,
        "--max-turns", str(max_turns),
        "--permission-mode", "bypassPermissions" if allow_edits else "default",
    ]
    if not allow_edits:
        cmd += ["--disallowed-tools", "Edit,Write,NotebookEdit,Bash"]
    try:
        # own session so a timeout can kill the WHOLE tree — the CLI spawns its
        # own bash/pytest children, and killing only the parent leaves orphans
        # holding the pipes open (the timeout would not actually bound the stage)
        proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, start_new_session=True)
    except FileNotFoundError:
        return ClaudeResult(ok=False, text="", error="claude CLI not found")
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)  # session leader ⇒ pgid == pid
        except ProcessLookupError:
            pass
        proc.communicate()  # reap; pipes close once the group is dead
        log.error("claude stage timed out after %ss — process group %s killed", timeout, proc.pid)
        return ClaudeResult(ok=False, text="", error=f"stage exceeded its {timeout}s bound")
    if proc.returncode != 0:
        log.error("claude exited rc=%s\nstderr: %s\nstdout: %s", proc.returncode, err, out)
        return ClaudeResult(ok=False, text=out, error=(err or out)[-500:])
    try:
        payload = json.loads(out)
        return ClaudeResult(ok=True, text=payload.get("result", ""))
    except (json.JSONDecodeError, AttributeError):
        return ClaudeResult(ok=True, text=out)


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
