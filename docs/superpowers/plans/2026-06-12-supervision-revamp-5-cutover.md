# Supervision Revamp — Plan 5: Cutover

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the old Linear console. Flip the default landing to Mission control, delete Board / Pipeline / the old issue page / the Linear "New issue" composer, repoint every remaining link, run the assignee vocabulary purge, and record the decision in an ADR — with `make verify` green at every commit and the app shippable throughout.

**Architecture:** This is the one destructive plan. Everything in Plans 1–4 was additive and is live beside the old surfaces; this plan removes the old surfaces. To keep each commit green, the order is **rewire → delete → purge → ADR**: first remove every reference to the doomed components (routes, nav, palette, G-nav, links), then delete the now-orphaned files, then strip the dormant `assignee` field, then document. `reporter` ("filed by") is a KEPT concept and is never touched.

**Tech Stack:** Angular 22 (web) + FastAPI/SQLAlchemy (api). Web commands from `web/`; api from `api/` with `uv run`; full gate `make verify` from repo root.

**Spec:** `docs/superpowers/specs/2026-06-12-ui-supervision-revamp-design.md` §4 (IA) + §10 (cutover step 6). This is phase 5 of 5 — the finale.

**Ground truth gathered (blast radius):**
- Default route + redirects to `/admin/pipeline`: `app.routes.ts:33`, `submitter/login.ts:97` (admin branch), `submitter/sub-shell.ts:82`.
- Deleted-component refs: `app.routes.ts` (pipeline/board/issue routes), `admin/admin-shell.ts` (Board+Pipeline navrows, ViewSeg class + palette/G-nav `p`/`b` entries, new-issue composer + the post-create redirect at line 481), `admin/list.ts` (ViewSeg import/usage, issue link at :145).
- `assignee` (NOT load-bearing — no backend logic, display only): backend `api/app/models.py:93-95`, `api/app/schemas.py:116-118`, `api/app/seed.py:14-15` (KP/RM dicts); frontend `web/src/app/core/models.ts`, `util.spec.ts:46-48` (fixture), and reads in board.ts/pipeline.ts/issue.ts/list.ts/feed.ts/queue.ts. `reporter` is separate and KEPT.
- Old issue links to repoint → `/admin/requests/:id`: `admin-shell.ts:481`, `list.ts:145` (board.ts/pipeline.ts/issue.ts are being deleted, so their links go with them).
- Dead util exports after deletion: `boardGlyph`, `STAGE_SHORT` (pipeline), possibly `inFlight`/`IN_FLIGHT_STAGES`/`POST_APPROVAL_STAGES` if no surviving consumer — let the compiler/lint confirm.

**Repo rules:** every commit keeps `make verify` green and the app runnable; status by shape; tokens not hardcoded; keyboard parity; commits `feat(web):`/`refactor(web):`/`feat(api):`/`docs(adr):`. Dev stack may be up (API :8001, web :4200). This plan COMMITS deletions on the branch (consistent with Plans 1–4); it does not touch `main`.

---

### Task 1: Flip the landing + repoint all redirects to Mission control

Smallest first step: make Mission control the home, with NO deletions yet (Board/Pipeline still reachable by URL). Keeps everything green.

**Files:**
- Modify: `web/src/app/app.routes.ts`
- Modify: `web/src/app/submitter/login.ts`
- Modify: `web/src/app/submitter/sub-shell.ts`

- [ ] **Step 1: Default route** — in `app.routes.ts`, change the `{ path: 'admin', pathMatch: 'full', redirectTo: 'admin/pipeline' }` to `redirectTo: 'admin/mission'`.

- [ ] **Step 2: Login redirect** — in `submitter/login.ts:97`, change the admin branch `'/admin/pipeline'` to `'/admin/mission'`.

- [ ] **Step 3: Sub-shell redirect** — in `submitter/sub-shell.ts:82`, change `'/admin/pipeline'` to `'/admin/mission'`.

