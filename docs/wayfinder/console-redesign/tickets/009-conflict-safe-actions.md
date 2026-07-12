---
id: 009
title: "Slice 3: conflict-safe actions"
labels: [ready-for-agent, wayfinder:task]
status: open
assignee:
blocked-by: [008]
user-stories: "22, 23"
---

## Parent

[Spec: Console redesign — The Floor (PRD)](../spec-the-floor-prd.md) · design spec: docs/superpowers/specs/2026-07-11-console-redesign-design.md · visual reference: mockups/console-floor-family.html

## What to build

Two equal operators must never collide silently. Every state-changing endpoint (merge approval, spec approval, send-back, retry, cancel) validates with an atomic compare-and-set against current state — extending the existing spec-approval one-winner pattern — and the loser receives a structured conflict payload (acted_by, acted_at, resulting_state). The Floor renders the conflict in place as a quiet outcome line ('Already approved by Kim P. at 14:02'), never a raw error, never a silent no-op.

Hard invariants: progress_event is append-only (ADR 0008); single uvicorn worker; gate semantics preserved; work on the `console-redesign` worktree branch; never commit/push without the user's ask.

## Acceptance criteria

- [ ] Racing approvals from two browsers: exactly one side effect; the loser sees the in-place outcome line naming the winner and time
- [ ] Merge approval has the same one-winner protection as spec approval
- [ ] pytest covers winner and loser for every mutating endpoint
- [ ] No action button subscribes to success only — failures and conflicts always render feedback

## Blocked by

[Slice 2](008-operator-identity.md)
