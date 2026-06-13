# UI supervision revamp — design

**Date:** 2026-06-12
**Status:** approved in brainstorming; awaiting spec review
**Scope:** total revamp of the admin console around a supervision-first frame, plus
submitter transparency and dark mode. Full-stack, additive backend changes.

## 1. Context and motivation

A two-track review (code-level critique + external research on agent-console design)
found that the current Linear-style paradigm is the right *skin* but the wrong *spine*
for an autonomous-but-governed factory:

- The Kanban Board needs an `inert()` predicate because the autonomous stages
  (Architecture, Build) are structurally always empty — agents pass through too fast
  to dwell. Cards pile up only at human gates. A column models where a human parks a
  task; our stages are transient machine throughput.
- Human-labor vocabulary dominates (`assignee` 28 refs, `owner` 17, `Reporter` 11 in
  admin code) while agent-supervision vocabulary is absent (confidence, run-state,
  test evidence, steer: 0 refs each). The frame shaped the schema.
- The best existing surfaces (grounded approval queue, Needs-me inbox) already
  abandoned Linear. Industry consoles (Devin, GitHub Agent HQ, Factory.ai) converge
  on the same shapes: live run cards, per-run traces, diff-first review, approval
  inboxes — "mission control", not a tracker.
- The merge gate — the highest-stakes approval — currently shows no tests, no diff,
  no reviewer report. The spec gate's provenance pattern was never generalized.

The reimagination: organize the console around the operator's three questions —
**what needs me / what's running / can I trust it** — instead of a backlog.

## 2. Decisions made

| Decision | Choice |
|---|---|
| Depth | Total revamp: admin console rebuilt on the supervision frame; submitter face revisited |
| Backend | Full stack, additive (new event kinds, endpoints, simulator behavior) |
| Observability depth | Step-level trace timeline (summaries at step boundaries; never streaming) |
| Submitter | More transparency: plain-language "what's happening now" line on the request page |
| Surviving views | Board and Pipeline deleted; List survives as the archive lens; Mission control is home |
| Build strategy | Parallel build, clean cutover: new routes beside old, one final cutover commit |

## 3. Success criteria

1. **One-glance test** — from Mission control an admin can answer: what needs me,
   what's running and is it healthy, can I trust this gate — without opening another
   view. Every gate shows real evidence before its Approve button.
2. **Nothing lost** — every current capability (approve, send back, cancel, retry,
   take over, registry, settings, submitter flows) still reachable; `make verify`
   fully green.
3. **Calm held** — one-amber/one-red per surface, plain submitter vocabulary, and the
   no-streaming line all survive.
4. **Dark mode** — both faces, token-level, AA contrast, system default + settings
   override, verified by screenshots.
5. **Performance bar** — polling never flashes (only changed rows re-render); gate
   actions are optimistic and feel instant; Angular build stays within current
   budgets.

## 4. Information architecture

Admin sidebar reorganizes into three groups:

**Supervise**
- **Mission control** — home, `/admin/mission`, `G M`. Bands: Needs me (gates) →
  In flight (runs) → Stalled (needs human) → Recently done / with submitter.
- **Gates** — `/admin/gates`, `G G`. Today's Approval queue, renamed and ported:
  two-pane, J/K, full grounded spec reading. Mission control gate cards deep-link here.
- **Needs me** — clear-to-zero inbox, unchanged role (snooze, mark read).
- **Activity** — per-app feeds, unchanged role. Milestone-level only; step events
  never appear here (firehose guard).

**Find**
- **All requests** — today's List as the archive lens: flat, filterable, everything
  including done/cancelled. Lenses: Active / With submitter / Done / Cancelled.
  Filters stay AND-only.

**Manage** — App registry, Settings (restyled only).

**Deleted:** Board (Kanban), Pipeline (its attention grouping becomes Mission
control), and the Linear-style "New issue" composer (labels/priority/assignee).
Admins who need to file something get a plain "New request" that uses the same
intake path as submitters.

**Vocabulary purge:** `assignee` / `owner` / `Reporter` / `Subscribers` are removed.
Replaced by three honest concepts: *filed by* (provenance), *waiting on* (who must
act at the current gate), *decided by* (gate history). Avatars appear only on humans
who must act or have decided.

