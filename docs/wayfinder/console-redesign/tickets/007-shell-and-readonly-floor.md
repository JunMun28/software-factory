---
id: 007
title: "Slice 1: new shell + read-only Floor"
labels: [ready-for-agent, wayfinder:task]
status: open
assignee: claude+codex
blocked-by: []
user-stories: "1, 5-8, 15-16, 24-25, 32, 34-39"
---

## Parent

[Spec: Console redesign — The Floor (PRD)](../spec-the-floor-prd.md) · design spec: docs/superpowers/specs/2026-07-11-console-redesign-design.md · visual reference: mockups/console-floor-family.html

## What to build

Replace the console's entry experience with the new shell and The Floor, in the approved Family direction (intake Micron Atlas tokens, Micron Basis + JetBrains Mono, purple accent, amber=gate/red=needs-human/green=success). Slim top bar (wordmark → Floor, Library, Studio, operator mark, ⌘K), command palette and G-chords preserved, legacy /admin/* routes redirect. The Floor renders live data from the existing mission aggregate: greeting headline with needs-you count, stat chips (in motion, shipped this week, median cycle, wait-on-human), gate evidence cards (evidence facts, plain-language consequence sentence, existing approve/send-back/retry/cancel actions), lanes across spec→plan→build→review→merge→ship with step m/n and shape+word health, and a signed Recently list. Library/Studio may be stub routes this slice.

Hard invariants: progress_event is append-only (ADR 0008); single uvicorn worker; gate semantics preserved; work on the `console-redesign` worktree branch; never commit/push without the user's ask.

## Acceptance criteria

- [ ] Opening / shows The Floor with live factory data in light and dark, at 1440 px and 390 px
- [ ] Gate card shows evidence facts and a consequence sentence; approve and send-back work end-to-end
- [ ] Lanes derive stage/step/health from mission data; health is shape+word, never color alone
- [ ] All-clear state renders when nothing needs a human; empty line invites via intake app
- [ ] Legacy /admin/* URLs redirect permanently to the new routes
- [ ] Command palette, G-chords, and gate J/K/Enter/A/S keys work; prefers-reduced-motion honored
- [ ] Component tests cover gate card, lane derivation, and all-clear; make verify green

## Blocked by

None - can start immediately
