# Real claude-CLI Intake Interview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the intake interview (Clarify step) and draft spec into real, AI-generated output via the `claude` CLI, running the brain from a clean directory so it is fast and uncontaminated by this repo's context.

**Architecture:** The ADR 0007 brain seam and ADR 0011 claude runtime already exist; `AgentBrain` (behind `FACTORY_BRAIN=agent`) asks the model per-question and drafts the spec, falling back to the scripted brain on any failure. Two changes: (1) a one-line-scope code fix so the brain always runs `claude` in a throwaway empty cwd instead of inheriting the repo root, and (2) enabling the agent brain + claude CLI + sonnet-5 in the untracked preview `api` launch config. The rest is end-to-end verification through the real UI.

**Tech Stack:** Python 3.13 / FastAPI (single uvicorn worker), SQLite, pytest; Angular intake app (preview-managed dev server); `claude` CLI headless (`claude -p --output-format json`).

**Spec:** [docs/superpowers/specs/2026-07-05-real-claude-cli-intake-interview-design.md](../specs/2026-07-05-real-claude-cli-intake-interview-design.md)

## Global Constraints

- **Scope:** Stage 1 intake only. Do NOT touch the build runner — it stays `FACTORY_RUNNER=sim`.
- **Committed default unchanged:** The Taskfile `dev` default stays scripted/codex. Only the untracked `.claude/launch.json` turns the real brain on.
- **Single uvicorn worker only** — do not add workers/replicas (the tick loop and pipeline threads assume one process).
- **Never UPDATE or DELETE `progress_event` rows** — append-only (ADR 0008). Not touched by this plan; do not introduce it.
- **Commits (user standing rule):** Do NOT run `git commit` or `git push`. The commit step in each task marks the logical grouping and lists the exact files, but the user commits manually. Stage nothing automatically.
- **Model:** `FACTORY_CLAUDE_MODEL=claude-sonnet-5` (never Haiku; user-facing text needs taste ≥ 7).
- **Work on the current `main` working tree** (which already carries related uncommitted intake work); do NOT create a worktree.
- `make verify` must stay green (lint + pytest + vitest + Angular build + smoke).

---

### Task 1: Run the intake brain in a clean, empty cwd

**Files:**
- Modify: `api/app/agent_brain.py` (add `import tempfile`; rewrite `_run_with_attachments`, lines ~41-53)
- Test: `api/tests/test_agent_brain_attachments.py` (add one test, matching the existing style in that file)

**Interfaces:**
- Consumes: `app.agent_brain.run_agent` (monkeypatched in tests), `app.agent_exec.AgentResult`, `app.models.Request`, `build_workdir` (returns `None` when a request has no attachments).
- Produces: `_run_with_attachments(req, prompt, *, timeout) -> AgentResult` — unchanged signature; now always passes a real, existing `cwd` (a throwaway empty dir when there are no attachments) to `run_agent`, and removes that dir after the call. `AgentBrain.next_question` / `draft_spec` call sites are untouched.

- [ ] **Step 1: Write the failing test**

Add to `api/tests/test_agent_brain_attachments.py` (the file already sets `FACTORY_DB_URL`, defines the `db` fixture, and imports `os`, `tempfile`):

```python
def test_brain_runs_in_clean_empty_cwd_without_attachments(db, monkeypatch):
    # a request with NO attachments must still run claude in a throwaway empty
    # dir (never the repo root / cwd=None), so no CLAUDE.md/skills get loaded
    r = Request(ref="REQ-7778", title="Add export", description="want excel", type="enh")
    db.add(r)
    db.commit()
    db.refresh(r)

    seen = {}

    def fake_run_agent(prompt, **kw):
        cwd = kw.get("cwd")
        seen["cwd"] = cwd
        seen["is_dir"] = bool(cwd) and os.path.isdir(cwd)
        seen["empty"] = seen["is_dir"] and os.listdir(cwd) == []
        from app.agent_exec import AgentResult
        return AgentResult(ok=True, text='{"question":"How often?","sub":null,"options":null}')

    monkeypatch.setattr("app.agent_brain.run_agent", fake_run_agent)
    from app.agent_brain import AgentBrain

    AgentBrain().next_question(r)
    assert seen["cwd"] is not None            # not the repo root (was cwd=None)
    assert seen["is_dir"] and seen["empty"]   # a real, empty scratch dir
    assert os.path.isdir(seen["cwd"]) is False  # cleaned up after the call
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_agent_brain_attachments.py::test_brain_runs_in_clean_empty_cwd_without_attachments -v`
Expected: FAIL on `assert seen["cwd"] is not None` (current code passes `cwd=None` when there are no attachments).

