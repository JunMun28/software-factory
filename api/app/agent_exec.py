"""The one place an agent CLI is invoked (ADR 0011, 0021, 0024).

Everything agent-shaped goes through `run_agent` so tests can inject a fake
executor and the rest of the app never touches subprocess. Three CLIs sit behind
the same call, switched per call with FACTORY_CLI:

  opencode — (default) `opencode run --format json`; the no-edits contract is
         enforced by a factory-owned config (edit/bash denied) pointed at via
         OPENCODE_CONFIG, never the operator's global agents. No turn cap, so the
         wall-clock timeout is its only autonomy bound (ADR 0024).
  codex  — `codex exec`; the no-edits contract is enforced by codex's OS sandbox
         (read-only vs workspace-write). It too has NO turn cap.
  claude — `claude -p`; no-edits enforced by a tool disallow list, and
         --max-turns caps it on top of the timeout.
"""
import json
import logging
import os
import re
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
OPENCODE_BIN = settings.OPENCODE_BIN
OPENCODE_MODEL = settings.OPENCODE_MODEL

log = logging.getLogger("factory.agent")


def brain_mode() -> str:
    return os.environ.get("FACTORY_BRAIN", "scripted")


def runner_mode() -> str:
    return os.environ.get("FACTORY_RUNNER", "sim")


def agent_cli() -> str:
    """Which CLI drives the real brain/runner: opencode (default), codex, or claude."""
    return os.environ.get("FACTORY_CLI", "opencode")


@dataclass
class AgentResult:
    ok: bool
    text: str
    error: str = ""


def _claude_cmd(prompt: str, *, allow_edits: bool, max_turns: int, model: str | None = None) -> list[str]:
    cmd = [
        CLAUDE_BIN, "-p", prompt,
        "--output-format", "json",
        "--model", model or CLAUDE_MODEL,
        "--max-turns", str(max_turns),
        "--permission-mode", "bypassPermissions" if allow_edits else "default",
    ]
    if not allow_edits:
        # Read-only path = the intake brain (interview + spec), which runs in a
        # throwaway empty cwd. --safe-mode drops the host's Claude Code skills /
        # hooks / CLAUDE.md / MCP: without it the model burned extended-thinking
        # deliberating "should I invoke a skill?" before ever addressing the
        # request (~40% of the call's wall-clock, measured), and none of it is
        # relevant to a scoped intake question. Model, built-in tools and auth
        # still work. FACTORY_INTERVIEW_EFFORT (off by default) is the speed/quality
        # dial for the reasoning budget.
        cmd += ["--safe-mode", "--disallowed-tools", "Edit,Write,NotebookEdit,Bash"]
        if settings.INTERVIEW_EFFORT:
            cmd += ["--effort", settings.INTERVIEW_EFFORT]
    return cmd


def _codex_cmd(prompt: str, *, allow_edits: bool, last_message: str,
               images: list[str] = (), model: str | None = None) -> list[str]:
    # codex exec has no turn cap — the stage timeout is the autonomy bound
    cmd = [
        CODEX_BIN, "exec",
        "--skip-git-repo-check",  # the brain runs outside a repo; workspaces are throwaway repos
        "--color", "never",
        "--sandbox", "workspace-write" if allow_edits else "read-only",
        "--output-last-message", last_message,
    ]
    codex_model = model or CODEX_MODEL
    if codex_model:
        cmd += ["--model", codex_model]
    for img in images:
        cmd += ["--image", img]  # ADR 0022: image attachments → native vision
    cmd.append(prompt)
    return cmd


# Headless-autonomy directive — the opencode adapter's counterpart to claude's --safe-mode.
# gpt-5.5 via opencode otherwise sometimes answers a stage prompt with a plan and
# "reply OK to proceed", which is fatal in a single-shot `run`: no OK ever comes, the stage
# produces nothing, and the gate escalates. Appended only on the opencode path; the shared
# stage prompts stay CLI-neutral.
_OPENCODE_HEADLESS = (
    "\n\n---\nExecution mode: you are running FULLY HEADLESS in one non-interactive turn. "
    "Do NOT ask for confirmation, do NOT reply with only a plan, do NOT wait for approval. "
    "Perform every required file edit and shell command now, in this turn, then stop."
)


