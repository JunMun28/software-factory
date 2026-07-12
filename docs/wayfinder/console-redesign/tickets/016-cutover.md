---
id: 016
title: "Slice 10: cutover — delete old console, ADR, verify, merge"
labels: [ready-for-agent, wayfinder:task]
status: open
assignee:
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
