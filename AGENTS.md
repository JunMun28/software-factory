# AGENTS.md — agent-facing guide to the Software Factory repo

This is the single entry point for any AI agent (or human) starting cold.
It consolidates the operational knowledge that was spread across ADR 0011,
CONTEXT.md, VERIFICATION.md, and four source files.
See [CONTEXT.md](CONTEXT.md) for domain vocabulary and [README.md](README.md)
for the quickstart.

---

## 1. What this repo is

**Software Factory** is an autonomous-but-governed AI pipeline that carries
a unit of work through the full SDLC — requirements → architecture → TDD
implementation → review → deploy — with humans gating the irreversible
boundaries.  The two deterministic seams (brain, runner) let every feature
run offline; the same env vars swap in a real agent CLI when you want it.
Domain language: [CONTEXT.md](CONTEXT.md). Decisions: [docs/adr/](docs/adr/).

---

## 2. Verify any change

Run this before merging anything.  Green = safe.

Orchestration is [Task](https://taskfile.dev) (cross-platform — `Taskfile.yml`
replaced the Makefile in ADR 0017 Phase 3). Bare `task` lists every recipe.
Recipes assume the pinned Node is on PATH (`.nvmrc` → 24.15.0; `nvm use` /
`fnm use`).

| Command | What it runs | Expected |
|---|---|---|
| `task verify` | lint + pytest + vitest + Angular build + smoke | `✓ VERIFY PASSED` |
| `cd api && uv run pytest -q` | backend tests only | `N passed` |
| `npx ng test intake` (or `console` / `shared`) | one project's unit tests | `N passed` |
| `task lint` | ruff + eslint x3 + prettier-check | no errors |
| `task build` | Angular production build (both apps) | success |
| `task smoke` | full lifecycle against a live server | `✓ SMOKE PASSED` |

The same `task verify` chain runs in CI on every push and PR
(`.github/workflows/ci.yml`).

**Ownership + the @sf/shared gate (ADR 0017, Model 1).** `CODEOWNERS` requires
the owner's approval on `apps/intake/` and `packages/shared/`. On top of that, a
PR that touches `packages/shared/**` (`@sf/shared`) additionally runs the Intake
app's full verify — `task verify-intake` (lint + test + build intake + smoke) via
`.github/workflows/shared-gate.yml`. This is intentional: a shared-library change
ripples into the Intake app at build time, so it must prove the Intake app still
builds and passes before it can merge. A PR that does **not** touch
`packages/shared/**` does not trigger this extra gate.

---

## 3. The two seams

**Deterministic seams are disposable; the domain model is not.**

### Brain seam — intake interview + draft spec

| Property | Value |
|---|---|
| Interface location | `api/app/interview.py` — `get_brain()` |
| Default (offline) | `ScriptedBrain` — deterministic, no LLM calls |
| Real impl | `AgentBrain` in `api/app/agent_brain.py` |
| Env var | `FACTORY_BRAIN=agent` |
| Graceful degradation | every agent call falls back to scripted if the model call fails |

```bash
FACTORY_BRAIN=agent uv run uvicorn app.main:app --port 8000
```

### Runner seam — Stages 2–5 (architecture → build RED/GREEN → review → deploy)

| Property | Value |
|---|---|
| Interface location | `api/app/agent_exec.py` — `runner_mode()` |
| Default (offline) | `api/app/simulator.py` — tick-driven simulation |
| Real impl | `AgentRunner` in `api/app/agent_runner.py` |
| Env var | `FACTORY_RUNNER=agent` |
| Per-request workspace | `workspaces/<ref>/` copied from `sample/` |

```bash
FACTORY_RUNNER=agent uv run uvicorn app.main:app --port 8000
```

Both seams are read per-call from the env via `api/app/agent_exec.py` —
tests flip them with `monkeypatch.setenv` mid-process without restart.

### Which CLI runs the real modes

The env value `agent` means "the real LLM brain/runner" (vs `scripted`/`sim`).
The CLI binary is chosen separately (ADR 0021):

| Env var | Values | Default |
|---|---|---|
| `FACTORY_CLI` | `codex` \| `claude` | `codex` (for now) |
| `CODEX_BIN` / `FACTORY_CODEX_MODEL` | binary path / model override | `codex` / the CLI's default |
| `CLAUDE_BIN` / `FACTORY_CLAUDE_MODEL` | binary path / model | `claude` / `claude-haiku-4-5` |

In codex mode the no-edits contract is enforced by codex's OS sandbox
(`read-only` vs `workspace-write`); in claude mode by a tool disallow list.
`GET /api/health` reports the active `cli` alongside `brain` and `runner`.

---

## 4. Bounded autonomy and gates

### The subprocess boundary

All agent-CLI invocations go through a single function:

```
api/app/agent_exec.py  →  run_agent(prompt, *, cwd, allow_edits, timeout, max_turns)
```

Bounds enforced there:
- `timeout` (default 300 s) kills the entire process group on expiry — the
  **only** autonomy bound under codex, which has no turn cap (ADR 0021).
- `--max-turns` (default 25) additionally caps the turn count on the claude path.
- read-only unless `allow_edits=True` — codex via `--sandbox read-only`, claude
  via `--permission-mode default` + a tool disallow list.
