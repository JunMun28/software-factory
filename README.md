# Software Factory

An autonomous-but-governed AI pipeline that carries a unit of work through the full
SDLC — requirements → architecture → TDD implementation → review → deploy — with
humans gating the irreversible boundaries. See [CONTEXT.md](CONTEXT.md) for the
domain language and [docs/adr/](docs/adr/) for the decisions.

This repo is a monorepo (ADR 0017): one backend, **two Angular apps** (the Intake
form + Control center) over a shared library, implemented from the hi-fi design and
runnable fully offline — plus an opt-in **real agent runtime** (ADR 0011) driven by
the opencode CLI (default), Codex, or Claude Code:

- `api/` — FastAPI + SQLite engine: Request lifecycle, gates, the two-axis
  `progress_event` log (ADR 0008), scripted intake brain, and a factory simulator
  standing in for the Stage 2–6 CI agents (ADR 0009).
- **Real agent modes** — `FACTORY_BRAIN=agent` makes the intake interview + draft
  spec real; `FACTORY_RUNNER=agent` runs Stages 2–5 for real in a per-request git
  workspace (`workspaces/<ref>/` copied from `sample/`), with machine-checked gates:
  RED (pytest must fail cleanly), GREEN + **test-isolation** (suite passes and the
  `tests/` hash is untouched — cheating implementers escalate), review, then the
  human merge gate merges the work branch to main.

  The value `agent` means "the real LLM brain/runner" (vs `scripted`/`sim`).
  Which CLI actually runs is chosen by `FACTORY_CLI`: **`opencode`
  (default)** — needs a logged-in [opencode CLI](https://opencode.ai) with an authed
  provider; no-edit stages run under a factory-owned deny config (ADR 0024) — or `codex`
  ([Codex CLI](https://github.com/openai/codex), `read-only` OS sandbox) or `claude`
  (Claude Code).

  ```bash
  # real factory on the opencode CLI (default); FACTORY_OPENCODE_MODEL pins the model
  cd api && FACTORY_BRAIN=agent FACTORY_RUNNER=agent \
    uv run uvicorn app.main:app --port 8000

  # same, on Codex or Claude Code instead
  cd api && FACTORY_BRAIN=agent FACTORY_RUNNER=agent FACTORY_CLI=codex \
    uv run uvicorn app.main:app --port 8000
  cd api && FACTORY_BRAIN=agent FACTORY_RUNNER=agent FACTORY_CLI=claude \
    FACTORY_CLAUDE_MODEL=haiku uv run uvicorn app.main:app --port 8000
  ```
- `apps/intake/` — Angular 22 SPA, the **Submitter** front door: the Intake form
  and the real-time Intake interview (S0–S5).
- `apps/console/` — Angular 22 SPA, the Admin **Control center**: board, list,
  approval queue, full-screen issue, per-app feed, needs-me inbox, registry, and
  settings.
- `packages/shared/` — `@sf/shared`: the domain models, API client, poll/theme
  services, and shared Micron Atlas UI kit both apps import (a change here re-runs
  the Intake app's full verify in CI — see [AGENTS.md](AGENTS.md)).
- `docs/` — ADRs, PRDs, and the UI/UX design spec the implementation follows.

## Quickstart

Orchestration is [Task](https://taskfile.dev) (cross-platform; runs natively on
Windows — Task embeds its own shell, ADR 0017). Install it (`brew install go-task`,
`winget install Task.Task`, or see taskfile.dev), then activate the pinned Node
once per shell (`.nvmrc` → 24.15.0; `nvm use` / `fnm use` / volta). The backend
runs on [uv](https://docs.astral.sh/uv/) (`brew install uv` or see the docs) —
recipes call `uv run`, which installs the pinned Python and deps on first use.
Bare `task` lists every recipe.

```bash
task dev        # API on :8000 + intake :4201 + console :4202 (simulator ticks every 8s)
```

Open **http://localhost:4201** (intake) — sign in as a Submitter, or "as a reviewer"
for the Control center on :4202. The database seeds itself with a demo world;
`task reset` re-seeds.

For the production-shaped stack (nginx + API + persistent volume):

```bash
task up         # docker compose up --build → http://localhost:8080
```

## Verify

```bash
task verify     # lint + backend tests + web tests + Angular build + lifecycle smoke
```

The same chain runs in CI on every push ([.github/workflows/ci.yml](.github/workflows/ci.yml)).
Full manual flows and expected outcomes: [VERIFICATION.md](VERIFICATION.md).
