---
id: 003
title: "Grilling: operator workflows and jobs-to-be-done"
labels: [wayfinder:grilling]
status: closed
assignee: unassigned (session 132e3c43)
resolved: 2026-07-11
blocked-by: [001, 002]
---

## Question

What does the small engineering team actually do in this console, day to day —
and which jobs is the console optimized for?

Candidate jobs to test with the user (informed by ticket 001's patterns and
ticket 002's ground truth): monitoring the fleet of runs, approving/rejecting
gates, steering in-flight runs, triaging failures and stalls, tracking
throughput/cost, onboarding a new request, reviewing history/audit. Which are
primary vs occasional? What does a "shift" look like — always-on wall display,
periodic check-ins, or notification-driven? What coordination do equal-role
operators need so two people don't collide on the same gate?

Resolve via /grilling + /domain-modeling, one question at a time. The answer is
a ranked list of jobs-to-be-done with the coordination requirements, recorded in
the resolution — it drives the IA ticket.

## Resolution

Grilled 2026-07-11, ten questions answered by the user; the last (email
granularity) plus all downstream design decisions were delegated ("you decide
everything and write spec"). Delegated decisions are marked (D).

**Attendance model.** Notification-driven + check-ins. Nobody watches the
console; the factory pings when a human is needed, operators glance a few
times a day. The console optimizes for fast catch-up and a truthful
"needs me" view — not for an always-on wall display.

**Job ranking (console optimizes in this order):**
1. Approve/reject gates (spec + merge)
2. Triage failures and stalls
3. Glance-monitor the fleet during a check-in
4. Steer in-flight runs
5. Review per-request history
6. A few throughput numbers
Onboarding new requests stays in the intake app.

**Notification channel.** Email, with deep links into the console.
(D) Emails fire only when a human is needed: gate raised, failure, stall.
Deliveries and everything else wait for the next check-in.

**Gate decisions happen fully in-console.** Evidence card with plan/spec
lines, diff summary, verification results, requester, and side effects;
GitHub is an escape hatch, not the decision surface.

**Recovery verbs (full scoped set).** Retry stage, send back to an earlier
stage, take over (human finishes outside the factory), cancel.

**Coordination between equals: NO claim UI.** First decision wins; the
other operator gets explicit conflict feedback ("already approved by Kim P.
at 14:02"). This kills the claim/lease API from the audit's candidate list
and keeps conditional mutations + decided-by attribution.

**Steering becomes real.** The real runner consumes steer notes at stage
boundaries and acks them; the console shows queued → acknowledged honestly.

**Scale: 1–5 concurrent runs.** A quiet factory — rich per-run cards beat
the research's dense fleet table at this scale.

**Metrics: a few honest numbers embedded on the home** (completed this
week, median cycle time, time-waiting-on-human). No analytics surface.

**History: per-request only**, with decided-by (who + when) on every
decision. No cross-request audit view.

Drives: the redesign spec (IA, visual direction, backend work list) —
see the map's Decisions so far for the spec link.