def _opencode_cmd(prompt: str, *, allow_edits: bool, cwd: str | None = None,
                  images: list[str] = (), model: str | None = None) -> list[str]:
    # opencode run streams NDJSON events on stdout; the final message is the text parts.
    # No turn cap (like codex) — the stage timeout is the autonomy bound. The read-only vs
    # write decision is NOT in argv: it rides OPENCODE_CONFIG (set by the runner) so it is a
    # hard, operator-config-independent guarantee. --format json keeps the reply machine-clean.
    cmd = [OPENCODE_BIN, "run", "--format", "json"]
    if cwd:
        # opencode resolves its project dir from --dir, NOT the subprocess cwd (a headless
        # `run` can attach to a server whose dir differs). Without this the stage agent reads
        # the wrong tree entirely — it must be pinned to the per-request workspace.
        cmd += ["--dir", cwd]
    # opencode ids are "provider/model"; a foreign id (a claude/codex model handed in by a
    # brain step) has no "/", so fall back to the configured opencode default rather than
    # feed opencode an id it cannot resolve.
    m = model if (model and "/" in model) else OPENCODE_MODEL
    if m:
        cmd += ["--model", m]
    for img in images:
        cmd += ["--file", img]  # attach image(s) to the message (opencode's file-attach)
    cmd.append(prompt + _OPENCODE_HEADLESS)  # the message rides last, never swallowed by a flag
    return cmd


def _communicate(cmd: list[str], cwd: str | None, timeout: int, env: dict | None = None):
    """Spawn → wait → kill-the-whole-tree on timeout. Returns (rc, out, err);
    rc is None when the binary is missing, 124 on timeout. `env` (opencode's
    OPENCODE_CONFIG) fully replaces the child env when given."""
    try:
        # own session so a timeout can kill the WHOLE tree — the CLI spawns its
        # own bash/pytest children, and killing only the parent leaves orphans
        # holding the pipes open (the timeout would not actually bound the stage)
        proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, start_new_session=True, env=env)
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


def run_agent(prompt: str, *, cwd: str | None = None, allow_edits: bool = False,
               timeout: int = 300, max_turns: int = 25, images: list[str] = (),
               model: str | None = None) -> AgentResult:
    """Run the agent CLI headless; returns its final text. Bounded autonomy:
    timeout always; max_turns additionally caps claude (codex has no turn cap).
    images attach to codex via --image (ADR 0022); the claude path ignores them.
    `model` overrides the CLI's default model for this call (the prototype step runs a
    higher-taste model than the fast interview one); pass a model id matching the active CLI."""
    cli = agent_cli()
    if cli == "claude":
        return _run_claude_cli(prompt, cwd=cwd, allow_edits=allow_edits,
                               timeout=timeout, max_turns=max_turns, model=model)
    if cli == "codex":
        return _run_codex_cli(prompt, cwd=cwd, allow_edits=allow_edits, timeout=timeout,
                              images=images, model=model)
    return _run_opencode_cli(prompt, cwd=cwd, allow_edits=allow_edits, timeout=timeout,
                             images=images, model=model)


def _run_claude_cli(prompt: str, *, cwd: str | None, allow_edits: bool,
                    timeout: int, max_turns: int, model: str | None = None) -> AgentResult:
    cmd = _claude_cmd(prompt, allow_edits=allow_edits, max_turns=max_turns, model=model)
    rc, out, err = _communicate(cmd, cwd, timeout)
    if rc is None:
        return AgentResult(ok=False, text="", error="claude CLI not found")
    if rc == 124:
        return AgentResult(ok=False, text="", error=f"stage exceeded its {timeout}s bound")
    if rc != 0:
        log.error("claude exited rc=%s\nstderr: %s\nstdout: %s",
                  rc, (err or "")[-800:], (out or "")[-800:])
        return AgentResult(ok=False, text=out, error=(err or out)[-500:])
    try:
        payload = json.loads(out)
        return AgentResult(ok=True, text=payload.get("result", ""))
    except (json.JSONDecodeError, AttributeError):
        return AgentResult(ok=True, text=out)


