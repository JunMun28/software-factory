---
id: 013
title: "Slice 7: email pings + freshness"
labels: [ready-for-agent, wayfinder:task]
status: closed
assignee: claude+codex
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

## Resolution (2026-07-13)

Implemented by codex gpt-5.6-sol, reviewed and fixed by fable-5, committed on
`console-redesign`. Per-operator subscriptions via an `OperatorAppMute` table
(a row = muted; absence = subscribed, so default is all apps) with
GET/PUT `/api/operators/{id}/subscriptions[/{app_id}]`. `notifications.py` sends
one email per subscribed operator on gate-raised (spec + merge) and
escalation/stall, each with a Dossier deep link; escalation is centralized in
`lifecycle.escalate` so the real runner, simulator, and startup orphan-recovery
all notify, while `finish_done`/healthy steps/cancel never do. SMTP via env with
a safe log-only fallback (every send wrapped so email failure can't break a
gate); `/api/health` reports `smtp: configured | log-only`. A process-local
revision counter bumps on operator/registry/subscription changes (only when
something actually changed) and rides `/api/events/cursor`; the poll forkJoins
events+cursor each tick and bumps `version` on a revision change with zero new
events, so a registry/preference edit converges to other browsers within one
cycle. Studio gained per-app toggles + an honest SMTP-status line.

Review fix on top of the codex pass:
- The Dossier deep-link default was `http://localhost:4201` (the INTAKE app);
  `/requests/:id` lives on the console. Changed the default to `:4202`. Tests
  set CONSOLE_BASE_URL explicitly so they were unaffected.

Verified live against the running API: health smtp=log-only; cursor returns
`{cursor, revision}`; muting an app for an operator returns 200 and bumps the
revision (idempotent PUT does not); recipient resolution for a northwind gate
returns exactly the subscribed operator and excludes the muted one; Studio
renders the toggle list (Northwind = Muted) + the log-only note. pytest 185,
console 59, shared 86 green; console + intake build green; lint green.
