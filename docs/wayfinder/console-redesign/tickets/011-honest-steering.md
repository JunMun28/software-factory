---
id: 011
title: "Slice 5: honest steering"
labels: [ready-for-agent, wayfinder:task]
status: open
assignee:
blocked-by: [007]
user-stories: "17, 18"
---

## Parent

[Spec: Console redesign — The Floor (PRD)](../spec-the-floor-prd.md) · design spec: docs/superpowers/specs/2026-07-11-console-redesign-design.md · visual reference: mockups/console-floor-family.html

## What to build

Steer notes become real. The runner reads pending steer notes at stage boundaries, injects them into the stage prompt, and reports acknowledged note ids in its next emitted event; notes and history are never mutated. The Floor's lane steer input shows the note as 'queued' until the server-derived ack flips it to 'heard ✓ at step N' — no browser-local optimism.

Hard invariants: progress_event is append-only (ADR 0008); single uvicorn worker; gate semantics preserved; work on the `console-redesign` worktree branch; never commit/push without the user's ask.

## Acceptance criteria

- [ ] A steer note sent mid-run reaches the runner's next stage prompt (provable via simulator and a faked real runner)
- [ ] Ack ids appear in emitted events; the derived ack state drives the UI chip
- [ ] The chip state is identical in a second browser (server truth, not local state)
- [ ] pytest covers the ack round-trip; component test covers queued→heard rendering

## Blocked by

[Slice 1](007-shell-and-readonly-floor.md)
