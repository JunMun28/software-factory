---
id: 013
title: "Slice 7: email pings + freshness"
labels: [ready-for-agent, wayfinder:task]
status: open
assignee:
blocked-by: [008]
user-stories: "2-4, 30, 33"
---

## Parent

[Spec: Console redesign — The Floor (PRD)](../spec-the-floor-prd.md) · design spec: docs/superpowers/specs/2026-07-11-console-redesign-design.md · visual reference: mockups/console-floor-family.html

## What to build

The factory pings humans only when needed. Per-operator app subscriptions persisted server-side and edited in Studio (default: all apps). On gate-raised, escalation, or stall detection, subscribed operators get an email with a Dossier deep link; SMTP config via env; missing config degrades to log-only and Studio says so. Add a lightweight revision counter bumped by mutations that emit no progress event (registry, operator, preferences) so every browser converges within one polling cycle. No emails for healthy progress or deliveries.

Hard invariants: progress_event is append-only (ADR 0008); single uvicorn worker; gate semantics preserved; work on the `console-redesign` worktree branch; never commit/push without the user's ask.

## Acceptance criteria

- [ ] Raising a gate emails exactly the subscribed operators with a working deep link
- [ ] Failures and stalls email; completions and healthy progress never do
- [ ] Unset SMTP degrades to log-only, visibly stated in Studio
- [ ] A registry/preference edit in one browser reaches another within one poll cycle
- [ ] pytest covers trigger selection and subscription filtering via a captured mail transport

## Blocked by

[Slice 2](008-operator-identity.md)
