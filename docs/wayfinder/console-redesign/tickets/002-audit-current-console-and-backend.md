---
id: 002
title: "Research: audit the current console and supervision backend"
labels: [wayfinder:research]
status: closed
assignee: junmun (session 132e3c43)
resolved: 2026-07-10
blocked-by: []
---

## Question

What exactly exists today in `apps/console` and the FastAPI supervision layer,
and what are the real gaps a from-zero, small-team control room must close?

Cover:
- Every current surface (Mission control, Factory map, All requests, Gates
  queue, Request detail/trace, Registry, Feed/Inbox, Settings): what it shows,
  which endpoints/event kinds feed it, what state it reads.
- The supervision model from the June 2026 revamp (spec + ADR 0015): derived
  run_state, evidence, steer notes, gate semantics.
- Known deferred gaps, verified against current code: approver identity missing
  on RequestDetail; real runner (FACTORY_RUNNER=claude) emits no
  step_summary/verification/steer_note events; take-over/send-back endpoints
  absent; dead tokens; route naming.
- Anything single-operator-assumed that breaks with multiple concurrent
  operators (claiming, optimistic updates, polling model).

Deliverable: markdown audit as a linked asset (e.g.
`docs/wayfinder/console-redesign/assets/002-current-state-audit.md`) — a
surface-by-surface inventory plus a candidate backend gap list.

## Resolution

Asset: [002-current-state-audit.md](../assets/002-current-state-audit.md) — 308
lines, every claim cited as file:line, produced by codex gpt-5.5 (Claude
subagents still blocked by the monthly spend cap). Spot-checked: mock identity
and runner-stage citations hold.

Gist of what the audit established:

**Inventory.** Ten routed/structural surfaces, each documented with feeds,
event kinds, refresh model, and actions (section 2 + table in section 7). The
operating spine is one append-only event cursor polled every 4s; a version bump
triggers full re-fetch of most projections.

**As-built supervision model.** Run state and gate evidence are derived at read
time (never stored) from latest `step_summary` / `verification`; the simulator
implements the full supervision contract, the real runner does not.

**Deferred gaps, verified against code (section 5):**
- Approver identity on Request detail — CONFIRMED missing in UI, though actor
  IS persisted in `gate_event` + audit (backend data exists, projection gap).
- Real runner `step_summary` — CONFIRMED absent (real runs sit at "step 0,
  no_signal" forever).
- Real runner `verification` — FIXED since the spec was written (merge
  verification now emitted).
- Steer notes — PARTIALLY FIXED: recorded for any runner, but only the
  simulator consumes/acks them.
- Take-over and send-back-to-stage endpoints — CONFIRMED absent.
- Also confirmed: dead CSS tokens, `/admin/queue` vs spec's `/admin/gates`,
  broken Map→List query-param handoff, broken runner-mode badge (tests for
  value `claude` which the API never returns).

**Multi-operator hazards (section 6, 14 items).** Highest-consequence: every
browser defaults to the same mock "Kim P." identity; endpoints trust
client-supplied actor strings; no claim/lease model anywhere ("waiting on you"
shown to everyone); merge gate lacks the compare-and-set that spec approval
has; action errors are success-only subscribed (silent failures); optimistic
chips are browser-local; projection refresh is event-coupled, so mutations
that emit no event (registry) are invisible to other browsers.

**Candidate additive backend list (section 8, 12 items)** — feeds the
operator-workflows and multi-operator tickets: gate-decision projection,
authenticated operator identity, gate/recovery claim API, atomic merge-gate
claim, real-runner step_summary + steer consumption, take-over,
send-back-to-stage, projection revision contract, conditional mutations,
per-operator inbox/preferences, registry change signal.

**Load-bearing vs disposable (section 9).** Keep: request lifecycle + two-gate
semantics, append-only two-axis event log + cursor reads, derived
run-state/evidence read models, mission aggregate's four buckets, atomic spec
approval, single-worker pipeline boundary. Disposable: route vocabulary and
sidebar IA, factory-map cockpit styling (1,200-line component), grouped list
implementation, local optimism, shell-wide full re-fetch, browser-local
identity.

Feeds: operator-workflows grilling (now unblocked), IA-from-zero,
multi-operator model, backend work list fog.
