# Plan 016: Make the agent-facing docs true again (`make verify`, dead `web/` paths)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5b9facb..HEAD -- CLAUDE.md AGENTS.md DESIGN.md VERIFICATION.md`
> If any of those changed since this plan was written, compare the "Current
> state" excerpts against the live files before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `5b9facb`, 2026-07-21

## Why this matters

Two files in this repo exist specifically to orient an AI agent that has never
seen the codebase: `CLAUDE.md` (loaded automatically) and `AGENTS.md` (which
calls itself *"the single entry point for any AI agent (or human) starting
cold"*). Both are wrong in ways that actively mislead.

`CLAUDE.md`'s **rule #1** tells every agent to run `make verify`. There is no
`Makefile` in this repo — Task replaced it in ADR 0017 Phase 3. An agent that
follows the project's own first rule literally gets `make: command not found`
and then improvises, which is exactly the behaviour the file exists to prevent.

`AGENTS.md`'s "Where things live" table points at `web/src/app/kit/kit.ts` and
`web/src/styles.css`. There is no `web/` directory — the repo split into
`apps/intake`, `apps/console`, and `packages/shared` (ADR 0017). And the table
omits `api/app/kube_runner.py`: 3,745 lines, 20% of the backend, and the **only
runner the cluster actually uses** (`deploy/base/configmap.yaml` sets
`FACTORY_RUNNER: "kube"`).

The cost is paid on every single cold start: an agent looks for `web/`, does
not find it, rediscovers the layout from scratch, and never learns that the
production runner exists.

**Explicit operator instruction for this plan: do not add a Makefile.** The fix
is to correct the docs to say `task verify`, not to make `make verify` work.

## Current state

### `CLAUDE.md` — the whole file is short; line 7 is the problem

```markdown
Three highest-value rules:

1. **Verify with `make verify`** before merging anything — lint + pytest +
   vitest + Angular build + smoke must all be green.
```

Verified: `ls Makefile` → `No such file or directory`.
The real command, per `AGENTS.md:32` and `Taskfile.yml:138`, is `task verify`.

### `AGENTS.md` §5 "Conventions that bite" → Frontend (lines ~160–171)

```markdown
- **Kit components.** Shared UI primitives live in
  `web/src/app/kit/kit.ts`.  Reach for them before writing new component
  boilerplate.
- **Design tokens first.** Global design tokens are in
  `web/src/styles.css`.  Do not introduce new global CSS without checking
  whether a token already covers it.
```

### `AGENTS.md` §6 "Where things live" (lines 176–194) — the table as it stands

```markdown
| `api/app/routers/` | HTTP layer wired in `main.py` — `system`, `registry`, `events` (feed/comments/inbox), `gates` (gate + recovery actions), `mission` (control-center aggregate), `requests` (CRUD/intake/submit) |
| `web/src/app/kit/kit.ts` | Shared Angular UI kit components |
| `web/src/styles.css` | Global design tokens |
| `sample/` | Template workspace copied for each real pipeline run |
| `scripts/smoke.sh` | End-to-end lifecycle smoke test |
| `docs/adr/` | Architecture Decision Records 0001–0015 |
```

### The verified truth for each wrong claim

| Line | Claim | Verified reality |
|---|---|---|
| `CLAUDE.md:7` | `make verify` | No `Makefile`. `task verify` (`Taskfile.yml:138`). |
| `AGENTS.md:166` | kit at `web/src/app/kit/kit.ts` | `packages/shared/src/lib/kit/` — separate files: `avatar.ts`, `glyph.ts`, `icon.ts`, `mark.ts`, `pill.ts`, `sig.ts`, `track-chip.ts`, plus `autofocus.ts` and `index.ts`. No `kit.ts`. |
| `AGENTS.md:169` | tokens at `web/src/styles.css` | Two files: `apps/intake/src/styles.css` and `apps/console/src/styles.css`. |
| `AGENTS.md:187` | 6 routers | 9: `attachments`, `events`, `gates`, `harness`, `mission`, `operators`, `registry`, `requests`, `system`. |
| `AGENTS.md:188` | `web/src/app/kit/kit.ts` row | Same as :166. |
| `AGENTS.md:189` | `web/src/styles.css` row | Same as :169. |
| `AGENTS.md:190` | `sample/` = "copied for each real pipeline run" | True only for `FACTORY_RUNNER=agent`. `api/app/settings.py:59` reads `SAMPLE = Path(os.environ.get("FACTORY_SAMPLE", str(REPO_DIR / "sample")))`, and `scripts/kind-smoke-golden.sh:29` sets `FACTORY_SAMPLE=/srv/templates/golden`. |
| `AGENTS.md:192` | ADRs `0001–0015` | Files present: 0001–0017 and 0021–0026. **0018, 0019, 0020 do not exist on `main`.** |
| `AGENTS.md:96` | `FACTORY_CLI` values `codex \| claude`, default `codex (for now)` | `api/app/agent_exec.py:50` → `os.environ.get("FACTORY_CLI", "opencode")` (ADR 0024). `deploy/base/configmap.yaml:9` pins `FACTORY_CLI: "codex"`. Three values exist; code default and cluster value differ. |
| `DESIGN.md:1` | "implemented in `web/src/styles.css`" | Same as :169. |
| `VERIFICATION.md:48` | "`api/app/` or `web/src/app/core/`" | `web/` does not exist; the equivalent is `packages/shared/src/lib/`. |

Paths absent from the §6 table entirely, in rough order of how much an agent
needs them: `api/app/kube_runner.py`, `api/app/kube_jobs.py`,
`api/app/kube_client.py`, `api/app/workspace.py`, `api/app/settings.py`,
`api/app/auth.py`, `api/app/deploy_manifests.py`, `deploy/`, `docker/sf-agent/`,
`templates/golden/`, `app-preview/`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Prove a path exists | `ls <path>` | the listing, not an error |
| Full gate (final check) | `task verify` | `✓ VERIFY PASSED` |
| Find dead `web/` refs | `grep -rn "web/src" --include='*.md' . \| grep -v node_modules \| grep -v .claude/worktrees` | see Step 4 |

You are editing Markdown only. `task verify` will not catch a documentation
error — your verification is the `ls`/`grep` evidence for every claim you
write.

## Scope

**In scope** (the only files you should modify):
- `CLAUDE.md`
- `AGENTS.md`
- `DESIGN.md` (line 1 only)
- `VERIFICATION.md` (line 48 only)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):
- **Do NOT create a `Makefile`.** Explicit operator instruction.
- **Historical documents that mention `make verify`.** `git ls-files '*.md' |
  xargs grep -ln "make verify"` returns ~34 files, but almost all are *records
  of the past*, and at the time they were written `make verify` was correct:
  `docs/adr/*` (decision records — never rewrite history), `docs/reviews/*`,
  `docs/prompts/*`, `docs/superpowers/plans/*` and `specs/*`,
  `docs/wayfinder/*`, and `plans/003`–`008`. Also `plans/README.md` lines 22
  and 81, which describe what the June 2026 batch did. Leave every one of them
  alone. Only `CLAUDE.md` is a *live instruction* that is wrong.
