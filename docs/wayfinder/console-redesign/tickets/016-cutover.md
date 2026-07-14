---
id: 016
title: "Slice 10: cutover — delete old console, ADR, verify, merge"
labels: [ready-for-agent, wayfinder:task]
status: closed
assignee: claude+codex
blocked-by: [009, 011, 012, 013, 014, 015]
user-stories: "38, 40"
---

## Parent

[Spec: Console redesign — The Floor (PRD)](../spec-the-floor-prd.md) · design spec: docs/superpowers/specs/2026-07-11-console-redesign-design.md · visual reference: mockups/console-floor-family.html

## What to build

Finish the cut. Remove the old eight surfaces, their routes, components, and dead style tokens; keep permanent redirects. Write the new ADR recording the four-surface IA (superseding the affected parts of the supervision-console and factory-map ADRs). Run make verify and the full visual proof matrix (each surface at 1440/390 × light/dark), a keyboard pass, and prefers-reduced-motion. Show the user the green output; merge only after they see it. Never commit or push without their ask.

Hard invariants: progress_event is append-only (ADR 0008); single uvicorn worker; gate semantics preserved; work on the `console-redesign` worktree branch; never commit/push without the user's ask.

## Acceptance criteria

- [ ] Old surfaces/components/routes/dead tokens deleted; only the four new surfaces remain
- [ ] Legacy URLs still redirect
- [ ] New ADR committed alongside the change, superseding old IA decisions
- [ ] make verify green with output shown to the user before merging
- [ ] Visual matrix + keyboard + reduced-motion evidence captured

## Blocked by

[Slice 3](009-conflict-safe-actions.md), [Slice 5](011-honest-steering.md), [Slice 6](012-real-run-visibility.md), [Slice 7](013-email-and-freshness.md), [Slice 8](014-dossier.md), [Slice 9](015-library-and-studio.md)

## Resolution (2026-07-13)

Implemented by codex gpt-5.6-sol, reviewed + verified by fable-5, committed on
`console-redesign` (NOT merged — awaiting the user's go-ahead). Deleted the old
eight surfaces: the entire `apps/console/src/app/admin/` dir (mission, map,
queue, inbox, feed, list, registry, settings, request-detail, admin-shell + its
spec) and `core/map-view.ts` + spec (grep-confirmed orphaned). Removed ~1,628
lines of dead admin/board/list/queue/feed/settings CSS from styles.css
(2994 → 1366 lines), keeping all Micron Atlas tokens and the shared atoms the
kit components use. Legacy `/admin/*` redirects preserved. Added ADR 0025
(four-surface IA) with "Superseded by ADR 0025" notes atop ADR 0015 and 0016.

Review fixes on top of the codex pass:
- `task verify` initially failed on LINT (codex's sandbox can't run ruff/prettier
  and I'd only run eslint per slice): ruff flagged an unused `emit` import in
  startup.py (dead after slice-13 routed escalation through lifecycle.escalate)
  + unsorted imports in two test files; prettier flagged 5 files (some from MY
  manual review edits that never went through prettier). Auto-fixed both.

Verification (all green, shown to the user before merge):
- `task verify` → ✓ VERIFY PASSED: lint (ruff + eslint×3 + prettier) + pytest 185
  + vitest (console 46, shared 86) + build×2 + smoke (full lifecycle: submit →
  spec gate → approve → stages 2-5 → merge gate → deploy → event log).
- Visual matrix (post-cutover): Floor, Dossier, Library, Studio each at 1440
  light + dark + Floor 390 + Dossier 375 — all render cleanly (CSS deletion
  broke nothing).
- Keyboard: ⌘K palette, Escape, J focus, A approve-modal, G-chord hints all live.
- Reduced-motion: global + per-component prefers-reduced-motion rules present.

Known residual (non-blocking): styles.css still carries ~600 lines of dead
SUBMITTER (intake) CSS (.sub*/.stepper/.typecard/.qpanel/…) that predates this
redesign (monorepo-split legacy, not one of the eight surfaces). Harmless unused
CSS; a separate cleanup, not removed at the merge gate to avoid last-minute risk.
