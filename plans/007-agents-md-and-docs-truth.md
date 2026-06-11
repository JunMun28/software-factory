# Plan 007: Write AGENTS.md (agent-facing repo guide) and fix stale doc claims

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 76bb314..HEAD -- README.md VERIFICATION.md`
> Also re-run the test-count command in Step 3 — counts in this plan are
> from planning time and WILL drift; always use the live number.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (but executing it LAST means AGENTS.md can reference the other plans' outcomes accurately)
- **Category**: dx / docs
- **Planned at**: commit `76bb314`, 2026-06-11

## Why this matters

This repo is built to be operated and extended by AI agents (ADR 0011 wires
Claude Code in as the real runtime; ADR 0001 names other runtimes as future
swaps), yet the agent-facing knowledge — which env vars flip the seams, what
the two seams are, what the gates guarantee, which commands verify a change —
is spread across ADR 0011, CONTEXT.md, VERIFICATION.md, README.md, and four
source files. An agent (or human) starting cold pays a 5-file search tax
before its first edit. Separately, the docs make stale factual claims: the
README advertises "pytest (31)" and VERIFICATION.md "50 pytest tests" while
the suite is at 58 and growing — stale numbers teach readers to distrust the
docs.

## Current state

- No `AGENTS.md` or `CLAUDE.md` exists at the repo root (verified).
- `README.md:49` (the Verify section): `make verify     # pytest (31) + vitest (14) + Angular build + lifecycle smoke`.
- `VERIFICATION.md:25`: a table row beginning `| make test — 50 pytest tests |`
  followed by a long, otherwise-accurate description.
- Actual suite size at planning time: 58 backend tests
  (`cd api && uv run pytest -q` → "58 passed"), 14 web tests — but plans
  001–006 add more; ALWAYS use the live count.
- Key facts AGENTS.md must consolidate (verify each against the live code
  while writing — do not copy blindly):
  - Brain seam: `api/app/interview.py` `get_brain()`; `FACTORY_BRAIN=claude`
    swaps in `ClaudeBrain` (`api/app/claude_brain.py`); scripted is the
    offline default; every Claude call degrades gracefully to scripted.
  - Runner seam: `FACTORY_RUNNER=claude` makes Stages 2–5 real
    (`api/app/claude_runner.py`) in per-request git workspaces
    (`workspaces/<ref>/` copied from `sample/`); default is `simulator.py`.
  - The single subprocess boundary: `api/app/claude_exec.py` `run_claude()`
    — bounded autonomy (`--max-turns`, timeout, process-group kill,
    read-only tool restriction unless `allow_edits`).
  - Machine-checked gates: RED (tests must fail cleanly), GREEN +
    test-isolation (suite passes AND `tests/` hash untouched — cheating
    implementers escalate, witnessed by
    `api/tests/test_claude_runner.py::test_isolation_gate_catches_cheating_implementer`),
    review, then a HUMAN merge gate.
  - Verification commands: `make verify` (lint — if plan 003 landed — +
    pytest + vitest + build + smoke); per-side commands from the Makefile.
  - Domain language lives in `CONTEXT.md`; decisions in `docs/adr/0001..0013`;
    design rationale in `DESIGN.md`/`PRODUCT.md`.
  - Conventions: FastAPI + SQLAlchemy 2 + SQLite WAL (check `api/app/db.py`
    before claiming WAL), uv-managed; Angular 22 standalone + signals,
    inline templates, kit components in `web/src/app/kit/kit.ts`, design
    tokens in `web/src/styles.css`; deterministic seams are disposable, the
    domain model is not.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Live backend test count | `cd api && uv run pytest -q 2>&1 \| tail -1` | "N passed" |
| Live web test count | `cd web && npx ng test 2>&1 \| grep "Tests"` | "N passed" |
| Full gate | `make verify` | "✓ VERIFY PASSED" |

## Scope

**In scope**:
- `AGENTS.md` (create, repo root)
- `CLAUDE.md` (create, repo root — thin pointer, see Step 2)
- `README.md` (the one stale line)
- `VERIFICATION.md` (the one stale count)

