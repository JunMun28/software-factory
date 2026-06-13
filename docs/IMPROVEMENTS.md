# Improvements log

A running backlog for the self-paced improvement loop. Each iteration: full
sweep across all dimensions, pick the single highest impact ÷ risk item, ship it
verified (`make verify` green), record it here, commit on `auto/improve`.

## In progress

_(nothing in progress)_

## Done   (most recent first)

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

- Admin **request-detail** (`admin/request-detail.ts`) live trace still has no
  `aria-live` — the per-request admin view, distinct from Mission's summary ·
  Accessibility · impact:M · risk:L
- Mission control J/K keyboard nav updates a visual `focusIdx` only — it never
  moves real DOM focus, so keyboard/SR users get no focus move or announcement
  on J/K · Accessibility · impact:M · risk:M
- 6 clickable non-`<button>` elements — audit for keyboard access (Enter/Space +
  role/tabindex) · Accessibility · impact:M · risk:L
- Untested core services: `theme.service`, `store.service`, `api.service`,
  `guards` · Test coverage · impact:M · risk:L
- Only 5 `aria-label`/`role` occurrences app-wide — sweep icon-only buttons for
  accessible names · Accessibility · impact:M · risk:L

## Won't-do / blocked