- [ ] **Step 3: Add the `tempfile` import**

In `api/app/agent_brain.py`, the imports currently include `import shutil` (line 7) but not `tempfile`. Add it directly under `import shutil`:

```python
import shutil
import tempfile
```

- [ ] **Step 4: Rewrite `_run_with_attachments` to always use a real cwd**

Replace the existing function (currently lines ~41-53) with:

```python
def _run_with_attachments(req: Request, prompt: str, *, timeout: int) -> AgentResult:
    """Run the agent with the Request's attachments in a throwaway working dir
    (ADR 0022). Images go to codex --image. When there are no attachments we
    still hand the CLI a throwaway EMPTY dir (outside the repo) so it does not
    discover this repo's CLAUDE.md/skills — that overhead ~doubled latency and
    tripled cost (spec 2026-07-05). Every temp dir is removed afterwards."""
    try:
        wd = build_workdir(req)
    except Exception:
        wd = None  # storage hiccup must never block the interview (enrichment, never a blocker)
    scratch = None
    try:
        if wd:
            cwd, images = wd[0], wd[1][: settings.ATTACH_MAX_IMAGES]
        else:
            scratch = tempfile.mkdtemp(prefix="sf-brain-")
            cwd, images = scratch, []
        return run_agent(prompt, timeout=timeout, cwd=cwd, images=images)
    finally:
        if wd:
            shutil.rmtree(wd[0], ignore_errors=True)
        if scratch:
            shutil.rmtree(scratch, ignore_errors=True)
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `cd api && uv run pytest tests/test_agent_brain_attachments.py::test_brain_runs_in_clean_empty_cwd_without_attachments -v`
Expected: PASS

- [ ] **Step 6: Run the full brain/attachment suites to confirm no regression**

Run: `cd api && uv run pytest tests/test_agent_brain_attachments.py tests/test_attachments.py tests/test_agent_exec.py -q`
Expected: all pass (the existing `test_draft_spec_passes_workdir_and_images` still holds — the attachment path is unchanged).

- [ ] **Step 7: Commit (logical grouping — user commits manually; DO NOT run git commit)**

Files in this commit:
- `api/app/agent_brain.py`
- `api/tests/test_agent_brain_attachments.py`

Suggested message: `fix(intake): run the claude brain in a clean empty cwd (no repo CLAUDE.md/skills)`

---

### Task 2: Enable the claude interview brain in the preview `api` config

**Files:**
- Modify: `.claude/launch.json` (untracked) — the `api` configuration's `runtimeArgs`

**Interfaces:**
- Consumes: `agent_exec.brain_mode()` reads `FACTORY_BRAIN`, `agent_cli()` reads `FACTORY_CLI`, `settings.CLAUDE_MODEL` reads `FACTORY_CLAUDE_MODEL`.
- Produces: a running API where `GET /api/health` returns `{"brain": "agent", "cli": "claude", "runner": "sim", ...}`.

- [ ] **Step 1: Add the env vars to the `api` launch config**

In `.claude/launch.json`, the `api` configuration runs via `env` (`runtimeExecutable: "env"`) with `runtimeArgs` starting `["SIM_INTERVAL=8", "uv", "run", "--directory", "api", "uvicorn", ...]`. Add the three env assignments immediately after `"SIM_INTERVAL=8"` so they precede the `uv` command:

```json
"runtimeArgs": [
  "SIM_INTERVAL=8",
  "FACTORY_BRAIN=agent",
  "FACTORY_CLI=claude",
  "FACTORY_CLAUDE_MODEL=claude-sonnet-5",
  "uv",
  "run",
  "--directory",
  "api",
  "uvicorn",
  "app.main:app",
  "--port",
  "8000",
  "--reload"
]
```

(Leave the other configs — `intake`, `mockup`, worktree variants — untouched.)

- [ ] **Step 2: Restart the API via the preview manager**

Stop the running `api` preview server if up, then start it fresh so it picks up the new env. Wait until `GET http://localhost:8000/api/apps` returns 200.

