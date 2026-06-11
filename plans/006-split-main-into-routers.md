# Plan 006: Split the 549-line main.py into domain routers without changing behavior

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 76bb314..HEAD -- api/app/main.py`
> main.py WILL likely have drifted if plans 005 (and the uncommitted intake
> work) landed first — that is expected. What matters: re-read main.py fully
> before starting; the endpoint inventory and helper structure below must
> still hold in spirit. If endpoints were added/removed, adjust the router
> assignment table accordingly and note it in your report.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED (large mechanical diff; mitigated by a route-inventory snapshot and the full verify chain)
- **Depends on**: plans/005-runner-brain-hardening.md (touches the same files; land it first), plans/003-lint-format-gate.md (so this diff is lint-clean)
- **Category**: tech-debt
- **Planned at**: commit `76bb314`, 2026-06-11

## Why this matters

`api/app/main.py` is 549 lines holding all 23 endpoints, the app factory,
the lifespan/orphan-rescan/tick-loop startup logic, and shared helpers —
everything in one `create_app()` closure. Every other module in `api/app`
is a focused, ~100–200-line domain file. The closure style means no endpoint
can be read, tested, or modified without paging through the whole file, and
adding endpoint #24 makes it worse. Splitting into FastAPI `APIRouter`
modules is purely mechanical if done carefully, and this codebase's
"AI-navigable small modules" convention (see CONTEXT.md) is the explicit
goal.

## Current state

- `api/app/main.py:31` — `def create_app(*, auto_tick: float | None = None, runner: ClaudeRunner | None = None) -> FastAPI:`
  Everything below is inside this closure, including:
  - startup/lifespan section (~lines 31–107): DB migrate, seed, orphan
    rescan (emits escalations), the tick loop guarded against
    `WEB_CONCURRENCY > 1` (ADR 0013), CORS middleware.
  - shared closure helpers (~lines 108–123), all stateless:
    - `to_out(r, model=RequestOut, **extra)` — ORM→schema serializer
    - `get_request(db, rid)` — fetch-or-404
    - `next_ref(db)` — `REQ-<int>` allocator
  - a `claude_pipeline` object: built from the `runner` parameter (or a
    default `ClaudeRunner()`) — **this is the one piece of real app state
    the endpoints share**. Find its exact construction by reading the file.
- Endpoint inventory at planning time (23 routes — your Step 1 snapshot is
  the source of truth, not this list):

  | Path | Methods | Proposed router |
  |------|---------|-----------------|
  | `/api/health` | GET | system.py |
  | `/api/simulator/tick` | POST | system.py |
  | `/api/apps`, `/api/apps/{app_id}` | GET/POST/PATCH | registry.py |
  | `/api/requests` (+`/{rid}`, PATCH) | GET/POST/PATCH | requests.py |
  | `/api/requests/{rid}/interview` | GET/POST | requests.py |
  | `/api/requests/{rid}/submit` | POST | requests.py |
  | `/api/requests/{rid}/approve`, `/send-back`, `/respond`, `/cancel`, `/retry` | POST | gates.py |
  | `/api/requests/{rid}/comments` | GET/POST | events.py |
  | `/api/events`, `/api/events/cursor` | GET | events.py |
  | `/api/subjects/{key}/feed` | GET | events.py |
  | `/api/inbox` | GET | events.py |

- Conventions: modules carry a docstring tying them to ADRs (see
  `api/app/interview.py`, `api/app/claude_exec.py` for the voice). Tests are
  behavioral through `TestClient(create_app(auto_tick=0))` — they must pass
  UNCHANGED; that is the proof of behavior preservation.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Backend tests | `cd api && uv run pytest -q` | all pass, same count as baseline |
| Route snapshot | `cd api && uv run python -c "from app.main import create_app; print('\n'.join(sorted(f'{sorted(r.methods)} {r.path}' for r in create_app(auto_tick=0).routes if hasattr(r,'methods'))))"` | identical before/after |
| Full gate | `make verify` | "✓ VERIFY PASSED" |
| Lint (if 003 landed) | `cd api && uv run ruff check .` | clean |

## Scope

**In scope**:
- `api/app/main.py` (shrinks to app factory + lifespan + router includes)
- `api/app/routers/__init__.py`, `api/app/routers/{system,registry,requests,gates,events}.py` (create)
- `api/app/api_helpers.py` (create — `to_out`, `get_request`, `next_ref`, and the pipeline accessor)

**Out of scope**:
- ANY behavior change: same paths, same status codes, same response models,
  same error strings. The pytest suite passing unchanged is the contract.
- `api/tests/**` — do not modify tests to make them pass (test edits are a
  STOP condition). Import-path updates inside tests are also out of scope —
  tests import `app.main.create_app` and helpers like
  `app.claude_runner.workspace_for`; check what they import from `app.main`
  FIRST (`grep -n "from app.main" api/tests/*.py`); whatever they import
  must keep working from `app.main` (re-export if needed).
- `simulator.py`, `claude_runner.py`, `lifecycle.py`, `events.py` internals.

## Git workflow

- Branch: `advisor/006-router-split`
- Commit per router move (system → registry → events → requests → gates),
  each leaving the suite green — never a single big-bang commit.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Baseline snapshot

Run the route-snapshot command and save its output to a scratch file
OUTSIDE the repo (e.g. `/tmp/routes-before.txt`). Run
`cd api && uv run pytest -q` and record the count.

**Verify**: snapshot file exists; tests green.

### Step 2: Extract shared helpers

Create `api/app/api_helpers.py` with `to_out`, `get_request`, `next_ref`
moved verbatim from the closure (they are stateless — confirm by reading
them; if any references a closure variable other than imported modules,
STOP). Add the pipeline seam:

```python
# api/app/api_helpers.py
_pipeline = None

def set_pipeline(p) -> None:
    global _pipeline
    _pipeline = p

def pipeline():
    return _pipeline
```

In `create_app`, call `set_pipeline(claude_pipeline)` where the pipeline is
constructed, and keep main.py's endpoints using the closure variable for
now (they move in later steps). Imports the helpers need (`RequestOut`,
`HTTPException`, models, `func`/`update` etc.) move with them.

**Verify**: `cd api && uv run pytest -q` → green, same count.

### Step 3: Move system + registry routers

Create `api/app/routers/system.py` and `registry.py`, each:

```python
from fastapi import APIRouter, Depends
router = APIRouter()

@router.get("/api/health")
def health(...): ...
```

Move the endpoint bodies verbatim; replace closure-helper references with
imports from `..api_helpers`; replace `claude_pipeline` references with
`api_helpers.pipeline()` (call it inside the endpoint body, not at import
time). In `create_app`, `app.include_router(system.router)` etc., and
delete the moved code.

**Verify**: pytest green; route snapshot diff vs `/tmp/routes-before.txt`
shows NO change (`diff <(snapshot cmd) /tmp/routes-before.txt` → empty).

### Step 4: Move events router

Same procedure for `/api/events`, `/api/events/cursor`,
`/api/subjects/{key}/feed`, `/api/inbox`, and the two comments endpoints.

**Verify**: pytest green; snapshot identical.

### Step 5: Move requests router

`/api/requests` CRUD + interview + submit. These use `next_ref`,
`get_brain`, `to_out`, `get_request` — all importable.

**Verify**: pytest green; snapshot identical.

### Step 6: Move gates router

approve / send-back / respond / cancel / retry. These are the ones using
the pipeline and `simulator` — keep the exact `runner_mode()` branching.
After this, `create_app` should contain ONLY: lifespan/startup, CORS,
pipeline construction + `set_pipeline`, router includes, and whatever the
tests import from `app.main`.

**Verify**: pytest green; snapshot identical; `wc -l api/app/main.py` ≤ ~200.

### Step 7: Full gate

`make verify` (includes the live-server smoke — the strongest behavior
proof) and, if plan 003 landed, `uv run ruff check .`.

**Verify**: "✓ VERIFY PASSED".

## Test plan

No new tests. The contract is: the existing suite passes UNCHANGED at every
step, and the route snapshot is byte-identical before/after. If you find an
endpoint that cannot be moved without changing a test, that is a STOP, not
a test edit.

## Done criteria

- [ ] `diff <(route snapshot) /tmp/routes-before.txt` → empty
- [ ] `cd api && uv run pytest -q` → same pass count as Step 1 baseline, zero failures
- [ ] `make verify` → "✓ VERIFY PASSED"
- [ ] `wc -l api/app/main.py` ≤ ~200; routers exist per the table
- [ ] No test file modified (`git diff --stat -- api/tests` empty)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Any closure helper or endpoint captures `create_app` state beyond the
  documented `claude_pipeline` (e.g. references `auto_tick`, the tick task,
  or a local cache) — the seam design needs rethinking, don't improvise one.
- A test imports something from `app.main` that the split removes and a
  simple re-export in main.py doesn't satisfy.
- The route snapshot differs at ANY step.
- Circular imports appear between `api_helpers` and routers that a
  function-local import doesn't cleanly solve.

## Maintenance notes

- New endpoints go in the matching router; `main.py` should never grow
  endpoints again. If a sixth domain emerges (e.g. auth), it gets its own
  router file.
- Reviewer should scrutinize the pipeline seam (`set_pipeline`) — it
  replaces a closure variable with module state; the tests that inject a
  fake runner via `create_app(runner=...)` prove it works, so look there
  first.
- Deferred deliberately: moving the lifespan/orphan-rescan block out of
  main.py — it IS the app factory's job; leave it.