**Out of scope**:
- CONTEXT.md, DESIGN.md, PRODUCT.md, HANDOFF.md, RESEARCH.md, ADRs — they
  are accurate or historical; do not edit.
- Restructuring README sections.

## Git workflow

- Branch: `advisor/007-agents-md`
- Single commit; message style: short imperative title.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write AGENTS.md

~150–250 lines, sections in this order:

1. **What this repo is** (3 lines + pointer to CONTEXT.md/README).
2. **Verify any change** — the command table above, plus "green `make verify`
   = safe" and where CI runs the same chain.
3. **The two seams** — brain and runner: interface, default impl, real impl,
   env var, and the one-line philosophy ("deterministic seams are
   disposable; the domain model is not").
4. **Bounded autonomy & gates** — run_claude bounds; the four gates and
   which test witnesses each.
5. **Conventions that bite** — single uvicorn worker only (ADR 0013 —
   compose comment explains why), SQLite single-writer, append-only
   progress_event log (never UPDATE events), Angular: signals + standalone +
   inline templates, kit components, no new global CSS without checking
   styles.css tokens.
6. **Where things live** — a 10-row path→purpose table.
7. **Adding a new runtime** — the checklist from ADR 0011's seam: implement
   executor, wire env var, make `test_claude_runner.py`-style fake-executor
   tests pass.

Every factual claim must be checked against the live file it describes
while you write it (e.g. confirm the WAL pragma in `db.py` before saying
"WAL"; confirm the env var names in `claude_exec.py`).

**Verify**: every file path mentioned in AGENTS.md exists:
`grep -oE '[a-zA-Z0-9_./-]+\.(py|ts|md|sh|yml)' AGENTS.md | sort -u | while read f; do [ -e "$f" ] || echo "MISSING: $f"; done`
→ no MISSING lines.

### Step 2: Thin CLAUDE.md

Create `CLAUDE.md` (≤15 lines): one line saying agent guidance lives in
AGENTS.md, then the three highest-value rules inline (verify with
`make verify`; never edit `progress_event` rows — append-only; single
uvicorn worker only). Claude Code loads CLAUDE.md automatically; other
tools read AGENTS.md — both entry points must exist, content lives in one.

**Verify**: `wc -l CLAUDE.md` ≤ 15.

### Step 3: Fix the stale counts

- `README.md:49`: replace the hardcoded numbers with count-free wording, e.g.
  `make verify     # backend tests + web tests + Angular build + lifecycle smoke`
  (count-free so it can't rot again).
- `VERIFICATION.md:25`: replace "50 pytest tests" with the LIVE count from
  the command table (run it now), keeping the rest of the row intact. This
  file is a point-in-time verification record, so a number is appropriate
  here — but add "(at last update)" after it.

**Verify**: `grep -n "pytest (31)\|50 pytest" README.md VERIFICATION.md` → no matches.

### Step 4: Full gate

`make verify` — docs changes can't break it, but run it anyway to leave the
branch provably green.

**Verify**: "✓ VERIFY PASSED".

## Test plan

No code tests. The path-existence grep in Step 1 is the accuracy check for
AGENTS.md; the grep in Step 3 proves the stale claims are gone.

## Done criteria

- [ ] `AGENTS.md` exists; path-existence grep returns no MISSING lines
- [ ] `CLAUDE.md` exists, ≤15 lines, points to AGENTS.md
- [ ] `grep -n "pytest (31)\|50 pytest" README.md VERIFICATION.md` → empty
- [ ] `make verify` → "✓ VERIFY PASSED"
- [ ] `git status` shows only the four in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- A fact you're documenting contradicts the live code (e.g. an env var name
  changed) — fix the doc to match the CODE, and if the discrepancy implies
  a bug, report it instead of papering over it.
- README.md:49 or VERIFICATION.md:25 no longer contain the quoted text
  (drift) — locate the equivalent claims before editing; if they're gone
  entirely, skip Step 3 and say so.

## Maintenance notes

- AGENTS.md is now the single agent entry point: future plans (including
  re-runs of the improve skill) should tell executors to read it first.
- Keep AGENTS.md count-free and number-light — facts that drift (test
  counts, line counts) belong in command output, not prose.
