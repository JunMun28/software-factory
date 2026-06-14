# Improvements log

A running backlog for the self-paced improvement loop. Each iteration: full
sweep across all dimensions, pick the single highest impact ÷ risk item, ship it
verified (`make verify` green), record it here, commit on `auto/improve`.

> **Loop CONCLUDED 2026-06-14 (after 20 verified increments).** The high-value
> sweep is complete across every dimension — a11y (Mission + full submitter
> intake path), 2 perf fixes, 2 real bug fixes, tests, docs, a UX fix. The
> recurring cron was stopped: remaining backlog items are all impact:L (trivial)
> or larger-but-blocked (the ARIA grid redesign; service tests that need adopting
> TestBed; lazy `requests` which ADR 0013 documents Store as owning). **Do NOT
> reopen the auto-loop for busywork.** Resume real work only on a human direction
> (a feature, an architecture/perf pass behind an ADR, or a specific area). To
> restart the cadence: `/loop 30min <prompt>`.
>
> _Earlier guidance (risk appetite raised 2026-06-14): favoured high-impact even
> at moderate risk; non-negotiables were `make verify` green, the hard
> constraints, and real evidence per claim._

## In progress

_(nothing in progress)_

## Done   (most recent first)

- 2026-06-14 · **a11y: my-requests Active/All filter conveys state** · the last
  visual-only `.seg` single-select — added `role="group" aria-label="Filter
  requests"` + `[attr.aria-pressed]` on each button. Completes segmented-control
  a11y app-wide · evidence: `make verify` ✓; live — group labelled, `aria-pressed`
  flips Active/All true/false ↔ false/true on toggle.

