---
id: 008
title: "Slice 2: operator identity end-to-end"
labels: [ready-for-agent, wayfinder:task]
status: open
assignee:
blocked-by: [007]
user-stories: "20, 21, 30 (profile)"
---

## Parent

[Spec: Console redesign — The Floor (PRD)](../spec-the-floor-prd.md) · design spec: docs/superpowers/specs/2026-07-11-console-redesign-design.md · visual reference: mockups/console-floor-family.html

## What to build

Real named operators replace the shared mock identity. Server-side operator store (name, initials, hue, email) with list/create API; Studio hosts pick-or-create-your-profile; the client persists only a pointer to the server row. Every mutation (gate decisions, recovery, steer, comments) carries the operator id; the server resolves and records the actor. The Floor's Recently list renders decided-by + time from the persisted actor data. The seam must allow a later real-auth swap without touching call sites.

Hard invariants: progress_event is append-only (ADR 0008); single uvicorn worker; gate semantics preserved; work on the `console-redesign` worktree branch; never commit/push without the user's ask.

## Acceptance criteria

- [ ] First visit prompts profile pick/create in Studio; identity survives reload via server-row pointer
- [ ] Approving a gate records the real operator; Recently shows 'approved by <name> · <time>'
- [ ] All mutation endpoints reject a missing/unknown operator id with a clear error
- [ ] The hard-coded shared mock user is gone from the console
- [ ] pytest covers operator CRUD and actor recording; component test covers the signed Recently row

## Blocked by

[Slice 1](007-shell-and-readonly-floor.md)
