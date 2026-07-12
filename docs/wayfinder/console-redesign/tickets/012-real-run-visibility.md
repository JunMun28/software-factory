---
id: 012
title: "Slice 6: real runs become first-class"
labels: [ready-for-agent, wayfinder:task]
status: open
assignee:
blocked-by: [007]
user-stories: "19, 32"
---

## Parent

[Spec: Console redesign — The Floor (PRD)](../spec-the-floor-prd.md) · design spec: docs/superpowers/specs/2026-07-11-console-redesign-design.md · visual reference: mockups/console-floor-family.html

## What to build

Real (non-simulated) runs get honest presence on The Floor. The real runner emits per-stage step summaries so lanes show true stage/step/health instead of permanent step-0/no-signal; the shell's runner-mode badge reads the health endpoint's actual values. Simulator behavior unchanged.

Hard invariants: progress_event is append-only (ADR 0008); single uvicorn worker; gate semantics preserved; work on the `console-redesign` worktree branch; never commit/push without the user's ask.

## Acceptance criteria

- [ ] With the real runner, a request's lane advances with true stage/step and health
- [ ] No real run shows the permanent 'step 0 / no signal' state while healthy
- [ ] Runner-mode badge correctly distinguishes real agent vs simulator
- [ ] pytest covers step-summary emission via a faked runner; simulator parity test stays green

## Blocked by

[Slice 1](007-shell-and-readonly-floor.md)