- [ ] **Step 4: Web gate + check** — `cd web && npx ng build && npx ng lint && npx ng test` green. Visually: signing in as a reviewer lands on `/admin/mission`; `/admin` redirects there.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/app.routes.ts web/src/app/submitter/login.ts web/src/app/submitter/sub-shell.ts
git commit -m "feat(web): Mission control is the default admin landing (redirects flipped)"
```

---

### Task 2: Strip the shell of Board/Pipeline/ViewSeg + replace New-issue with New request

Remove the doomed surfaces from the shell chrome and convert the Linear "New issue" composer into a plain "New request" that routes to the submitter intake (spec §4).

**Files:**
- Modify: `web/src/app/admin/admin-shell.ts`

- [ ] **Step 1: Remove the Board + Pipeline navrows** — delete the two `<button class="navrow" ... 'pipeline'>` and `... 'board'>` blocks. Mission control becomes the top Primary entry (it already exists from Plan 2). The remaining Primary nav order: Mission control, List, Needs me, Approval queue.

- [ ] **Step 2: Rename "Approval queue" → "Gates"** — in the Approval-queue navrow, change the visible label text to `Gates` and the tooltip to `Gates  G G` (keep the route `/admin/queue` and update the G-nav key from `t` to `g` in the `nav` record AND the tooltip; OR keep `G T` to avoid churn — pick one and keep the tooltip and the `nav` map consistent). Leave the queue route/component as-is. State your choice in the report.

- [ ] **Step 3: Remove the G-nav + palette + cheat entries for Board/Pipeline** — in `onKey`'s `nav` record remove `p:` and `b:`. In the command-palette actions array remove the "Go to Pipeline" and "Go to Board" entries. In the cheat-sheet nav list remove Pipeline/Board rows. (Mission control's `m:` entry stays.)

- [ ] **Step 4: Delete the `ViewSeg` component** — remove the entire `@Component({ selector: 'sf-view-seg', … }) export class ViewSeg { … }` block at the bottom of `admin-shell.ts` (it is only used by list.ts, fixed in Task 3). Remove any now-unused imports it required.

- [ ] **Step 5: Convert New-issue → New request** — the "New issue" button (top of the sidebar), the `C` key handler, and the palette "New issue" action should now navigate to `/submit/new` (the submitter intake) instead of opening the composer. Relabel the button text to `New request`. DELETE the new-issue composer modal markup (`@if (newIssue()) { … }`), its state (`newIssue`, `niType`, `niTitle`, `niDesc`, and any `submitNewIssue`/create handler + the `/admin/issue/${r.id}` redirect at line 481), and the now-unused imports (`sfAutofocus` if unused elsewhere, the type-card data, etc.). The `C` key now does `this.go('/submit/new')`; keep the Escape/typing guards. Keep the `C` exclusion logic intact for queue/request-detail (those pages own C for Cancel).

- [ ] **Step 6: Web gate + check** — `cd web && npx ng build && npx ng lint && npx ng test` green. Visually: the sidebar shows Mission control / List / Needs me / Gates (no Board/Pipeline); "New request" and the `C` key open the submitter intake at `/submit/new`; ⌘K palette no longer lists Pipeline/Board/New-issue-composer; `G P`/`G B` do nothing.

- [ ] **Step 7: Commit**

```bash
git add web/src/app/admin/admin-shell.ts
git commit -m "refactor(web): shell drops Board/Pipeline/ViewSeg; New issue becomes New request → intake"
```

---

### Task 3: List → "All requests" (archive lens) — drop ViewSeg, repoint, relabel

**Files:**
- Modify: `web/src/app/admin/list.ts`

- [ ] **Step 1: Remove ViewSeg** — drop `ViewSeg` from the import and the `imports:[]` array, and delete the `<sf-view-seg headerRight active="list" />` line.

- [ ] **Step 2: Repoint the issue link** — change `this.router.navigateByUrl('/admin/issue/${r.id}')` at `list.ts:145` to `/admin/requests/${r.id}`.

- [ ] **Step 3: Drop the assignee column** — remove the assignee avatar/owner cell from the row template (the `@if (r.assignee_initials)` / `sf-avatar` block) and any assignee-based grouping; keep glyph · title · type · app · stage · age. (The List stays a flat filterable archive; the kept identity is the reporter/"filed by" if shown — leave reporter as-is.)

- [ ] **Step 4: Relabel** — set the page/header title to `All requests` (the AdminShell `title` input and any header text), matching spec §4. Keep `active="list"`.

- [ ] **Step 5: Web gate + check** — green. Visually: `/admin/list` is "All requests", no List/Board/Pipeline toggle, no assignee column, rows open `/admin/requests/:id`.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/admin/list.ts
git commit -m "refactor(web): List becomes All requests — archive lens, no view toggle, no assignee"
```

---

### Task 4: Delete the orphaned components

Now nothing references them. Delete and confirm.

**Files:**
- Delete: `web/src/app/admin/board.ts`, `web/src/app/admin/pipeline.ts`, `web/src/app/admin/issue.ts`
- Modify: `web/src/app/app.routes.ts` (remove the three routes)
- Modify: `web/src/app/core/util.ts` (remove now-dead exports)

- [ ] **Step 1: Remove the routes** — in `app.routes.ts` delete the `admin/board`, `admin/pipeline`, and `admin/issue/:id` route blocks.

