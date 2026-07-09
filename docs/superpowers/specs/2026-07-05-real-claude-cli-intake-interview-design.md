# Real claude-CLI intake interview — design

**Date:** 2026-07-05
**Status:** approved (design), pending implementation plan
**Scope:** Stage 1 intake only (interview questions + draft spec). The downstream
build pipeline stays simulated (`FACTORY_RUNNER=sim`), out of scope here.

## Problem

The submitter intake flow (Describe → Clarify → Review → Submit) currently runs
the **scripted** brain: the Clarify step asks canned questions from a fixed
`SCRIPTS` table and the draft spec is assembled by templated string logic. We
want the interview to be genuinely AI-driven — real, adaptive follow-up
questions and a real grounded spec — via the `claude` CLI, so the submit form
produces real intake output rather than a scripted demo.

## Key finding: the wiring already exists

This is not a build-from-scratch. The ADR 0007 brain seam and the ADR 0011
claude runtime are already implemented and merely disabled by default:

- `get_brain()` ([api/app/interview.py](../../../api/app/interview.py)) returns
  `AgentBrain` when `FACTORY_BRAIN=agent`, else the `ScriptedBrain`.
- `AgentBrain` ([api/app/agent_brain.py](../../../api/app/agent_brain.py)) already
  asks the model for each follow-up question (with optional answer chips) and
  drafts the grounded spec from the answers; on any failure it calls
  `super().next_question()` / `super().draft_spec()` — graceful degradation to
  the scripted brain.
- `_run_claude_cli` ([api/app/agent_exec.py](../../../api/app/agent_exec.py))
  runs `claude -p <prompt> --output-format json --model <model> --max-turns N
  --permission-mode default --disallowed-tools Edit,Write,NotebookEdit,Bash`,
  parses the JSON envelope's `result`, and enforces a wall-clock timeout.
- The interview endpoints
  ([api/app/routers/requests.py](../../../api/app/routers/requests.py)) call
  `get_brain().next_question()` (generate-once, persisted in
  `pending_question`) and `get_brain().draft_spec()` at submit.

The dev/preview default is `scripted` brain + `codex` CLI, so today the real
path never runs.

## Verified behavior (smoke tests, 2026-07-05)

Ran the exact CLI invocation the code uses, `--model claude-sonnet-5`:

| Run cwd | duration | ttft | cost | input+cache tokens |
|---|---|---|---|---|
| repo root | 17.4 s | 15.9 s | $0.345 | 6.4k + 28.3k |
| clean empty temp dir | 9.9 s | 8.1 s | $0.127 | 6.3k + 7.5k |

The ~21k-token difference is this repo's `CLAUDE.md` + `.claude/skills` being
discovered and loaded when `claude` runs inside the project tree. Stripping it
roughly halves latency and cuts cost ~60% — and stops the factory's intake
reasoning from being polluted by this repo's coding instructions. The residual
~7.5k tokens are the base Claude Code system prompt + the user-global
`~/.claude/CLAUDE.md`, which load regardless of cwd; that is accepted.

## Changes

### 1. Enable the agent brain (config only, untracked)

Add to the preview `api` launch config in `.claude/launch.json` (untracked, so
the committed Taskfile default stays `scripted` for everyone else):

```
FACTORY_BRAIN=agent
FACTORY_CLI=claude
FACTORY_CLAUDE_MODEL=claude-sonnet-5
```

Rationale for sonnet-5: the submitter reads these questions live, so taste
matters (project rule: user-facing needs taste ≥ 7; never Haiku). Sonnet-5
balances taste against the per-turn latency of a form the user waits on. At most
3 questions + 1 spec draft per submission, each a small generation.

### 2. Run the brain in a clean cwd (the one code fix)

In `AgentBrain._run_with_attachments`
([api/app/agent_brain.py](../../../api/app/agent_brain.py)), the no-attachment
path passes `cwd=None`, so `claude` inherits the API process's working directory
(inside the repo) and loads the ~21k tokens of repo context on every call. The
attachment path already runs in a throwaway `tempfile.mkdtemp` dir outside the
repo and so is already clean.

Fix: when there are no attachments, create a throwaway empty temp directory for
`cwd` and remove it in the `finally` block — mirroring the attachment path.

```python
def _run_with_attachments(req, prompt, *, timeout):
    try:
        wd = build_workdir(req)
    except Exception:
        wd = None
    scratch = None
    try:
        if wd:
            cwd, images = wd[0], wd[1][: settings.ATTACH_MAX_IMAGES]
        else:
            scratch = tempfile.mkdtemp(prefix="sf-brain-")  # empty ⇒ no CLAUDE.md/skills
            cwd, images = scratch, []
        return run_agent(prompt, timeout=timeout, cwd=cwd, images=images)
    finally:
        if wd:
            shutil.rmtree(wd[0], ignore_errors=True)
        if scratch:
            shutil.rmtree(scratch, ignore_errors=True)
```

Requires adding `import tempfile` to `agent_brain.py` (currently imports
`shutil` only). No interface change; `next_question` and `draft_spec` call sites
are untouched.

### 3. Unchanged (already correct)

- **Graceful fallback:** CLI missing / non-zero / timeout → scripted question or
  spec. The interview is enrichment, never a blocker (PRD hardening #4).
- **Single-worker safety:** interview/answer/submit endpoints are sync (FastAPI
  threadpool), so a ~10s blocking subprocess does not stall the event loop or
  the tick-loop thread. `current_question` commits *after* the brain call and
  the submit path claims the request *before* the brain call, so no long-held
  SQLite write lock spans a slow CLI call.
- **Frontend:** the Clarify step already shows the "reading your answer" typing
  indicator during `busy()`, covering the wait.

## Verification (the deliverable)

1. Start the API via the preview `api` config with the new env; confirm
   `GET /api/health` reports `brain=agent`, `runner=sim`, `cli=claude`.
2. Drive the real UI: submit a fresh request; confirm the Clarify step shows
   genuinely AI-generated follow-up questions (adaptive to the description, with
   option chips where natural) from sonnet-5; answer them.
3. Confirm the Review step shows an AI-drafted grounded spec: requirement lines
   with provenance tags (`request` / `Q1`…) and at least one explicit
   assumption, plus the open-note.
4. Capture light/dark screenshots of a real interview + spec.
5. Confirm fallback: temporarily point `CLAUDE_BIN` at a missing binary → the
   Clarify step still returns scripted questions (no user-visible error).
6. `make verify` stays green (the change is behind env flags; existing tests use
   the scripted brain / injected fake executor).

## Accepted tradeoffs

- **Latency:** ~10 s per question after the clean-cwd fix; the first question is
  generated lazily when the user lands on Clarify, so there is a ~10 s wait
  behind the typing indicator on that screen.
- **Cost:** ~$0.13 per call ⇒ ~$0.50 per full submission (3 questions + spec),
  bounded by `MAX_QUESTIONS=3`. Fine for internal intake volume.

## Out of scope (YAGNI)

- Flipping the downstream build runner from simulator to real agents.
- Pre-generating the first interview question at submit time to hide the initial
  Clarify wait (possible later optimization).
- Any change to the committed default (Taskfile stays `scripted`).
- Cost/latency tuning beyond the clean-cwd fix (e.g. skipping user-global
  config).
