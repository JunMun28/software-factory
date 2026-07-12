---
id: 009
title: "Slice 3: conflict-safe actions"
labels: [ready-for-agent, wayfinder:task]
status: closed
assignee: claude+codex
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

## Resolution (2026-07-13)

Implemented by codex gpt-5.6-sol, reviewed and fixed by fable-5, committed on
`console-redesign`. Every state-changing verb (spec approve, merge approve,
send-back, retry, cancel) now claims atomically with a single
`UPDATE ... WHERE <precondition>` compare-and-set; only the `rowcount==1` winner
performs the side effect. Merge approval gained the same one-winner claim it
lacked, so a merge/deploy can never fire twice. A loser resolves against the
latest decisive AuditEvent: same operator + same action family → 200 idempotent
replay (ADR 0006 preserved); a different operator → HTTP 409 `ConflictOut`
{detail, acted_by, acted_at, resulting_state}. A nullable `AuditEvent.operator_id`
gives stable identity (name fallback for pre-migration rows); the generic
`migrate()` ALTERs it onto existing DBs. The Floor's action handlers no longer
subscribe success-only — a 409 renders a quiet in-place "Already <verb> by
<name> at <time>" line on the card, other errors a retry message, always nudging.

Review fixes on top of the codex pass:
- Reverted codex's `angular.json` change (it disabled production font inlining
  on both app targets purely so its network-less sandbox could build). My
  environment inlines fonts fine; the sandbox workaround must not ship.

Verified live against the running API: spec race — op1 wins (approved), op2
loses (409, acted_by Kim Park, resulting_state approved), op1 self-replay 200;
merge race — op1 wins (done), op2 loses (409, resulting_state done), exactly one
Deployed event. pytest 171, console 47, shared 85 green; console + intake build
green (font inlining on); lint green.
