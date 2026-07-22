# Plan 012: Put the `app-preview/` half of the repo into `task verify` and CI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5b9facb..HEAD -- Taskfile.yml .github/workflows/ci.yml app-preview/orchestrator/package.json app-preview/ui/package.json`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (turning a gate on usually surfaces pre-existing failures)
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `5b9facb`, 2026-07-21

## Why this matters

`task verify` prints `✓ VERIFY PASSED` while roughly half the repository is
never checked. The `app-preview/` tree — the "ng-v0" orchestrator and UI —
contains about 12,000 lines of tests that run only when a human remembers to
run them by hand, and a `typecheck` script that nothing calls.

This is not idle code. The orchestrator creates Kubernetes Deployments per
chat, runs a shell gate as a child process, proxies browser traffic, and
stores user database connection secrets. It shipped to the cluster on
2026-07-21 (commit `5b9facb`).

Until this plan lands, every other fix in this `plans/` batch is unverifiable:
an executor can change `preview-manager.ts` and get a green `task verify`
without a single orchestrator test having run. That is why this plan is first.

## Current state

### The two app-preview npm projects are separate from the root workspace

Each has **its own `package-lock.json`** and is not part of the repo-root
Angular workspace. `npm ci` at the repo root does not install them.

- `app-preview/orchestrator/package-lock.json` — exists
- `app-preview/ui/package-lock.json` — exists

`app-preview/orchestrator/package.json` scripts (verified):

```json
{
  "dev": "tsx src/index.ts",
  "build": "tsc -p tsconfig.build.json",
  "dev:azure": "tsx --env-file=.env.azure src/index.ts",
  "test": "vitest run",
  "typecheck": "tsc --noEmit",
  "smoke": "tsx scripts/smoke.ts",
  "migrate:check:azure": "tsx --env-file=.env.azure scripts/mssql-migrate-check.ts"
}
```

`app-preview/ui/package.json` scripts (verified):

```json
{
  "ng": "ng",
  "start": "ng serve --proxy-config proxy.conf.json",
  "build": "ng build",
  "e2e": "playwright test",
  "watch": "ng build --watch --configuration development",
  "test": "ng test"
}
```

Test surface: `app-preview/orchestrator/test/` holds 27 files (24 `*.test.ts`
plus `helpers.ts`, `fake-harness.ts`, `fake-preview-deps.ts`, and a `fixtures/`
dir). `app-preview/ui/src/` holds 45 `*.spec.ts` files.

### `Taskfile.yml` — the recipes that exist today

The `dir:` key is already used to scope a recipe to a subdirectory, e.g.
`Taskfile.yml:92-97`:

```yaml
  test:
    desc: Backend tests (pytest)
    dir: api
    cmds:
      - uv run pytest -q
```

and `Taskfile.yml:61-66`, which already knows about the orchestrator:

```yaml
  appview:
    desc: app-preview orchestrator on :7071 (local SQLite)
    dir: app-preview/orchestrator
```

The `verify` recipe (`Taskfile.yml:138-147`) is the whole gate:

```yaml
  verify:
    desc: "Everything: lint + pytest + vitest(x3) + build(x2) + smoke. Green = safe"
    cmds:
      - task: lint
      - task: test
      - task: test-web
      - task: build
      - task: smoke
      - echo ""
      - echo "✓ VERIFY PASSED — tests, build, and smoke all green"
```

`grep -rn "app-preview" Taskfile.yml` returns only the dev-server recipes
(lines 60–71) and the docker builds (lines 214–220). Nothing runs its tests.

### `.github/workflows/ci.yml` — no mention of app-preview

`grep -rn "app-preview" .github/workflows/` returns **nothing**. The workflow
has two jobs, `verify` and `test-mssql`. The `verify` job's only install step
is the repo-root one:

```yaml
      - name: Install web dependencies
        run: npm ci

      - name: task verify
        run: task verify
```

The `verify` job already sets up uv, Node from `.nvmrc`, and Task — steps this
plan's new job must repeat (Node + Task only; app-preview needs no Python).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install orchestrator deps | `cd app-preview/orchestrator && npm ci` | exit 0 |
| Install UI deps | `cd app-preview/ui && npm ci` | exit 0 |
| Orchestrator tests | `cd app-preview/orchestrator && npm test` | exit 0, all vitest tests pass |
| Orchestrator typecheck | `cd app-preview/orchestrator && npm run typecheck` | exit 0, no output |
| UI tests | `cd app-preview/ui && npm test` | exit 0, all specs pass |
| Full repo gate | `task verify` | `✓ VERIFY PASSED` |
| List Task recipes | `task` | the recipe list, including your new ones |

Node must be the pinned version (`.nvmrc` → 24.15.0; run `nvm use` or
`fnm use`). Do **not** use `pip`; do **not** run `python -m pytest` — the
backend uses `uv run pytest`. None of that is needed for this plan.

## Scope

**In scope** (the only files you should modify):
- `Taskfile.yml`
- `.github/workflows/ci.yml`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):
- **Any file under `app-preview/`.** If a test fails, that is a STOP
  condition — see below. You are wiring the gate, not changing the code it
  guards.
