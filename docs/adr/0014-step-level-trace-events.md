# Step-level trace events on the progress rail, still never streaming

**Status:** accepted

The supervision revamp (spec 2026-06-12) needs three things ADR 0004's
stage-end milestone summaries cannot express: live run-state for the
"In flight" band, a per-request trace answering "what did the agent decide
and why", and a steer verb with visible acknowledgment.

We add three event kinds to the existing append-only progress_event log
(ADR 0008): `step_summary` (one short summary at the end of each agent step,
with step/of/label/why), `verification` (tests, diff stats, reviewer verdict,
assumptions — written when a run reaches a gate), and `steer_note` (a human
note consumed by the runner at the next step boundary, acknowledged by id in
the consuming step's payload — derived consumption, the log is never UPDATEd).
Run-state ({step, of, label, health}) is DERIVED from the latest step_summary
plus event recency at read time; nothing mutable is stored.

## Consequences

- Reporting granularity moves from stage boundaries to step boundaries.
  ADR 0004's core holds unchanged: no websockets, no agent phone-home API,
  no token-by-token narration — summaries on the same polled GitHub-event
  rail, just finer.
- The per-app feed stays milestone-level; step events render only in the
  per-request trace (`/api/requests/{rid}/trace`). This is the firehose
  guard: channel surfaces stay calm, drill-down gets detail.
- Health ("slow") is a derived threshold (RUN_SLOW_AFTER_SECONDS, default
  3× SIM_INTERVAL) — honest about signal recency, never a stored claim.
- Real (non-sim) runners must emit step_summary/verification to stay
  first-class on the supervision surfaces; the sim demonstrates the contract.
