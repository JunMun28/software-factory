# Supervision-first console: Mission control replaces the Linear board as the operator home

**Status:** accepted (supersedes ADR 0010)

A two-track review (code critique + agent-console research) found the Linear-style
paradigm was the right visual craft but the wrong information architecture for an
autonomous-but-governed factory: a Kanban board models human-owned work pulled through
columns, but here agents do the work and a few humans only govern (approve gates, handle
escalations). The autonomous stages were structurally empty columns; the schema carried
human-labor vocabulary (assignee/owner) the domain doesn't have.

We re-centre the operator console on the three supervision questions — what needs me,
what's running, can I trust it — delivered by Mission control (ADR 0014's step-level
trace + per-gate evidence + the steer verb). Concretely:

- **Mission control is the default landing** (`/admin/mission`), superseding ADR 0010's
  Pipeline-as-default. Bands: Needs me (gates with evidence) → In flight (live runs) →
  Stalled → Recent.
- **The Kanban Board and the Pipeline view are removed.** Their attention-grouping is
  absorbed into Mission control; List survives as the flat "All requests" archive lens.
- **The Jira-grade issue page is replaced** by the request-detail trace page
  (`/admin/requests/:id`): a stage-grouped trace with provenance, not a ticket with
  labels/checklist/subscribers.
- **Vocabulary follows consequence, not labor:** filed by (provenance) / waiting on (who
  must act at the current gate) / decided by (gate history) replace assignee/owner. The
  dormant `assignee` field is removed; `reporter` ("filed by") is kept.
- **Admins file via the same intake as submitters** ("New request" → `/submit/new`); the
  Linear "New issue" composer (labels/priority/assignee) is gone.

## Consequences

- ADR 0010 (Pipeline as default landing) is superseded; the Pipeline view no longer exists.
- ADR 0004 (milestone summaries, no streaming) and ADR 0014 (step-level trace) are
  unchanged — the supervision surfaces read the same polled event rail.
- The dark theme (token swap) and the submitter's plain-language activity line ship with
  this revamp; the submitter face keeps its plain-stage vocabulary.
- The old console's surfaces are deleted, not hidden — there is no fallback board. The
  domain model (Request lifecycle, gates, the two-axis progress_event log) is unchanged.