- **Lint and formatting for `app-preview/`.** There is no eslint config under
  `app-preview/` and `package.json:10`'s `format:check` deliberately covers
  only `apps/intake/src apps/console/src packages/shared/src`. Adding lint
  here would produce a huge reformatting diff and bury the real change. It is
  a separate follow-up, recorded in this plan's maintenance notes.
- **The Playwright e2e spec** (`app-preview/ui/e2e/critical-path.spec.ts`,
  run by `npm run e2e`). It needs browser binaries and a running server; it
  does not belong in the unit gate.
- **`app-preview/orchestrator`'s `smoke` and `migrate:check:azure` scripts.**
  `migrate:check:azure` needs live Azure SQL credentials, which CI does not
  have and must never have.
- Everything else in the repo. **Note: the working tree has uncommitted
  changes from other work** (files under `apps/intake/`, `mockups/`,
  `plans/009`–`011`, `journey.png`, `.claude/launch.json`). Do not stage or
  commit them.

## Git workflow

- Branch: `advisor/012-appview-ci`
- Commit style is conventional commits — from `git log`:
  `feat(cloud): run ng-v0 fully on the cluster — a live dev-server pod per chat`
- One commit is fine for this plan; message suggestion:
  `ci(appview): run the ng-v0 orchestrator + UI suites in verify and CI`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Establish the baseline BEFORE wiring anything

Install and run both suites by hand. This tells you whether the gate you are
about to add is green today.

```
cd app-preview/orchestrator && npm ci && npm test && npm run typecheck
cd ../ui && npm ci && npm test
```

**Verify**: all four commands exit 0.

**If any of them fail**: STOP and report, with the failing test names and the
error output. Do not fix `app-preview/` source to make them pass — a
pre-existing failure is a real finding that the operator must see and triage
separately. It is entirely possible this gate has been red for a while; that
is the point of adding it.

### Step 2: Add the Taskfile recipes

Add these three recipes to `Taskfile.yml`. Put them immediately after the
existing `test-web` recipe (which ends at the line `- npx ng test shared`), so
the test recipes stay together. Match the surrounding comment style — the file
explains *why* each recipe exists, not just what it does.

```yaml
  # The ng-v0 half (app-preview/): its own npm projects with their own
  # lockfiles, so they need their own install. Until this recipe existed,
  # `task verify` went green without ever running the orchestrator's ~24 test
  # files or the UI's 45 specs — see plans/012.
  appview-install:
    desc: Install the app-preview orchestrator + UI dependencies
    cmds:
      - cd app-preview/orchestrator && npm ci
      - cd app-preview/ui && npm ci

  appview-test:
    desc: ng-v0 orchestrator + UI unit tests (vitest + ng test)
    cmds:
      - cd app-preview/orchestrator && npm test
      - cd app-preview/ui && npm test

  appview-typecheck:
    desc: ng-v0 orchestrator typecheck (tsc --noEmit)
    cmds:
      - cd app-preview/orchestrator && npm run typecheck
```

Use `cd <dir> && …` inside `cmds` rather than the recipe-level `dir:` key,
because each of `appview-install` and `appview-test` spans two different
directories. (The single-directory recipes above, like `test`, use `dir:` —
both styles are already present in this file.)

**Verify**: `task` lists `appview-install`, `appview-test`, and
`appview-typecheck` with their descriptions.

### Step 3: Chain the new recipes into `verify`

Edit the `verify` recipe so it reads:

```yaml
  verify:
    desc: "Everything: lint + pytest + vitest(x3) + appview + build(x2) + smoke. Green = safe"
    cmds:
      - task: lint
      - task: test
      - task: test-web
      - task: appview-typecheck
      - task: appview-test
      - task: build
      - task: smoke
      - echo ""
      - echo "✓ VERIFY PASSED — tests, build, and smoke all green"
```

Place the two app-preview tasks **after** `test-web` and **before** `build`:
tests before builds, matching the existing order, and the cheap typecheck
before the slower test run so an obvious type error fails fast.

Do **not** add `appview-install` to `verify`. `verify` is the everyday local
gate and must not re-run `npm ci` on every invocation; developers run
`appview-install` once. CI installs explicitly in step 4.

**Verify**: `task verify` runs to completion and prints `✓ VERIFY PASSED`.
This is the slow one — expect several minutes. Confirm from the scrolled
output that the orchestrator's vitest run and the UI's `ng test` both actually
executed (you will see their test counts).

### Step 4: Add the CI job

Add a third job to `.github/workflows/ci.yml`, after the existing `verify` job
and before or after `test-mssql` (order of jobs in the file does not affect
execution — they run in parallel).

