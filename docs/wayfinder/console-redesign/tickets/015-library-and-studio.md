---
id: 015
title: "Slice 9: Library + Studio registry"
labels: [ready-for-agent, wayfinder:task]
status: open
assignee:
blocked-by: [007]
user-stories: "29, 31"
---

## Parent

[Spec: Console redesign — The Floor (PRD)](../spec-the-floor-prd.md) · design spec: docs/superpowers/specs/2026-07-11-console-redesign-design.md · visual reference: mockups/console-floor-family.html

## What to build

The remaining two surfaces. Library: every request past and present as compact rows (state word, title, app, decided-by/updated, cycle time), filterable by app and state via query params so filtered views are shareable URLs. Studio: registry app cards with create/edit (honest about what verification means), alongside the profile and notification sections from earlier slices.

Hard invariants: progress_event is append-only (ADR 0008); single uvicorn worker; gate semantics preserved; work on the `console-redesign` worktree branch; never commit/push without the user's ask.

## Acceptance criteria

- [ ] Library lists all requests; app/state filters live in the URL and survive reload/sharing
- [ ] Drill-down links from Floor lanes and Recently land on the right Dossier; filter links land on the filtered Library
- [ ] Registry create/edit works from Studio cards and reaches other browsers within a poll cycle
- [ ] Family direction at 1440/390, light + dark; component tests cover filter-from-URL

## Blocked by

[Slice 1](007-shell-and-readonly-floor.md)