def _run_codex_cli(prompt: str, *, cwd: str | None, allow_edits: bool,
                   timeout: int, images: list[str] = (), model: str | None = None) -> AgentResult:
    # codex streams its whole event log to stdout; the agent's final message —
    # the part the brain/runner actually consume — arrives via -o <file>
    fd, last_path = tempfile.mkstemp(prefix="codex-last-", suffix=".md")
    os.close(fd)
    try:
        cmd = _codex_cmd(prompt, allow_edits=allow_edits, last_message=last_path, images=images, model=model)
        rc, out, err = _communicate(cmd, cwd, timeout)
        if rc is None:
            return AgentResult(ok=False, text="", error="codex CLI not found")
        if rc == 124:
            return AgentResult(ok=False, text="", error=f"stage exceeded its {timeout}s bound")
        if rc != 0:
            log.error("codex exited rc=%s\nstderr: %s\nstdout: %s",
                      rc, (err or "")[-800:], (out or "")[-800:])
            return AgentResult(ok=False, text=out, error=(err or out)[-500:])
        try:
            last = Path(last_path).read_text().strip()
        except OSError:
            last = ""
        return AgentResult(ok=True, text=last or out)
    finally:
        Path(last_path).unlink(missing_ok=True)


def _parse_opencode_json(out: str) -> str:
    """opencode --format json streams one JSON event per line; the agent's final message is
    the concatenation of its text parts. Tolerant of non-JSON noise (banner lines, blanks)."""
    parts: list[str] = []
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "text":
            text = (ev.get("part") or {}).get("text") or ""
            if text:
                parts.append(text)
    return "".join(parts).strip()


def _run_opencode_cli(prompt: str, *, cwd: str | None, allow_edits: bool,
                      timeout: int, images: list[str] = (), model: str | None = None) -> AgentResult:
    cmd = _opencode_cmd(prompt, allow_edits=allow_edits, cwd=cwd, images=images, model=model)
    # OPENCODE_CONFIG is the read-only/write sandbox — a factory file, not the operator's
    # global agents. Passing our own env means the guarantee cannot be weakened by config drift.
    config = settings.OPENCODE_RW_CONFIG if allow_edits else settings.OPENCODE_RO_CONFIG
    env = {**os.environ, "OPENCODE_CONFIG": str(config)}
    rc, out, err = _communicate(cmd, cwd, timeout, env=env)
    if rc is None:
        return AgentResult(ok=False, text="", error="opencode CLI not found")
    if rc == 124:
        return AgentResult(ok=False, text="", error=f"stage exceeded its {timeout}s bound")
    if rc != 0:
        log.error("opencode exited rc=%s\nstderr: %s\nstdout: %s",
                  rc, (err or "")[-800:], (out or "")[-800:])
        return AgentResult(ok=False, text=out, error=(err or out)[-500:])
    return AgentResult(ok=True, text=_parse_opencode_json(out) or out)


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


def extract_html_block(text: str) -> str | None:
    """Pull the first full HTML document out of a model reply — from a fenced ```html … ```
    block (the prototype reply contract), or a bare <!doctype/<html>…</html> span as a
    fallback. Returns None if no plausible document is present."""
    fence = re.search(r"```(?:html)?[^\n]*\n(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if fence:
        doc = fence.group(1).strip()
        if "</html" in doc.lower() or "<body" in doc.lower():
            return doc
    bare = re.search(r"(<!doctype html\b.*?</html\s*>|<html[\s>].*?</html\s*>)",
                     text, re.DOTALL | re.IGNORECASE)
    return bare.group(1).strip() if bare else None