- A new session per call so the timeout kills all child processes, not just
  the top-level process (the CLI spawns workers that would otherwise hold
  pipes open after the parent dies).

### The four machine-checked gates

| Gate | What is checked | Witness test |
|---|---|---|
| **RED** | `pytest` must FAIL with collected tests (no import errors, must fail as assertions) | `api/tests/test_agent_runner.py::test_red_gate_rejects_non_failing_tests` |
| **GREEN + test-isolation** | Suite passes AND the frozen `tests/` hash is untouched — a cheating implementer that weakens tests is caught, including pytest-config deselection | `api/tests/test_agent_runner.py::test_isolation_gate_catches_cheating_implementer` |
| **Review** | A review summary file must exist in the per-request workspace — created by the agent at runtime | pipeline structural check in `api/app/agent_runner.py` |
| **Human merge gate** | A human must call `POST /api/requests/{id}/approve` to merge the work branch to main | only humans can clear `approve_merge`; the simulator stops here |

Any gate failure, timeout, or crashed stage escalates to `needs_human` —
no silent stranding (ADR 0013).

---

## 5. Conventions that bite

### Backend

- **Single uvicorn worker only.** The tick loop and pipeline worker threads
  assume a single process; SQLite has one writer.  The `docker-compose.yml`
  comment explains why — never scale to multiple replicas without reworking
  both.
- **SQLite WAL mode.** `api/app/db.py` enables `PRAGMA journal_mode=WAL` so
  many poll readers can proceed while a pipeline thread commits.  Do not
  swap for Postgres without an ADR.
- **progress_event is append-only.** `api/app/events.py` only INSERTs —
  never UPDATE or DELETE a `progress_event` row.  The two-axis log (ADR
  0008) is the source of truth for the feed; mutations break replay and
  cursors.
- **SQLAlchemy 2 + `uv` managed.** Use `uv add` / `uv run` — never `pip`
  or `pipenv`.  The ORM uses the SQLAlchemy 2 style (no `Query` object,
  explicit `select()`).

### Frontend

- **Angular 22 standalone + signals.** Components are standalone; state
  is signal-based.  No NgModules, no RxJS Subject-as-state.
- **Inline templates.** All component templates are inline (`template:`),
  not in separate `.html` files.
- **Kit components.** Shared UI primitives live in
  `web/src/app/kit/kit.ts`.  Reach for them before writing new component
  boilerplate.
- **Design tokens first.** Global design tokens are in
  `web/src/styles.css`.  Do not introduce new global CSS without checking
  whether a token already covers it.

---

## 6. Where things live

| Path | Purpose |
|---|---|
| `api/app/interview.py` | Intake brain seam — `get_brain()`, `FACTORY_BRAIN` |
| `api/app/agent_exec.py` | Single subprocess boundary — `run_agent()`, `runner_mode()` |
| `api/app/agent_runner.py` | Real Stage 2–5 runner — `AgentRunner`, gate logic |
| `api/app/agent_brain.py` | Real intake brain — `AgentBrain` |
| `api/app/simulator.py` | Offline stand-in for Stages 2–5 |
| `api/app/transitions.py` | Lifecycle transition table + `apply()` — the one legal write path for Request lifecycle state (status/stage/gate/needs_human) |
| `api/app/events.py` | Append-only helpers for `progress_event` log |
| `api/app/db.py` | SQLite WAL setup, session factory |
| `api/app/models.py` | Domain model — Request, stages, gates, `progress_event` |
| `api/app/routers/` | HTTP layer wired in `main.py` — `system`, `registry`, `events` (feed/comments/inbox), `gates` (gate + recovery actions), `mission` (control-center aggregate), `requests` (CRUD/intake/submit) |
| `web/src/app/kit/kit.ts` | Shared Angular UI kit components |
| `web/src/styles.css` | Global design tokens |
| `sample/` | Template workspace copied for each real pipeline run |
| `scripts/smoke.sh` | End-to-end lifecycle smoke test |
| `docs/adr/` | Architecture Decision Records 0001–0015 |
| `CONTEXT.md` | Domain vocabulary (canonical) |
| `VERIFICATION.md` | Manual verification flows and expected outcomes |

---

## 7. Adding a new runtime

To swap in a different LLM or execution engine (ADR 0011 names this as a
future possibility):

1. **Implement the executor.** Write a class that accepts a prompt and a
   working directory and returns a result object (modelled on `AgentRunner`
   / `run_agent`).
2. **Wire the env var.** Add a branch in `api/app/agent_exec.py` (or
   `api/app/interview.py` for the brain seam) guarded by the env var value.
3. **Write fake-executor tests.** Follow the pattern in
   `api/tests/test_agent_runner.py` — inject a `FakeExecutor` that returns
   canned results and verify the four gate behaviours:
   - RED gate rejects tests that pass.
   - GREEN + test-isolation gate catches a weakened test surface.
   - Gate failures escalate (never silently strand a request).
   - Cancel always wins over a running pipeline.
4. **Run `task verify`.**  All four gates must pass before the runtime is
   considered wired correctly.
