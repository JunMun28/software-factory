# Improvements log

A running backlog for the self-paced improvement loop. Each iteration: full
sweep across all dimensions, pick the single highest impact ÷ risk item, ship it
verified (`make verify` green), record it here, commit on `auto/improve`.

> **Loop guidance (set 2026-06-14): risk appetite RAISED.** The cheap zero-risk
> wins are largely done, and the user has greenlit bolder moves. Favor
> high-impact items even at **moderate risk** — behaviour changes, real bug
> fixes, meatier refactors are now in scope. The runner prompt's "prefer small /
> low risk / no sweeping rewrites" bias is **relaxed**. Non-negotiables remain:
> `make verify` must stay green (or full revert), the hard constraints hold
> (append-only `progress_event`, single worker, offline-default seams), and every
> claim needs real evidence. Still one focused improvement per iteration.

## In progress

_(nothing in progress)_

## Done   (most recent first)

- 2026-06-14 · **a11y: Mission J/K moves real DOM focus** · J/K previously moved
  the `.msn-focus` highlight (via `focusIdx`) but never real DOM focus, so
  keyboard focus diverged from the visual cursor and SR users heard nothing.
  Added `viewChildren('frow')` over the gate/run/stalled/done rows and a
  `.focus()` on `rows()[focusAt()]` after each J/K update · evidence:
  `make verify` ✓; dispatched `j`/`k` moves `document.activeElement` across rows
  (gate 1→2→3→back) and `activeElement === .msn-focus` row; screenshot (dark).

- 2026-06-14 · **fix: GitHub-safe `prospective_repo` slug** (first bolder pick) ·
  was space-replace only, so a title with `/` produced a nested path
  (`"a/b"` → `micron/a/b`), punctuation leaked, `"  x  "` left dashes, and an
  empty name gave `micron/`. Now collapses any non-`[a-z0-9._-]` run to a single
  dash, strips separators (including after the `[:30]` clamp), and falls back to
  `app`. Normal titles are unchanged; the gate event and UI both call this one
  function so they stay consistent · evidence: `make verify` ✓ (8 `api_helpers`
  tests, +4 edge cases: slash/punctuation, leading-trailing, empty→app,
  truncation-trailing-dash).

- 2026-06-14 · **test: unit-cover `prospective_repo()`** · new
  `api/tests/test_api_helpers.py` (4 tests, in-memory `Request`, no DB): title
  slug, `new_app_name` precedence, lowercase/space→dash, `[:30]` truncation —
  pins the repo-name contract the admin confirms before irreversible repo
  creation · evidence: `make verify` ✓ (ruff + pytest green incl. 4 new).

- 2026-06-14 · **docs: fix drift in AGENTS.md "Where things live"** · the
  agent-cold-start entry point omitted the entire `api/app/routers/` HTTP layer;
  added a row documenting the 6 routers (system / registry / events / gates /
  mission / requests, wired in `main.py`) and corrected the ADR range "0001–0013"
  → "0001–0015" (15 ADRs exist) · evidence: `make verify` ✓; router purposes
  verified against each module's docstring, ADR count against `docs/adr/`.

- 2026-06-14 · **UX: Mission header subtitle surfaces the stalled count** · the
  always-visible header omitted `stalled` (needs-human, the most urgent state),
  so sighted admins saw *less* than SR users (whom `missionSummary` already tells
  about stalled). Extracted the inline subtitle into a pure, tested
  `missionSubtitle()` that inserts "· N stalled" between gates and builds only
  when present (wording otherwise unchanged) · evidence: `make verify` ✓ (57 web
  tests, +4); live subtitle verified "7 gates waiting on you · 1 stalled · 0
  builds running" in light + dark (1440).

- 2026-06-14 · **a11y: Mission "recently done" rows are keyboard-accessible** ·
  the `.msn-done` rows were click-only (no `tabindex`, not in `focusables()`) —
  keyboard-unreachable, unlike every other actionable Mission row. Added
  `tabindex="0"` + `(focus)` + `[class.msn-focus]` and appended `m.recent` (kind
  `done`) to `focusables()`, so J/K and Tab now reach them and the existing Enter
  handler opens them. Mirrors the gate/run/stalled rows exactly (no button
  conversion, no CSS reset, no key-handler change) · evidence: `make verify` ✓;
  component-state proof (`focusables()` len 14 incl. 6 `done`, `flatIdx` correct,
  highlight binding fires when `focusIdx` lands on a done row); focus highlight
  renders on a done row in light (1440) + dark. Note: programmatic `.focus()`
  can't fire the handler in a background preview window (no document focus) — the
  same is true of the gate rows; verified via component state instead.