Keyboard grammar carries over everywhere: G-nav, J/K, A/S/C, ⌘K, hover shortcut
tooltips.

## 5. Data model and API (all additive)

### New `progress_event` kinds (same two-axis rail, ADR 0008 untouched)

- `step_summary` — one per finished agent step.
  Payload: `{step: 3, of: 9, label: "writing tests", why: "..."}`.
  Powers the trace timeline and the submitter activity line.
- `verification` — written when a run reaches a gate.
  Payload: tests passed/total, diff stats (added/removed/files), reviewer verdict,
  assumptions list. Powers gate evidence strips.
- `steer_note` — a human note injected mid-run; the runner consumes it at the next
  step boundary and acknowledges it in its next `step_summary`.

### Run-state is derived, not stored

Current step and label come from the latest `step_summary`. Health comes from
time-since-last-event: fresh = healthy, over threshold = slow, escalation event =
stalled, no signal = "no signal for Nm" (never a false "stalled"). Default
threshold: slow after 3× the simulator tick interval (`SIM_INTERVAL`), overridable
via one env var (`RUN_SLOW_AFTER_SECONDS`). No new mutable columns.

### New API surface

- `GET /api/requests/{rid}/trace?after=` — keyset cursor; step events + milestones
  for one request.
- `POST /api/requests/{rid}/steer {note}` — appends `steer_note`; 409 unless the
  request is in flight. Note length validated.
- `GET /api/mission` — one aggregate for the home (gates with evidence, runs with
  run-state, stalled, recent) so Mission control polls one endpoint.
- Request detail response gains an `evidence` block (latest verification) and a
  `run` block (derived run-state).

### Simulator (ADR 0009)

The scripted brain gets step plans per stage with believable labels and "why" lines,
emits `verification` at gates, and echoes steer notes — the whole UI is demoable
without real agents. Seed data updated to produce step events.

## 6. Surfaces

### Mission control (home)

Four bands, one poll (`GET /api/mission`, 3–5s diff-merge, never a flash):

1. **Needs me — gates.** Card: title, gate pill (SPEC/MERGE), app, mono ref, then the
   evidence strip (tests, diff stats, reviewer verdict, grounding count), then amber
   assumptions line, then the side-effect line. Inline actions: `A` approve,
   `S` send back (Approve confirms by naming side effects); `D` opens the full diff
   in Gates.
2. **In flight — runs.** Pulse dot, title, stage pill, app, ref, progress bar
   (step N of M), current step label, elapsed, health. **Steer** expands an inline
   note box (no modal); the note lands in the trace and the agent acknowledges next
   step.
3. **Stalled — needs a human.** Red, at most one per surface, escalation reason
   verbatim, Retry / Take over / Open.
4. **Recently done & with submitter.** Quiet tail, last 7 days, links to All requests.

All-clear state: zero gates + zero stalled renders a calm hero ("Nothing needs you")
with runs still visible below.

### Gates

Port of the existing queue (not a rewrite): two-pane, J/K auto-advance, grounded
draft spec with provenance tags `(from: Qn)` / `(ASSUMPTION — not stated)`, pinned
open-questions block, A/S/C action bar with side-effect-naming confirms. New: merge
gates get a full evidence pane — diff summary, test detail, reviewer report.

### Request detail (`/admin/requests/:id`)

Replaces the Jira-grade issue page. Header: title, ref, app, stage, status,
run-state chip when in flight, *waiting on* / *decided by* line. Body: the **trace
timeline** — step summaries grouped by stage (older stages collapsed), each with
label, headline, expandable "why"; steer notes + agent acknowledgments inline;
milestones and gate decisions punctuate the flow. Comments stay on the rail
(ADR 0012) with a plain composer. Recovery cluster (Retry / Retry with note /
Send back to stage / Take over / Cancel) on needs-human.

### All requests

List ported minus the assignee column and assignee grouping. Row: glyph, title,
type chip, app, stage/status, waiting-on, age. Keyset pagination, search.

### Activity (per-app feeds)

