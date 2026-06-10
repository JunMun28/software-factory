# Every Stage is resumable — the Factory can re-enter from any Stage

**Status:** accepted

The Factory is **not** a one-shot, start-to-finish run. It can **re-enter from any Stage**
against the current pull-request state. This is a core requirement, not an optimization, because
the admin Recovery actions — **Retry**, **Send back**, and **Take over** — all depend on it: each
re-runs (or hands back to) a Stage somewhere in the middle of the pipeline after a human or an
agent has changed the PR.

This works because of the Artifact contract: **every Stage begins by validating its input
Artifact and operates on the repo as it currently is.** So "run Stage N again on this PR" is
always well-defined, whether the last change came from an agent, a human take-over, or a
send-back that discarded later work.

## Consequences

- **Every Stage must be re-runnable / idempotent against current state** — running it twice on the
  same PR must be safe, and it must not assume it is the first or only writer.
- A naive linear pipeline (run 1→6 once) would be simpler but could not support Retry / Take-over
  / Send-back — so the resumability discipline is the price of human-in-the-loop recovery. Recorded
  so a future build does not quietly make stages one-shot.
- Take-over specifically means a Stage's output can come from a **human** editing the PR; the next
  Stage must treat that identically to agent-produced output (it only validates the Artifact).
