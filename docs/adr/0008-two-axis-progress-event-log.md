# Progress is one typed, two-axis `progress_event` log; the Control center reads it as Linear tracking + a Slack-style per-app feed

**Status:** accepted
**Refines:** ADR 0004 (milestone summaries become `progress_event` rows) · stays within ADR 0007 (polling now, SSE later)

We model all Factory progress as a **single append-only, typed `progress_event` log**, where each
row is keyed on **both** `request_id` (the Work item / Request axis) **and** `subject_id` (the app
axis, denormalized from the Request via the App registry), and carries a `kind`
(`milestone_summary | gate_event | escalation | recovery_action`) and `stage`. The two Control-center
views are **read-projections over this one log**, not separate pipelines:

- **Per-Request Progress timeline** = filter by `request_id`
- **Slack-style per-app Progress feed** = filter by `subject_id` (channel = app, thread = Work item, message = milestone summary)

This is **fan-out-on-read**. We explicitly **reject fan-out-on-write / per-viewer materialized feeds** —
that solves a high-writer/celebrity-fanout problem we do not have (one writer: the Factory Builder bot;
a handful of feeds). Gate events, escalation, and recovery actions fold into the same table via `kind` —
the "same rail, one source of truth" CONTEXT.md / ADR 0004 already require.

## Why recorded (all three tests met)

- **Hard to reverse** — the event-log schema is the foundation every feed, inbox, badge, and timeline
  queries; changing it later touches everything downstream.
- **Surprising** — a reasonable engineer would build the per-app feed as a second pipeline, or reach for
  fan-out-on-write "for scale." "One log, two axes, fan-out-on-read" is non-obvious and easy to undo wrongly.
- **Real trade-off** — fan-out-on-read vs on-write; one polymorphic log vs separate per-kind tables. We
  chose the read-cheap, single-source option deliberately for our one-writer/few-readers shape.

## Consequences

- The webhook handler **inserts one `progress_event`** per PR comment (resolve `request_id`, denormalize
  `subject_id`); upsert on the GitHub comment id for idempotency.
- The **Builder bot tags each summary with `kind` + `stage`** so feeds render typed/stage-colored without
  parsing free text. (One cheap writer convention.)
- Reads use **keyset pagination on `id`**; that same `?after=<event_id>` cursor **is** the polling cursor,
  and is the exact seam SSE drops into later — operationalizing ADR 0007 rather than reopening it.
- The Control center adopts a **Linear-style tracking subset** (status-TYPE layer over the stage columns,
  Triage-style approval queue, list⇄board, command palette, optimistic UI) and a **Slack-style per-app
  Progress feed** + a **"Needs me" inbox** — all read-projections/UI over the one log.
- **Guardrail (hold the ADR 0004 line):** persist only milestone summaries / gate / escalation / recovery
  events. No streaming heartbeats, no edit-in-place on historical summaries (only a per-thread *status
  header* may reflect current state), no presence/typing, no per-milestone push. The Slack-channel framing
  must not smuggle back the streaming firehose ADR 0004 rejected.
- Most of this surfaces value once Stages 2–6 emit progress; laying the `progress_event` log early is cheap
  and correct, so Stage 1 should write summaries into it from the start.

Full design + data-model sketch: [docs/design/control-center-linear-slack.md](../design/control-center-linear-slack.md).
