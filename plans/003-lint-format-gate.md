# Plan 003: Add a lint and format gate (eslint + ruff + prettier) to Makefile and CI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 76bb314..HEAD -- web/package.json web/angular.json api/pyproject.toml Makefile .github/workflows/ci.yml`
> If any of these changed since this plan was written, compare the "Current
> state" facts against the live files before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (a new lint config can surface many violations; bounded below)
- **Depends on**: none (but land BEFORE plans 004 and 006 so their big diffs are lint-clean from birth)
- **Category**: dx
- **Planned at**: commit `76bb314`, 2026-06-11

## Why this matters

The repo has no code-quality gate at all: no eslint config anywhere in
`web/`, no lint architect target in `angular.json`, no ruff (or any linter)
in `api/pyproject.toml`, and although `web/.prettierrc` exists and prettier
is a devDependency, there is no `format` script and nothing runs it in CI.
Unused imports, dead variables, and style drift land silently. Every later
plan in this set produces sizable diffs — a lint gate catches their mistakes
mechanically instead of in review.

## Current state

- `web/package.json` scripts today: `ng`, `start`, `build`, `watch`, `test` —
  no `lint`, no `format`. `prettier@^3.8.1` is in devDependencies.
- `web/.prettierrc` exists (printWidth 100, Angular-template overrides).
  Honor it; do not change it.
- `web/angular.json` has no `lint` target.
- `api/pyproject.toml` (excerpt): dependency-groups `dev = ["httpx", "pytest"]`;
  no `[tool.ruff]` section.
- `Makefile` targets: `dev api web test test-web build smoke verify up backup reset`
  — `verify: test test-web build smoke`.
- `.github/workflows/ci.yml` steps: uv setup → node setup → backend tests →
  `npm ci` → `npx ng test` → `npx ng build` → `./scripts/smoke.sh` →
  `docker compose build`.
- Code style notes you must preserve: the repo intentionally uses compact
  one-line TypeScript members and long inline-template strings; Python files
  have long lines (the Makefile-adjacent style tolerates ~120+ chars). The
  lint config must be chosen to accept the existing style, not fight it.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Add angular-eslint | `cd web && npx ng add @angular-eslint/schematics --skip-confirmation` | writes `eslint.config.js`, adds lint target |
| Web lint | `cd web && npx ng lint` | exit 0 |
| Format check | `cd web && npm run format:check` | exit 0 |
| Add ruff | `cd api && uv add --dev ruff` | uv.lock updated |
| Py lint | `cd api && uv run ruff check .` | "All checks passed!" |
| Full gate | `make verify` (after wiring) | "✓ VERIFY PASSED" |

## Scope

**In scope**:
- `web/package.json` (scripts + devDependencies added by `ng add`)
- `web/eslint.config.js` (created by `ng add`, then tuned)
- `web/angular.json` (lint target added by `ng add`)
- `web/package-lock.json` (regenerated)
- `api/pyproject.toml`, `api/uv.lock` (ruff dev dep + `[tool.ruff]`)
- `Makefile` (new `lint` target; wire into `verify`)
- `.github/workflows/ci.yml` (lint steps)
- Source files ONLY for auto-fixable or trivial lint violations (unused
  imports, prefer-const, etc.) and prettier reformatting — each in its own
  commit, mechanical changes only.

**Out of scope**:
- `web/.prettierrc` — keep as is.
- Any behavioral code change. If a lint rule demands a refactor (not a
  mechanical fix), disable that rule with a comment in the config instead
  and note it in your report.
- Pre-commit hooks / husky — deliberately deferred (solo repo, CI is the gate).

## Git workflow

- Branch: `advisor/003-lint-gate`
- Separate commits: (1) eslint scaffold, (2) eslint mechanical fixes,
  (3) prettier run (if needed), (4) ruff + fixes, (5) Makefile + CI wiring.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Scaffold angular-eslint

`cd web && npx ng add @angular-eslint/schematics --skip-confirmation`.
Inspect the generated `eslint.config.js`: it should extend the recommended
TypeScript + Angular template configs. Add these tunings to fit this repo:

- Component selectors: the repo uses prefixes `sf`, `sub`, and bare names
  (`sub-shell`); set `@angular-eslint/component-selector` and
  `directive-selector` to `"off"` (the design system predates the gate).
- `@angular-eslint/prefer-standalone`: leave on (repo is fully standalone).

**Verify**: `cd web && npx ng lint` runs (errors allowed at this step).

### Step 2: Drive web lint to zero

Run `npx ng lint`. Apply `npx ng lint --fix` first, then fix remaining
violations by hand ONLY if mechanical (unused import, `prefer-const`,
`== → ===`). For anything needing real refactoring, disable the specific
rule in `eslint.config.js` with a one-line comment `// TODO(lint-debt): …`
and list it in your report.

**Verify**: `cd web && npx ng lint` → exit 0. Then `npx ng test && npx ng build` → both exit 0 (mechanical fixes must not change behavior).

### Step 3: Wire prettier scripts

Add to `web/package.json` scripts:
`"format": "prettier --write src"`, `"format:check": "prettier --check src"`.
Run `npm run format:check`. If files fail, run `npm run format` as its own
commit, then re-run tests + build.

**Verify**: `cd web && npm run format:check` → exit 0; `npx ng test && npx ng build` → exit 0.

### Step 4: Ruff for the API

`cd api && uv add --dev ruff`. Add to `api/pyproject.toml`:

```toml
[tool.ruff]
target-version = "py313"
line-length = 120

[tool.ruff.lint]
select = ["E", "F", "I", "B"]
ignore = ["E501"]  # the repo's comment-heavy lines run long by intent
```

Run `uv run ruff check . --fix`, hand-fix the mechanical rest. Import order
("I") will reorder imports — fine, that's mechanical.

**Verify**: `cd api && uv run ruff check .` → "All checks passed!"; `uv run pytest -q` → all pass.

### Step 5: Makefile + CI wiring

Makefile — add (match the existing comment style, `##` doc lines):

```make
## Lint both sides (ruff + eslint + prettier check)
lint:
	cd api && uv run ruff check .
	cd web && npx ng lint && npm run format:check
```

and change `verify: test test-web build smoke` to
`verify: lint test test-web build smoke`.

CI — in `.github/workflows/ci.yml`, add a "Lint" step for the api right
after "Backend tests"'s setup is available (`working-directory: api`,
`run: uv run ruff check .`) and a web lint step after "Frontend install"
(`run: npx ng lint && npm run format:check`, `working-directory: web`).

**Verify**: `make verify` → "✓ VERIFY PASSED" (now includes lint).

## Test plan

No new tests — the gate itself is the artifact. The existing suites
(`pytest`, `ng test`, build, smoke) prove the mechanical fixes changed no
behavior.

## Done criteria

- [ ] `make lint` exits 0
- [ ] `make verify` exits 0 and runs lint first
- [ ] `web/eslint.config.js` exists; `cd web && npx ng lint` exits 0
- [ ] `cd api && uv run ruff check .` exits 0
- [ ] CI workflow contains both lint steps
- [ ] All behavior suites still green (pytest, ng test, build, smoke)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `ng add @angular-eslint/schematics` fails or generates a config for a
  different major version than Angular 22 expects.
- After `--fix`, more than ~50 violations remain that are not mechanically
  fixable — report the rule breakdown (`npx ng lint 2>&1 | tail -30`) and
  wait for a decision on which rules to relax, rather than mass-editing
  source.
- Ruff's `I` (import sort) fixes cause a pytest failure (would indicate an
  import-order-dependent module — report which).
- Prettier reformatting produces a diff in more than ~30 files (the repo may
  have diverged from `.prettierrc` more than expected — report and wait).

## Maintenance notes

- Plans 004 and 006 should be executed AFTER this lands so their diffs are
  born lint-clean.
- The `// TODO(lint-debt)` markers (if any) are intentional: each is a rule
  worth re-enabling after a focused cleanup. List them in the final report.
- If a future contributor adds husky/pre-commit, `make lint` is the single
  entry point to call.