- [ ] **Step 3: Verify the brain mode is live**

Run: `curl -s http://localhost:8000/api/health`
Expected JSON includes: `"brain": "agent"`, `"cli": "claude"`, `"runner": "sim"`, `"db": "ok"`.
If `brain` is still `scripted`, the env did not take — recheck the launch config ordering (env assignments must come before `uv`).

- [ ] **Step 4: No commit** — `.claude/launch.json` is untracked by design (keeps the committed default scripted). Nothing to stage.

---

### Task 3: End-to-end verification through the real UI

**Files:** none (verification only). Uses the running preview `intake` (4201) + `api` (8000) servers and the browser preview tools.

**Interfaces:**
- Consumes: the enabled agent brain from Tasks 1-2; the intake app's Describe → Clarify → Review flow.
- Produces: screenshots + a written confirmation that real AI questions and a real AI-drafted spec render, and that the fallback still works.

- [ ] **Step 1: Ensure both servers are running**

Start the preview `intake` (port 4201) and `api` (port 8000) servers if not up. Confirm the intake app renders at `/submit/new`.

- [ ] **Step 2: Submit a fresh request through Describe**

In the browser preview, fill the Describe step: type = Enhancement, an app name, a description distinctive enough that a scripted question would be obviously generic (e.g. "Let planners bulk-reassign overdue maintenance jobs from one screen"), reach + impact, then Continue. Confirm navigation to `/submit/:id/interview`.

- [ ] **Step 3: Confirm the Clarify question is AI-generated (not scripted)**

On the Clarify step, wait through the "reading your answer" indicator (~10 s). Confirm the first question is specific to the description above — NOT one of the scripted lines (`"In a sentence, what's slow or painful about this today?"` etc. from `SCRIPTS["enh"]` in `api/app/interview.py`). If option chips appear, confirm they read as model-generated. Screenshot it (light).

- [ ] **Step 4: Answer through the interview**

Answer / pick options for each question to the end (`MAX_QUESTIONS = 3`). Confirm each follow-up adapts to the prior answer. Then continue to Review.

- [ ] **Step 5: Confirm the Review spec is AI-drafted**

On the Review step, confirm the spec shows requirement lines with provenance tags (`request` / `Q1`…) and at least one explicit assumption plus the open-note — and that the wording reflects what was actually said (not the templated `"Deliver: <title>."` scripted structure from `ScriptedBrain.draft_spec`). Screenshot it (light + dark).

- [ ] **Step 6: Verify graceful fallback to scripted**

Temporarily break the CLI: in `.claude/launch.json`, change the api config to add `CLAUDE_BIN=claude-does-not-exist` (before `uv`), restart the api server. Submit another request and confirm the Clarify step STILL returns a question (the scripted one) with no user-visible error — proving the fallback. Then remove `CLAUDE_BIN` and restart so the real brain is active again. Confirm `GET /api/health` shows `brain: agent` again.

- [ ] **Step 7: Confirm the test suite is green**

Run: `make verify`
Expected: lint + pytest + vitest + Angular build + smoke all pass. (The change is env-gated; existing tests run the scripted brain / injected fake executor, so they are unaffected.)

- [ ] **Step 8: Report** — summarize to the user: which model ran, sample AI question + spec (with screenshots), measured per-question latency, and that fallback held. No commit (verification only).

---

## Notes for the executor

- The API is single-worker; the interview endpoints are sync (FastAPI threadpool), so a ~10 s `claude` call does not stall the event loop or the tick-loop thread. Do not "optimize" by making them `async` — that would move the blocking call onto the event loop.
- Do not add a real API-key path or bypass the CLI; the whole point of ADR 0011 is that the CLI is the single seam.
- If `claude -p` prompts for auth or a trust dialog when spawned by the API, that is an environment problem (the CLI must be pre-authenticated for the user running the server) — report it; do not work around it by disabling permissions globally.
