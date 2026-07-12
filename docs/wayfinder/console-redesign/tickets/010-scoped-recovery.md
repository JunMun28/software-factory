---
id: 010
title: "Slice 4: scoped recovery"
labels: [ready-for-agent, wayfinder:task]
status: open
assignee:
blocked-by: [008]
user-stories: "10-14"
---

## Parent

[Spec: Console redesign — The Floor (PRD)](../spec-the-floor-prd.md) · design spec: docs/superpowers/specs/2026-07-11-console-redesign-design.md · visual reference: mockups/console-floor-family.html

## What to build

Give stalled/failed runs the full verb set. New take-over endpoint (marks the request human-owned, stops runner work, records audit + timeline events) and send-back-to-stage endpoint (returns an escalated run to a chosen earlier stage with a reason and fresh stage clock; distinct from the submitter send-back). Triage cards on The Floor offer all four verbs — retry stage, send back to…, take over, cancel — each stating its blast radius before confirming.

Hard invariants: progress_event is append-only (ADR 0008); single uvicorn worker; gate semantics preserved; work on the `console-redesign` worktree branch; never commit/push without the user's ask.

## Acceptance criteria

- [ ] A stalled run's triage card offers all four verbs with blast-radius text
- [ ] Send-back-to-stage restarts the chosen stage with the reason recorded on the timeline
- [ ] Take-over stops automation, marks human ownership, and is visible in request state
- [ ] Both new endpoints are CAS-protected and covered by winner/loser pytest
- [ ] Gate workflow semantics unchanged for the existing verbs

## Blocked by

[Slice 2](008-operator-identity.md)
