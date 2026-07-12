---
id: 014
title: "Slice 8: Dossier"
labels: [ready-for-agent, wayfinder:task]
status: open
assignee:
blocked-by: [008, 010]
user-stories: "21, 26-28"
---

## Parent

[Spec: Console redesign — The Floor (PRD)](../spec-the-floor-prd.md) · design spec: docs/superpowers/specs/2026-07-11-console-redesign-design.md · visual reference: mockups/console-floor-family.html

## What to build

One request's full story. Header with title, app, requester, state-as-a-sentence, and the same action verbs as The Floor (including take-over and send-back-to-stage). Semantic timeline grouping raw events into stages, gates, human decisions, escalations, and comments — every consequential entry signed with decided-by + time; steer notes show their ack state. Comments compose against an explicitly chosen target. Any timeline chapter expands into a raw evidence drawer (events, verification payloads, attachments) with deep links.

Hard invariants: progress_event is append-only (ADR 0008); single uvicorn worker; gate semantics preserved; work on the `console-redesign` worktree branch; never commit/push without the user's ask.

## Acceptance criteria

- [ ] Timeline reads as chapters with decided-by + timestamp on every decision
- [ ] Evidence drawer opens per chapter with raw events and attachments, deep-linkable
- [ ] All verbs work from the header with CAS conflict feedback
- [ ] Comments require an explicit target; no implicit active-request selection
- [ ] Family direction at 1440/390, light + dark; component tests cover timeline grouping and drawer

## Blocked by

[Slice 2](008-operator-identity.md), [Slice 4](010-scoped-recovery.md)