- 2026-06-14 · **a11y: announce the live interview question to screen readers** ·
  the interview is a real-time Q&A whose question changes in place, but nothing
  announced it — SR users were never told a new follow-up appeared. New
  `liveQuestion` computed (busy → "Thinking…", done → done line, else the
  question) rendered in a stable sr-only `role=status aria-live=polite` region
  (absolute → zero layout change) · evidence: `make verify` ✓; live — region
  resolves to the current question and updated Q1→Q2 ("In a sentence…" → "Got it.
  How many items…") when answered.

- 2026-06-14 · **a11y: finish the new-request form (type cards + dropdowns)** ·
  type-card buttons now expose `aria-pressed` (the first/primary choice's
  selection); the Which-app? / How-often? dropdown triggers expose
  `aria-labelledby` (field name + current value) + `aria-expanded` (open state) ·
  evidence: `make verify` ✓; live — Bug-fix card `aria-pressed=true` (others
  false), app dropdown name "Which app? Pick an app", `aria-expanded` false→true
  on open. **Front-door form a11y complete** (inputs it.15 + seg groups it.16 +
  type cards/dropdowns it.17).

- 2026-06-14 · **a11y: intake segmented controls convey selection + group label**
  · the urgency/reach/impact single-selects showed the choice only via the `.on`
  CSS class. Wrapped each `.seg` in `role="group" aria-labelledby` (label ids
  added) and added `[attr.aria-pressed]` mirroring each button's `[class.on]` —
  SR now announces the field name + which option is selected; buttons keep
  Tab + Enter/Space · evidence: `make verify` ✓; live form — 3 groups resolve
  `aria-labelledby` to their label, and clicking High flips `aria-pressed`
  Low/Normal/High → false/false/true.

- 2026-06-14 · **a11y: intake-form labels associated with their inputs** · the
  front-door `new-request.ts` form had visual-only `<label>`s (no `for`/`id`), so
  its 5 native controls had no accessible name. Added `for`/`id` pairing
  (`nr-name`/`-desc`/`-where`/`-reach`/`-impact`) — zero visual change, also adds
  label click-to-focus · evidence: `make verify` ✓; live form — all 5 inputs
  resolve `input.labels[0]` to their field label (verified across bug/enh/new
  types).

- 2026-06-14 · **fix: focused action buttons no longer hijacked by Mission's
  global shortcuts** · the `onKey` `window:keydown` handler fired the
  J/K/A/S/Enter shortcuts for any non-input target, so Enter on a focused
  **Approve** button ran `openIssue(focusAt())` + `preventDefault()` — navigating
  away instead of approving. Added `tag === 'button'` to the early-return guard ·
  evidence: `make verify` ✓; before/after repro — Enter-on-Approve `navigatedAway`
  true→false (stays on `/admin/mission`), and J/K from a row still moves focus.

- 2026-06-14 · **perf: heavy `mission` aggregate no longer polled on non-Mission
  admin pages** · the root `Store` fetched `mission` every 4s on every admin page
  though only Mission reads it (and ADR 0013 only documents Store owning
  requests/apps/inbox — `mission` was bolted on later). Moved the fetch into the
  Mission component's own `api.mission()` effect; Store realigned to
  requests/apps/inbox · evidence: `make verify` ✓; Performance API shows the
  Registry page fetches **no** `/api/mission`, while Mission fetches it (2×) and
  renders (7 gates, 14 rows); screenshot — no visual regression.

- 2026-06-14 · **perf: submitter face no longer polls the admin aggregates** ·
  `my-requests.ts` injected the root `Store` only for `store.requests()`, but
  that instantiated the singleton whose effect fetched `requests` + `apps` +
  `inbox` + the heavy `mission` aggregate every 4s. Swapped it for a direct
  `api.requests()` effect (the `SubRequestDetail` pattern) — submitters never
  instantiate Store now · evidence: `make verify` ✓; Performance API on a fresh
  submitter session shows only `/api/events`, `/api/events/cursor`,
  `/api/requests` — **no** `/api/mission` / `/api/inbox` / `/api/apps`; page
  renders correctly (Jordan D.: 7 active rows + needs-input band), no console
  errors.

- 2026-06-14 · **a11y: concise `aria-label` on each Mission row** · with J/K now
  focusing rows (iteration 10), a screen reader was reading the raw cell jumble
  (title + "SPEC GATE" + evidence + every button). New pure `missionRowLabel()`
  helper bound as `[attr.aria-label]` gives a clean summary per row ("Spec gate,
  needs your approval — …", "Stalled, needs a human — …", "Deployed — …",
  "Running <stage> — …") · evidence: `make verify` ✓ (61 web tests, +4); live DOM
  confirmed the rendered labels on the gate/stalled/done rows. Completes the
  Mission keyboard-a11y arc (live region → focus reachable → real focus → label).

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

_Trivial (impact:L) — not worth an auto-loop iteration; do if convenient:_
- Review screen has 5 identically-named "Edit" buttons (all navigate to
  `/submit/new`) — distinguishing `aria-label`s or a single edit control ·
  Accessibility · impact:L · risk:L
- Interview answer-composer input label (the interview live region is done) ·
  Accessibility · impact:L · risk:L
- Feed action buttons (React / Open / More in `admin/feed.ts`) are non-functional
  placeholders — wire them or remove the dead controls (product call) ·
  Features/UX · impact:L · risk:L

_Larger or blocked — need a human decision, NOT an autonomous pick:_
- Mission rows: roving-tabindex + `role="grid"`/`row`/`gridcell` so the bands
  announce as a navigable collection. Real ARIA redesign · Accessibility ·
  impact:M · risk:M
- Cover `store.service` / `api.service` / `guards` — requires adopting `TestBed`
  (the repo deliberately avoids it). Decide the pattern first · Test coverage ·
  impact:M · risk:L
- Lazy-fetch `requests` (like mission, it.13) — **blocked**: ADR 0013 documents
  Store as owning requests/apps/inbox; needs an ADR update · Performance ·
  impact:M · risk:M

_Done during the loop (removed from backlog): my-requests Active/All `aria-pressed`
(it.19); `next_ref` happy path is already covered by `test_api.py`; icon-only
button names were swept — many `aria-label`/`role` added across it.1–19._

## Won't-do / blocked

- The 5 scrim/backdrop `(click)` divs (palette, popmenu, registry, who-menu
  overlays) — intentionally not keyboard-focusable; they're click-outside-to-
  dismiss and keyboard users dismiss via Escape / the toggle button. Making a
  scrim focusable is an anti-pattern.