- **`docs/IMPROVEMENTS.md`** — check it briefly; if it reads as a historical
  record, leave it. If it reads as live instructions, report it rather than
  editing it.
- **The `FACTORY_CLI` config drift itself.** `AGENTS.md` must describe reality
  accurately, but do **not** change `deploy/base/configmap.yaml` or
  `agent_exec.py` to resolve the disagreement — which value the cluster should
  use is the operator's decision, not a documentation fix.
- **The missing ADRs 0018–0020.** Document that the numbers are absent; do not
  write, restore, or renumber ADRs.
- **The working tree has uncommitted changes from other work** (files under
  `apps/intake/`, `mockups/`, `plans/009`–`011`, `journey.png`). Do not stage
  or commit them.

## Git workflow

- Branch: `advisor/016-docs-truth`
- Conventional commits, e.g.
  `docs: fix the agent entry points — task verify, and the post-split paths`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix `CLAUDE.md` rule #1

Change `make verify` to `task verify`. Also check the rest of the file for any
other stale command or path and fix only what you can verify with an `ls` or a
`grep`.

**Verify**:
- `grep -c "make verify" CLAUDE.md` returns 0.
- `grep -n "task verify" CLAUDE.md` shows the rule.

### Step 2: Fix the `AGENTS.md` §5 Frontend prose