```yaml
  verify-appview:
    runs-on: ubuntu-latest
    # The ng-v0 half (app-preview/) is two npm projects with their own
    # lockfiles, outside the repo-root Angular workspace — the `verify` job's
    # root `npm ci` does not install them. Its own job so it runs in parallel
    # and a failure names the right half of the repo. See plans/012.
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc

      - name: Set up Task
        uses: arduino/setup-task@v2
        with:
          version: 3.x
          repo-token: ${{ secrets.GITHUB_TOKEN }}

      - name: Install app-preview dependencies
        run: task appview-install

      - name: Typecheck + test
        run: |
          task appview-typecheck
          task appview-test
```

Notes on choices, so you do not "improve" them:
- **No `cache: npm`** on `setup-node` here. The existing `verify` job caches on
  `cache-dependency-path: package-lock.json` (the root lockfile). This job has
  two different lockfiles; leave caching off rather than guess at a multi-path
  cache key. It is a correctness-first change, not a speed one.
- **No `paths:` filter.** A path-filtered job that is skipped still has to be
  handled in branch-protection required checks, and getting that wrong makes
  the gate silently optional. Always-run is the safe default.
- **No uv setup.** This job runs no Python.

**Verify**: `python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/ci.yml')); print(sorted(d['jobs']))"`
prints `['test-mssql', 'verify', 'verify-appview']`.

### Step 5: Confirm the UI test runner works headless

`app-preview/ui`'s `npm test` is `ng test`. Angular's default test runner can
require a browser. Step 1 already proved it works on your machine; the risk is
CI, which has no display.

Check how the UI configures its test runner:

```
grep -rn "browser\|karma\|vitest\|jsdom" app-preview/ui/angular.json app-preview/ui/package.json
```

If the UI tests are configured to launch a real headed browser (e.g. a Karma
`browsers: ['Chrome']` config with no headless variant), STOP and report —
wiring that into CI needs a headless-browser decision that is the operator's
to make, and the orchestrator half of this plan is still worth landing alone.
If they run headless (jsdom, ChromeHeadless, or Angular 22's default vitest
runner — the repo root uses vitest), continue.

**Verify**: you can state in your report which runner the UI tests use.

### Step 6: Update the index

Add a row for this plan in `plans/README.md` under a new heading (see the
existing "Intake motion plans" section for the shape) and set its status.

**Verify**: `grep -n "012" plans/README.md` shows your row.

## Test plan

This plan adds no application tests — it makes ~12,000 lines of *existing*
tests actually run. The verification is the gate itself:

- `task appview-test` runs the orchestrator's 24 `*.test.ts` files and the
  UI's 45 specs. Record the test counts in your report.
- `task verify` end-to-end exits 0 and prints `✓ VERIFY PASSED`.
- The new CI job is syntactically valid YAML with the expected job list.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `task appview-install` exits 0
- [ ] `task appview-typecheck` exits 0
- [ ] `task appview-test` exits 0
- [ ] `task verify` exits 0 and prints `✓ VERIFY PASSED`
- [ ] `grep -c "appview" Taskfile.yml` returns at least 6 (3 recipe names + 3 references in `verify` — plus the pre-existing dev recipes will push this higher; any value ≥ 6 is fine)
- [ ] `python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); print(sorted(d['jobs']))"` prints `['test-mssql', 'verify', 'verify-appview']`
- [ ] `git status --porcelain` shows **no** modified files under `app-preview/` other than the two `package-lock.json` files if `npm ci` touched them (it should not — `npm ci` does not rewrite lockfiles; if one changed, report it)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- **Any app-preview test or typecheck fails in Step 1.** Report the failures
  verbatim. Do not modify `app-preview/` source or tests to go green. A
  pre-existing red suite is exactly the finding this plan exists to surface,
  and the operator decides what to do about it.
- `npm ci` fails in either project (e.g. a lockfile out of sync with
  `package.json`) — report the error; do not run `npm install` to "fix" it,
  as that would rewrite a lockfile outside this plan's scope.
- The UI tests require a headed browser (Step 5).
- `task verify` becomes so slow it times out in your environment — report the
  wall-clock time rather than trimming what runs.
- The `Taskfile.yml` or `ci.yml` content you find does not match the
  "Current state" excerpts above.

## Maintenance notes

For whoever owns this next:

- **Reviewers should check**: that `appview-install` is NOT in the `verify`
  chain (it would make every local verify re-install), and that the new CI job
  has no path filter.
- **Deliberately deferred out of this plan** (each is its own follow-up):
  1. **Lint + format for `app-preview/`.** 227 source files with no eslint
     config and no prettier coverage. Expect a large first-run diff; land the
     formatting commit separately from any rule changes.
  2. **`migrations-parity.test.ts` now has teeth.** That test
     (`app-preview/orchestrator/test/migrations-parity.test.ts`) guards the
     hand-written `migrations/sqlite/` vs `migrations/mssql/` pair from drift.
     It has existed with no automated gate; once this plan lands, adding a
     `migrations/sqlite/00N.sql` without its mssql twin will finally fail CI.
     That is the single highest-value consequence of this plan.
  3. **Playwright e2e** in a separate, optional workflow.
- If branch protection lists required checks, add `verify-appview` to it —
  otherwise a red app-preview suite will not block a merge.
