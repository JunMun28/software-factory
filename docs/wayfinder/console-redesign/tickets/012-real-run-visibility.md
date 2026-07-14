---
id: 012
title: "Slice 6: real runs become first-class"
labels: [ready-for-agent, wayfinder:task]
status: closed
assignee: claude+codex
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

## Resolution (2026-07-13)

Implemented by codex gpt-5.6-sol, reviewed by fable-5, committed on
`console-redesign`. The real runner now emits each stage's `step_summary` at
stage START (moved from after the blocking exec, where slice 5 put it), so the
moment a real stage begins `run_state` has a fresh current-stage event and the
lane shows a true step (Architecture 1/1, RED 1/2, GREEN 2/2, Review 1/1) with
live health — no more permanent step-0/no-signal during a long real stage. The
start emission carries the injected notes' ids in `acked_steer_ids`, so slice
5's steer round-trip is preserved (the note is honestly heard the moment it is
injected into the prompt). Simulator behavior is untouched (parity test
strengthened to exactly one summary per tick). The new shell gains a runner-mode
badge that reads the health endpoint's real `runner`+`cli`: sim → "Simulated"
(muted), agent+claude → "Agents: Claude Code", agent+codex → "Agents: Codex"
(accent) — reading the actual `runner` field instead of the old
`mode === 'claude'` test that never matched. `health()` gained the typed `cli`
field; the badge collapses to a status dot below 480 px.

Review notes: codex MOVED the emission (verified not duplicated) and left
angular.json untouched; both builds only failed inside its sandbox (exit 134,
no fonts). No fixes needed.

Verified live: the badge reads "Simulated" against the sim-mode dev server; the
faked-runner pytest asserts the stage's step_summary (true step/of, fresh
health, steer ack) is observable while the executor is still running. pytest
178, console 58, shared 85 green; console + intake build green; lint green.