- 2026-06-14 · **a11y: aria-live run state on admin request-detail** · the
  supervisor's per-request deep-dive now announces its live state line
  ("Building · Architecture · step 3/6", "Waiting at the merge gate", "Stalled —
  needs a human") to SR users. Extracted the component's `stateLine` into a pure,
  fully-tested `adminStateLine()` helper and made the existing `.rd-state` span a
  `role=status aria-live=polite` region (no new DOM). Completes aria-live across
  all three live watch surfaces (submitter detail, Mission, admin detail) ·
  evidence: `make verify` ✓ (53 web tests, +6); live region verified rendering
  "Waiting at the merge gate"; no visual regression (admin detail light mode).

- 2026-06-13 · **test coverage: unit tests for `theme.service`** · 8 hermetic
  tests added (`core/theme.service.spec.ts`): default-to-system, valid/junk
  stored choice, `resolved()` across every branch, `data-theme` write on
  construction, `set()` persist + re-apply, and private-mode (throwing
  localStorage) survival. Pure additive, no behavior change · evidence:
  `make verify` ✓ (vitest suite green incl. 8 new theme tests).

- 2026-06-13 · **a11y: aria-live mission summary on Mission control (admin)** ·
  the supervisor's primary polling screen had no live region; SR admins now hear
  a concise "N gates waiting · N stalled · N running" (or "All clear") summary as
  polling updates it. New pure `missionSummary()` helper feeding an `.sr-only`
  `role=status aria-live=polite` region · evidence: `make verify` ✓ (47 web
  tests, +4 for `missionSummary`); live region verified in preview rendering
  "7 gates waiting on you · 1 stalled"; no visual regression (Mission control
  light mode). Note: `make verify` required temporarily stashing an unrelated
  uncommitted `sub-shell.ts` WIP that fails `format:check` — restored after,
  untouched.

- 2026-06-13 · **a11y: aria-live status region on submitter request-detail** ·
  the app had zero `aria-live` regions despite being a polling app; SR users now
  hear the request's plain status as polling updates it. New pure `liveStatus()`
  helper (built only from the proven-safe `plainStage` + `plainActivity`, so it
  cannot leak Control-center vocab) + reusable `.sr-only` utility · evidence:
  `make verify` ✓ (43 web tests, +5 for `liveStatus`); live region verified in
  preview rendering `role=status aria-live=polite` text "In review" with sr-only
  computed style (1×1px, `clip: rect(0,0,0,0)`); no visual regression.

## Backlog (ranked by impact ÷ risk)

- Feed action buttons (React / Open / More in `admin/feed.ts`) are non-functional
  placeholders (no `(click)` handler) — wire them or remove the dead controls ·
  Features/UX · impact:L · risk:L
- `next_ref()` ref allocation incl. the malformed-ref fallback branch is untested
  (DB-dependent — needs a session fixture) · Test coverage · impact:L · risk:L

- Mission actionable rows are `tabindex` divs without a row/grid role — they take
  focus now (J/K + Tab), but a roving-tabindex + `role` listbox/grid pattern
  would announce them as a navigable collection. Larger ARIA design task ·
  Accessibility · impact:M · risk:M
- When an action button (Approve/Send/Open) **inside** a Mission row has focus,
  the global `onKey` shortcuts (a/s/Enter) still fire against `focusAt()` — guard
  with `tag === 'button'` so a focused button handles its own keys · Correctness ·
  impact:L · risk:L
- Untested core services: `store.service`, `api.service`, `guards`
  (`theme.service` ✓ done) · Test coverage · impact:M · risk:L
- Only 5 `aria-label`/`role` occurrences app-wide — sweep icon-only buttons for
  accessible names · Accessibility · impact:M · risk:L

## Won't-do / blocked

- The 5 scrim/backdrop `(click)` divs (palette, popmenu, registry, who-menu
  overlays) — intentionally not keyboard-focusable; they're click-outside-to-
  dismiss and keyboard users dismiss via Escape / the toggle button. Making a
  scrim focusable is an anti-pattern.
