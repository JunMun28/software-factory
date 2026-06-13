# The Pipeline (runs) view is the Control center's default landing; the board becomes a lens

**Status:** superseded by ADR 0015

The Control center's default landing is a **Pipeline view** — one row per Work item,
the six stages compressed into an inline **stage strip** with the two human gates as
diamond markers, rows grouped by attention (*Needs me → In flight → In triage → With
submitter → Done & closed*). The kanban Board and the List remain as alternate lenses
behind a List ⇄ Board ⇄ Pipeline toggle (one collection, three projections).

## Why recorded (all three tests met)

- **Surprising** — a tracking product "obviously" lands on a kanban board, and the
  design spec built one. But kanban assumes human-paced work: items linger, people
  drag cards, column membership is the signal. This Factory is the opposite — the
  pipeline is **fixed and linear**, cards **move themselves** (agents drive every
  transition; Admins act only at gates), and the agent stages clear in minutes, so
  the middle columns sit empty while everything piles at the two human gates. The
  CI-runs pattern (GitHub Actions/Buildkite) fits the domain; the board fights it.
- **Real trade-off** — the board still wins for scanning *volume by stage* and for
  swimlane slicing; it is kept, not deleted. The Pipeline view wins the operator's
  three daily questions: *what needs me, what's stuck, how long has it been there* —
  questions the board could only answer with bolted-on badges.
- **Hard to reverse cheaply** — the view needed a schema addition: `stage_entered_at`,
  stamped on **every** stage/gate transition (submit, approve, simulator advance,
  gate raise, send-back, respond, retry, merge). Time-in-stage / "stalled Nm" is now
  load-bearing UX; removing or skipping the stamp on a future transition silently
  breaks the stuck-detection readout. `last_event` (latest milestone title) rides on
  the list payload for the row's context line.

## Consequences

- Stage strips reuse the submitter mini-tracker's vocabulary (status by shape:
  filled = done, animated stripe = agents working, diamond = gate; amber = waiting
  on a human, red = escalated, one loud colour per row).
- `G P` navigates to Pipeline; `/admin` redirects there; reviewer sign-in lands there.
- Any new lifecycle transition MUST stamp `stage_entered_at` — treat it as part of
  the transition, not decoration.