Rewrite the two bullets at ~166 and ~169 against the correction table above.
Suggested shape (confirm each path with `ls` before you write it):

```markdown
- **Kit components.** Shared UI primitives live in
  `packages/shared/src/lib/kit/` (one file per component — `avatar`, `glyph`,
  `icon`, `mark`, `pill`, `sig`, `track-chip`), re-exported through
  `packages/shared/src/public-api.ts`.  Reach for them before writing new
  component boilerplate.
- **Design tokens first.** Each app owns its global tokens:
  `apps/intake/src/styles.css` and `apps/console/src/styles.css`.  Do not
  introduce new global CSS without checking whether a token already covers it.
  (The two files duplicate most token names and have already drifted on a
  couple of values — check both when changing one.)
```

Confirm the `public-api.ts` re-export claim before writing it:
`grep -n "kit" packages/shared/src/public-api.ts`. If the kit is not exported
there, drop that clause rather than guessing.

**Verify**: `grep -c "web/src" AGENTS.md` is now lower; every path you wrote
passes `ls`.

### Step 3: Rewrite the `AGENTS.md` §6 table

Apply every row correction from the table above, and add the missing rows.
Suggested additions (verify each with `ls` first):

```markdown
| `api/app/kube_runner.py` | The runner the CLUSTER uses (`FACTORY_RUNNER=kube`) — stage/gate Jobs, preview loop, build+deploy, rollback, import-edit. The largest file in the backend |
| `api/app/kube_jobs.py` / `kube_client.py` | Job manifests, and the thin k8s wire seam they are tested against (`FakeKubeClient`) |
| `api/app/workspace.py` | Git-as-workspace — frozen-surface hash, graded-SHA merge, bundle import |
| `api/app/settings.py` | Every env-driven knob in one place (ADR 0013) |
| `api/app/auth.py` | Entra JWT wall + identity seam (`FACTORY_AUTH`) |
| `api/app/deploy_manifests.py` | Factory-owned, digest-pinned manifests for produced apps |
| `deploy/` | kind + Calico + kustomize manifests (`task kind-up kind-load kind-deploy`) |
| `docker/sf-agent/` | The stage/gate container image and its entrypoint + gate script |
| `templates/golden/` | The production template workspace (`FACTORY_SAMPLE`) |
| `app-preview/` | The ng-v0 live-editing surface: orchestrator (Node/Hono), UI, and the per-chat sandbox pod image |
```

Fix the four wrong rows:
- routers row: list all 9.
- delete the two `web/…` rows, replaced by the paths in Step 2.
- `sample/` row: say it is the unit-test / `FACTORY_RUNNER=agent` workspace and
  that the cluster golden profile overrides it with `FACTORY_SAMPLE`.
- ADR row: `Architecture Decision Records 0001–0026 (0018–0020 are absent from
  main — the decisions shipped, the records did not)`.

**Verify**:
- `grep -c "web/src" AGENTS.md` returns 0.
- `for p in $(grep -oE '`[a-z][a-zA-Z0-9_./-]+`' AGENTS.md | tr -d '`' | grep '/' | sort -u); do [ -e "$p" ] || echo "MISSING: $p"; done`
  — every reported MISSING must be either a glob/illustrative path (e.g.
  `workspaces/<ref>/`) or something you then fix. Report the list you got.

### Step 4: Fix `AGENTS.md` §3's `FACTORY_CLI` row, and `DESIGN.md` / `VERIFICATION.md`

- `AGENTS.md:96`: change the values to `codex | claude | opencode` and state
  the truth plainly, e.g. default `opencode` (ADR 0024), while
  `deploy/base/configmap.yaml` pins the cluster to `codex`. Do not resolve the
  drift — just stop hiding it.