- [ ] **Step 2: Delete the files** — `git rm web/src/app/admin/board.ts web/src/app/admin/pipeline.ts web/src/app/admin/issue.ts`.

- [ ] **Step 3: Remove dead util exports** — run `cd web && npx ng build`; it will error on any remaining import of the deleted files (there should be none) and lint will flag unused exports. Remove `boardGlyph` and `STAGE_SHORT`/pipeline-only helpers from `core/util.ts` that no surviving file imports. For each candidate (`boardGlyph`, `inFlight`, `IN_FLIGHT_STAGES`, `POST_APPROVAL_STAGES`, `postApproval`), grep `web/src` for imports; remove ONLY those with zero surviving consumers. Keep anything still used (e.g. `plainStage`, `confirmSteps`, `gateLabel`, `timeAgo`, `STAGE_LABEL`).

- [ ] **Step 4: Full web gate** — `cd web && npx ng test && npx ng lint && npx ng build && npm run format:check` green. Grep `grep -rn "admin/issue\|admin/board\|admin/pipeline\|ViewSeg\|boardGlyph" web/src` returns nothing (except possibly a comment) — confirm zero live refs.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(web): delete Board, Pipeline, and the old issue page + dead util helpers"
```

---

### Task 5: Vocabulary purge — remove the dormant `assignee` field

`assignee` now has zero UI consumers. Remove it from both type layers and the seed. `reporter` stays untouched.

**Files:**
- Modify: `api/app/models.py`, `api/app/schemas.py`, `api/app/seed.py`
- Modify: `web/src/app/core/models.ts`, `web/src/app/core/util.spec.ts`
- Possibly: `web/src/app/admin/feed.ts`, `web/src/app/admin/queue.ts` (residual reads)

- [ ] **Step 1: Backend** — in `api/app/models.py` remove the three `assignee`/`assignee_initials`/`assignee_color` columns from `Request`. In `api/app/schemas.py` remove the three `assignee*` fields from `RequestOut`. In `api/app/seed.py` remove the `assignee*` keys from the `KP` and `RM` dicts (keep them as `reporter`-shaped or just drop the assignee keys — the dicts are spread into `req(...)`; ensure the remaining keys are still valid Request fields, e.g. reduce `KP`/`RM` to nothing-assignee or inline the reporter). The SQLite column is orphaned harmlessly (migrate() only adds columns; ADR 0013).

- [ ] **Step 2: Backend tests** — `cd api && uv run pytest -q`. Fix any test asserting on `assignee` (grep `api/tests` for `assignee`). Run `uv run ruff check .`.

- [ ] **Step 3: Frontend** — in `web/src/app/core/models.ts` remove `assignee`/`assignee_initials`/`assignee_color` from the `FactoryRequest` interface. In `web/src/app/core/util.spec.ts` remove the three `assignee*: null` lines from the test fixture. Grep `web/src` for `assignee` and remove any residual reads in `feed.ts`/`queue.ts` (display only).

- [ ] **Step 4: Full gate** — `cd web && npx ng test && npx ng lint && npx ng build`; `cd api && uv run pytest -q && uv run ruff check .`. `grep -rn assignee web/src api/app` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: vocab purge — remove the dormant assignee field (reporter/filed-by kept)"
```

---

### Task 6: ADR 0015 — supervision-first console (supersedes 0010)

**Files:**
- Create: `docs/adr/0015-supervision-first-console.md`
- Modify: `docs/adr/0010-pipeline-view-default-landing.md` (status → superseded)

- [ ] **Step 1: Read `docs/adr/0010-pipeline-view-default-landing.md`** to mirror the repo's ADR format and reference its decision accurately.

- [ ] **Step 2: Write `docs/adr/0015-supervision-first-console.md`**:

