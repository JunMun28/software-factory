# Improvements log

A running backlog for the self-paced improvement loop. Each iteration: full
sweep across all dimensions, pick the single highest impact ÷ risk item, ship it
verified (`make verify` green), record it here, commit on `auto/improve`.

## In progress

_(nothing in progress)_

## Done   (most recent first)

- 2026-06-13 · **a11y: aria-live status region on submitter request-detail** ·
  the app had zero `aria-live` regions despite being a polling app; SR users now
  hear the request's plain status as polling updates it. New pure `liveStatus()`
  helper (built only from the proven-safe `plainStage` + `plainActivity`, so it
  cannot leak Control-center vocab) + reusable `.sr-only` utility · evidence:
  `make verify` ✓ (43 web tests, +5 for `liveStatus`); live region verified in
  preview rendering `role=status aria-live=polite` text "In review" with sr-only
  computed style (1×1px, `clip: rect(0,0,0,0)`); no visual regression.

## Backlog (ranked by impact ÷ risk)

- Admin live-run status (`healthLine`) needs an `aria-live` region too (mission /
  admin request-detail) · Accessibility · impact:M · risk:L
- 6 clickable non-`<button>` elements — audit for keyboard access (Enter/Space +
  role/tabindex) · Accessibility · impact:M · risk:L
- Untested core services: `theme.service`, `store.service`, `api.service`,
  `guards` · Test coverage · impact:M · risk:L
- Only 5 `aria-label`/`role` occurrences app-wide — sweep icon-only buttons for
  accessible names · Accessibility · impact:M · risk:L

## Won't-do / blocked