- `DESIGN.md:1`: replace `web/src/styles.css` with the two real token files.
- `VERIFICATION.md:48`: replace `web/src/app/core/` with
  `packages/shared/src/lib/`.

**Verify**:
`grep -rn "web/src" --include='*.md' . | grep -v node_modules | grep -v '.claude/worktrees' | grep -v '^./docs/' | grep -v '^./plans/00'`
returns nothing. (The excluded paths are the historical records left alone by
design — if a hit appears outside them, fix it.)

### Step 5: Final gate and index

Run the full gate once to confirm nothing was broken (Markdown edits should not
affect it, but `task lint` includes a prettier check that may cover Markdown).

**Verify**:
- `task verify` → `✓ VERIFY PASSED`.
- `grep -n "016" plans/README.md` shows your row.

## Test plan

There are no unit tests for documentation. Verification is evidential — for
**every** factual claim you write or keep, you must have run the `ls` or `grep`
that proves it. In your final report, list:

- each path you added to the §6 table, with the `ls` result;
- the output of the Step 3 "MISSING" loop;
- the `grep -c "web/src" AGENTS.md` and `grep -c "make verify" CLAUDE.md`
  results (both 0).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -c "make verify" CLAUDE.md` returns 0
- [ ] `grep -n "task verify" CLAUDE.md` returns the rule
- [ ] `ls Makefile` still returns "No such file or directory" (no Makefile was created)
- [ ] `grep -c "web/src" AGENTS.md DESIGN.md VERIFICATION.md` returns 0 for all three
- [ ] `grep -c "0001–0015\|0001-0015" AGENTS.md` returns 0
- [ ] `grep -n "kube_runner" AGENTS.md` returns at least one row in §6
- [ ] `grep -n "app-preview" AGENTS.md` returns at least one row in §6
- [ ] `grep -n "opencode" AGENTS.md` shows the corrected `FACTORY_CLI` row
- [ ] The Step 3 path loop reports no MISSING path that is not an intentional glob
- [ ] `task verify` exits 0
- [ ] `git status --porcelain` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- You are tempted to create a `Makefile` or a `make` shim. Explicitly
  forbidden.
- A path in the correction table does not match what you find on disk — the
  repo has drifted since this plan was written, and a doc fix built on a stale
  survey is just new wrong documentation.
- You find a *live* instruction (not a historical record) outside the in-scope
  files that is also wrong — report it; do not expand the plan.
- `task verify` fails. It should be unaffected by Markdown edits; if prettier
  reformats your Markdown, accept its formatting rather than fighting it, but
  report that it happened.

## Maintenance notes

For whoever owns this next:

- **What a reviewer should scrutinise**: that no historical document was
  rewritten, and that every new path in the §6 table actually exists.
- **The structural problem this does not solve**: `AGENTS.md` §6 is a
  hand-maintained path index that goes stale on every refactor — it has now
  been wrong since ADR 0017. Consider either (a) trimming it to the ~10 paths
  that genuinely orient a newcomer and pointing at the tree for the rest, or
  (b) adding a cheap CI check that every backticked repo-relative path in
  `AGENTS.md` and `CLAUDE.md` exists. Option (b) is a few lines of shell and
  would have caught this the day the split landed — it is the higher-leverage
  follow-up.
- **Known, deliberately left alone**: ADR numbers 0018–0020 are burned. The
  three decisions they described (secret-scan gate, REQUEST-CHANGES
  escalation, architecture approval gate) all shipped on `main` by other
  routes; the records live only on the abandoned `worktree-dre6-harden`
  branch. If someone wants them on `main`, that is its own change — and
  whoever writes ADR 0027 should know 0018–0020 will never be filled.
- **Also known, not fixed here**: `HANDOFF.md`, `RESEARCH.md`, and `DESIGN.md`
  all date from 2026-06-05/10 and describe a project that no longer exists,
  yet sit in the repo root next to the live docs with no "historical" marker.
  Moving them to `docs/archive/` (which already exists) with a "superseded by"
  header is a small, separate cleanup.