```markdown
# Supervision-first console: Mission control replaces the Linear board as the operator home

**Status:** accepted (supersedes ADR 0010)

A two-track review (code critique + agent-console research) found the Linear-style
paradigm was the right visual craft but the wrong information architecture for an
autonomous-but-governed factory: a Kanban board models human-owned work pulled through
columns, but here agents do the work and a few humans only govern (approve gates, handle
escalations). The autonomous stages were structurally empty columns; the schema carried
human-labor vocabulary (assignee/owner) the domain doesn't have.

We re-centre the operator console on the three supervision questions — what needs me,
what's running, can I trust it — delivered by Mission control (ADR 0014's step-level
trace + per-gate evidence + the steer verb). Concretely:

- **Mission control is the default landing** (`/admin/mission`), superseding ADR 0010's
  Pipeline-as-default. Bands: Needs me (gates with evidence) → In flight (live runs) →
  Stalled → Recent.
- **The Kanban Board and the Pipeline view are removed.** Their attention-grouping is
  absorbed into Mission control; List survives as the flat "All requests" archive lens.
- **The Jira-grade issue page is replaced** by the request-detail trace page
  (`/admin/requests/:id`): a stage-grouped trace with provenance, not a ticket with
  labels/checklist/subscribers.
- **Vocabulary follows consequence, not labor:** filed by (provenance) / waiting on (who
  must act at the current gate) / decided by (gate history) replace assignee/owner. The
  dormant `assignee` field is removed; `reporter` ("filed by") is kept.
- **Admins file via the same intake as submitters** ("New request" → `/submit/new`); the
  Linear "New issue" composer (labels/priority/assignee) is gone.

## Consequences

- ADR 0010 (Pipeline as default landing) is superseded; the Pipeline view no longer exists.
- ADR 0004 (milestone summaries, no streaming) and ADR 0014 (step-level trace) are
  unchanged — the supervision surfaces read the same polled event rail.
- The dark theme (token swap) and the submitter's plain-language activity line ship with
  this revamp; the submitter face keeps its plain-stage vocabulary.
- The old console's surfaces are deleted, not hidden — there is no fallback board. The
  domain model (Request lifecycle, gates, the two-axis progress_event log) is unchanged.
```

- [ ] **Step 3: Supersede 0010** — in `docs/adr/0010-pipeline-view-default-landing.md`, change its status line to `**Status:** superseded by ADR 0015` (keep the body as the historical record).

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0015-supervision-first-console.md docs/adr/0010-pipeline-view-default-landing.md
git commit -m "docs(adr): 0015 supervision-first console; supersede 0010 (pipeline default)"
```

---

### Task 7: Full verification + final visual proof + whole-revamp review

- [ ] **Step 1: `make verify`** from repo root — lint + pytest + vitest + build + smoke all green. (Run `npm run format:check` in web first; fold a `style(web):` commit if needed.)

- [ ] **Step 2: Final visual proof** (dev stack up; `make reset` + restart API for a clean seed). Capture light AND dark at 1440:
  1. Sign in → lands on Mission control (not Pipeline). Sidebar = Mission control / List / Needs me / Gates (no Board/Pipeline). 
  2. `/admin/list` = "All requests", no view toggle, no assignee column, rows open `/admin/requests/:id`.
  3. "New request" / `C` opens `/submit/new`.
  4. `/admin/board` and `/admin/pipeline` 404 / redirect (route gone) — confirm no dead nav.
  5. Spot-check Mission, a request-detail trace, and the Gates queue still work end to end (approve a spec gate, watch a run, open detail).

- [ ] **Step 3: Whole-revamp smoke** — confirm the success criteria from the spec §3 hold: one-glance test (Mission answers needs-me/running/trust), nothing lost (approve/send-back/cancel/retry/steer/registry/settings/submitter all reachable), calm held (one-amber/one-red, plain submitter vocab, no streaming), dark mode both faces, performance (no poll flash; optimistic gate actions).

- [ ] **Step 4: Report** the before/after (old Pipeline landing → new Mission control), the deleted surfaces, and any deviations. Done = verify green + all checks pass + the old console is gone.

---

## Self-review notes (already applied)

- **Sequencing guarantees green:** rewire (T1–T3) removes all refs before T4 deletes files; the assignee purge (T5) runs only after every UI consumer is gone; each task ends green and shippable.
- **`reporter` is never touched** — only `assignee` (the fake worker) is purged; "filed by" survives.
- **Risk: SQLite orphan column** — removing the model column leaves the existing DB column dormant; `migrate()` only adds (ADR 0013), so no destructive migration runs; fresh DBs simply lack it. Documented.
- **Route rename judgment:** the nav relabels "Approval queue" → "Gates" but keeps the `/admin/queue` route to avoid rippling the queue component's `active` state and links; the spec's `/admin/gates` path is cosmetic and deferred (noted in the task report).
- **Nothing lost (spec criterion 2):** New request → intake replaces the composer; List → All requests preserves browse/search; request-detail replaces the issue page; all gate/recovery/steer actions live on Mission + detail + queue. The only removed capabilities are the Kanban board and the Pipeline view themselves — explicitly approved for deletion.
- **Out of scope (genuine follow-ups, not regressions):** Take-over / Send-back-to-stage still need backend endpoints; the real (non-sim) runner still emits none of the new event kinds; the `--info` dead tokens could be cleaned. These predate the cutover and are tracked in memory.
