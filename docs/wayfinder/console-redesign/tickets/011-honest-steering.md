---
id: 011
title: "Slice 5: honest steering"
labels: [ready-for-agent, wayfinder:task]
status: closed
assignee: claude+codex
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

## Resolution (2026-07-13)

Implemented by codex gpt-5.6-sol, reviewed by fable-5, committed on
`console-redesign`. `supervision.steer_state(db, r)` derives the latest steer
note's state (queued | heard, with at_step + acked_at) purely from append-only
events — heard only when a later step_summary names the note's event id.
Exposed as `run.steer` in the mission projection (SteerStateOut). The REAL
runner (`agent_runner.py`) now reads pending steer notes at each stage boundary,
injects their text into that stage's agent prompt, and emits a minimal
step_summary carrying their ids in acked_steer_ids — so the derivation flips
them to heard (the simulator already did this). Stage-boundary granularity only;
full per-step visibility + runner-mode badge are left to slice 012. The Floor
lane gained an expandable steer input and a chip that shows "queued" until the
SERVER-derived state flips to "heard ✓ at step N" — no browser-local optimism
(a vitest asserts a local send alone renders no chip). A steer on a
no-longer-in-flight run 409s and renders the in-place outcome line.

Review notes: codex correctly restructured the lane from `<a class="lane">` to
`<article class="lane">` with the title as the inner nav link (a steer <button>
can't nest inside an anchor — invalid HTML) and updated the J/K focusRow
selector to `article.lane` accordingly. No fixes needed. It honored the
instruction NOT to touch angular.json this time (left both builds unverified in
its sandbox; reviewer built them green with network).

Verified live: steer → {status: queued}; mission run.steer queued
{at_step:null}; after a tick → heard {at_step:3, acked_at:...}; the Floor lane
chip rendered "heard ✓ at step 3". pytest 177, console 55, shared 85 green;
console + intake build green; lint green.
