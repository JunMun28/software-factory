---
id: 010
title: "Slice 4: scoped recovery"
labels: [ready-for-agent, wayfinder:task]
status: closed
assignee: claude+codex
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

## Resolution (2026-07-13)

Implemented by codex gpt-5.6-sol, reviewed and fixed by fable-5, committed on
`console-redesign`. Two new CAS-protected recovery endpoints in gates.py:
`take-over` (precondition needs_human; sets status=`human_owned`, clears
escalation, records audit + timeline) and `send-back-to-stage` (validates the
target is a pipeline stage strictly earlier than current — 400 otherwise;
rewinds stage, status=approved, fresh clock, records the reason, re-drives the
runner in agent mode). Both reuse slice-3's `_resolve_cas_loss` (different
operator → 409, self-replay → 200). Because the tick filters status==approved,
`human_owned` naturally halts the runner; the mission aggregate gains a
`human_owned` band so a taken-over request stays visible (naming who took it
over) instead of vanishing. The Floor triage card now offers all four verbs —
Retry / Send back to… / Take over / Cancel — each with a blast-radius confirm;
two new kit modals (RecoveryConfirm, SendBackStageModal). statusPill/boardGlyph/
inFlight learned the human_owned state.

Review fixes on top of the codex pass:
- SendBackStageModal offered invalid targets for a request stalled BEFORE the
  pipeline: `slice(0, indexOf)` with indexOf=-1 (e.g. stage 'spec') wrongly
  returned architecture+build. Guarded `here <= 0 → []` and added a graceful
  "already the earliest stage" empty state so a spec-stage stall can't pick a
  target the backend would 400.
- Aligned the retry blast-radius label to the Floor vocabulary (architecture →
  'plan').

Verified live against the running API: take-over → human_owned, survives a tick,
shows in the human_owned band, loser 409; send-back-to-stage build→architecture
restarts the stage, later/non-pipeline targets 400, loser 409, self-replay 200;
the browser triage card shows four verbs, the human-owned card renders distinct
with Cancel, and the stage picker offers only 'Architecture' for a build-stage
stall. pytest 176, console 51, shared 85 green; console + intake build green;
lint green.