Channel rail, milestone cards, gate broadcasts — unchanged role. The Slack-style
formatting toolbar is removed; a plain comment box stays.

### Submitter face

- Request detail page: one live line under the current tracker stage —
  "Building — writing tests (step 6 of 9)" — translated from the latest
  `step_summary` through a fixed dictionary (admin step labels → submitter-safe
  words). GitHub/PR/repo vocabulary structurally cannot leak: unknown labels fall
  back to the bare stage name.
- My-requests list, flows, and stage vocabulary (Submitted … Deployed, Needs your
  input) unchanged.
- Everything else is a token-level visual refresh.

## 7. Dark mode and tokens

- `[data-theme]` swap on the existing CSS custom properties; no component changes.
- Dark canvas is warm near-black tinted toward the brand hue (never #000); purple,
  amber, red, green get dark variants tuned for AA contrast; the diff green/red pair
  gets its own dark values.
- Default follows `prefers-color-scheme`; Settings toggle overrides, persisted in
  localStorage; the attribute is set inline in `index.html` before first paint.
- Carried over unchanged: Micron Basis + JetBrains Mono, 8px rhythm, hairlines not
  boxes, radii 4/6/10, status-by-shape glyphs, one-amber-one-red, 80/140/240ms motion.
- New shared components in the same global vocabulary: evidence strip, run row
  (pulse + progress + health), steer composer, trace step row, band header.

## 8. Edge cases and error handling

- **Steer races:** run reaches its gate before consuming a note → note shows in the
  trace as "not consumed — run already at gate". Steering anything not in flight →
  clean 409.
- **Honest health:** derived from event recency; quiet signal renders "no signal for
  Nm", never a false "stalled". The "Updated Ns ago" whisper goes amber when polling
  itself lags.
- **Missing evidence:** gates with no `verification` event show "no evidence
  recorded" — approvable, gap visible.
- **Old data:** requests predating step events render their trace from milestones
  alone.
- **Optimistic failures:** failed gate actions restore the row with a specific
  recoverable error; typed steer notes are never lost on error.
- **Long traces:** keyset pagination; older stages collapsed by default.

## 9. Testing

- **pytest:** new event kind validation; trace endpoint keyset behavior; steer
  lifecycle (append → consume → ack; 409 paths); mission aggregate shape; health
  thresholds; simulator step plans + verification emission; append-only invariants
  (ADR 0008) re-asserted.
- **vitest:** submitter vocabulary dictionary (admin terms can never leak);
  run-state display; evidence strip with missing fields; glyph logic.
- **smoke:** extended end-to-end — file → spec gate with evidence → run with step
  events → steer acknowledged → merge gate with verification → approve → deployed.
- **Visual:** light + dark screenshots at 1440px and 390px, every surface, before
  cutover.
- `make verify` green at every commit (parallel-build strategy guarantees the old
  console keeps working until cutover).

## 10. Cutover plan

1. Backend additive (event kinds, endpoints, simulator) — verify green.
2. New shell + Mission control at `/admin/mission` beside old views (default route
   unchanged).
3. Gates evidence pane, request detail trace, All requests, Activity restyle.
4. Submitter activity line + dark mode.
5. Success-bar check (criteria §3, including dark/light screenshot pass).
6. One cutover commit: default route flips to Mission control; Board, Pipeline, old
   issue page, and the New-issue composer are deleted; vocabulary purge lands; new
   ADR records step-granularity summaries (ADR 0004 core holds: no websockets, no
   token streaming); new ADR supersedes ADR 0010 (Pipeline as default landing).
7. Final verify + design review.

Rollback: everything before step 6 is additive; reverting the cutover commit
restores the old console.

## 11. Out of scope

- Real agent runtimes beyond the simulator (FACTORY_RUNNER/FACTORY_CLI unchanged).
- SSE/websockets (ADR 0007 polling holds; the keyset seam stays drop-in).
- Submitter mid-build Q&A (rejected as over-building for one-and-done users).
- User-authored saved views, OR-filters, multi-team (PRODUCT.md restraint holds).
- The shelved bidirectional ChatOps feed (separate, parked design).
