# Software Factory

An autonomous-but-governed AI pipeline that carries a unit of work through the full
SDLC — requirements → architecture → TDD implementation → review → deploy — with
humans gating the irreversible boundaries. See [CONTEXT.md](CONTEXT.md) for the
domain language and [docs/adr/](docs/adr/) for the decisions.

This repo contains the **web app** (the Intake form + Control center) implemented
from the hi-fi design, runnable fully offline — and an opt-in **real agent runtime
on Claude Code** (ADR 0011):

- `api/` — FastAPI + SQLite engine: Request lifecycle, gates, the two-axis
  `progress_event` log (ADR 0008), scripted intake brain, and a factory simulator
  standing in for the Stage 2–6 CI agents (ADR 0009).
- **Claude Code modes** — `FACTORY_BRAIN=claude` makes the intake interview + draft
  spec real; `FACTORY_RUNNER=claude` runs Stages 2–5 for real in a per-request git
  workspace (`workspaces/<ref>/` copied from `sample/`), with machine-checked gates:
  RED (pytest must fail cleanly), GREEN + **test-isolation** (suite passes and the
  `tests/` hash is untouched — cheating implementers escalate), review, then the
  human merge gate merges the work branch to main.

  ```bash
  cd api && FACTORY_BRAIN=claude FACTORY_RUNNER=claude FACTORY_CLAUDE_MODEL=haiku \
    uv run uvicorn app.main:app --port 8000
  ```
- `web/` — Angular 22 SPA: the Submitter face (S0–S5) and the Admin Control Center
  (board, list, approval queue, full-screen issue, per-app feed, needs-me inbox,
  registry, settings) in the Micron Atlas design system.
- `docs/` — ADRs, PRDs, and the UI/UX design spec the implementation follows.

## Quickstart

```bash
make dev        # API on :8000 + web on :4200 (simulator ticks every 8s)
```

Open **http://localhost:4200** — sign in as a Submitter, or "as a reviewer" for the
Control center. The database seeds itself with a demo world; `make reset` re-seeds.

For the production-shaped stack (nginx + API + persistent volume):

```bash
make up         # docker compose up --build → http://localhost:8080
```

## Verify

```bash
make verify     # pytest (31) + vitest (14) + Angular build + lifecycle smoke
```

The same chain runs in CI on every push ([.github/workflows/ci.yml](.github/workflows/ci.yml)).
Full manual flows and expected outcomes: [VERIFICATION.md](VERIFICATION.md).
