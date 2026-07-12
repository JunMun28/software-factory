---
title: "Console redesign — The Floor (Family theme)"
labels: [ready-for-agent, spec]
status: open
created: 2026-07-12
source: docs/superpowers/specs/2026-07-11-console-redesign-design.md
tracker-note: >
  Linear (team Dreammoments) was not authorized in the authoring session;
  publish there manually or re-run with the connector authorized. Execution
  slicing lives in docs/wayfinder/console-redesign/tickets/007–014.
---

# Spec: Console redesign — "The Floor"

## Problem Statement

A small engineering team runs an automated AI software delivery platform.
The current console was built surface-by-surface and it shows: eight screens
split one job across many tabs, every browser pretends the operator is the
same mock person ("Kim P."), gate decisions don't say who decided, failed
runs offer almost no recovery, steer notes silently do nothing on real runs,
and two teammates acting on the same gate collide with no feedback. Operators
don't watch the console — they are pinged nowhere, so they poll it manually.
The result: slow gate turnaround, duplicated work, and no trust that what the
screen says is what the factory is doing.

## Solution

Rebuild the console as a calm, friendly control room in the intake app's
Micron Atlas design language ("Family" direction), collapsed to four
surfaces:

- **The Floor** (home): greets the operator, shows what needs a human first
  (gate evidence cards, stalled-run triage cards), then the runs in motion as
  lanes, then recent signed outcomes and three honest numbers.
- **Dossier**: one request's full story — semantic timeline with
  who-decided-what, steer notes with acknowledgment state, raw evidence one
  layer down, and every action verb.
- **Library**: the single list of all requests, filterable.
- **Studio**: app registry, operator profile, persisted notification
  preferences.

Backed by additive backend work: real operator identity, conflict-safe
(compare-and-set) actions, decided-by projections, take-over and
send-back-to-stage recovery, real-runner step summaries and steer
acknowledgment, and email pings when — and only when — a human is needed.

## User Stories

1. As an operator, I want the home page to show gates and failures before healthy runs, so that I act on what matters within seconds of opening the console.
2. As an operator, I want an email with a deep link when a gate is raised, so that I don't have to poll the console.
3. As an operator, I want an email when a run fails or stalls, so that broken work never waits for a coincidence.
4. As an operator, I want no email for healthy progress or deliveries, so that pings stay meaningful.
5. As an operator, I want a spec-gate card showing the grounded spec evidence and the requester, so that I can approve without leaving the console.
6. As an operator, I want a merge-gate card showing diff summary, test results, checks, and plan adherence, so that I can judge the merge on evidence.
7. As an operator, I want every gate card to state its consequence in plain words ("Approving will merge PR #87 into main and deploy Payroll"), so that I know the blast radius before I click.
8. As an operator, I want a link from the merge card to the GitHub PR, so that I can escape to the raw diff when the summary isn't enough.
9. As an operator, I want to send a gate back with a note, so that the submitter knows what to fix.
10. As an operator, I want a stalled run to surface as a triage card with its last signal and stage position, so that I can diagnose at a glance.
11. As an operator, I want to retry the failed stage, so that transient failures cost one click.
12. As an operator, I want to send a run back to a chosen earlier stage with a reason, so that bad plans get replanned instead of re-executed.
13. As an operator, I want to take over a request (stop the runner, mark it human-owned), so that I can finish by hand when automation can't.
14. As an operator, I want to cancel a request, so that dead work leaves the floor.
15. As an operator, I want each in-flight run shown as a lane across spec → plan → build → review → merge → ship with step m of n, so that I see position and progress without reading logs.
16. As an operator, I want run health shown by shape and word ("● steady", "▲ quiet for 24 m"), never color alone, so that state is unambiguous and accessible.
17. As an operator, I want to type a steer note on a running lane, so that I can redirect the agent without stopping it.
18. As an operator, I want my steer note to show "queued" until the runner acknowledges it and then "heard at step 4", so that the console never pretends the agent listened.
19. As an operator on a real (non-simulated) run, I want the same step summaries and steer acknowledgments the simulator emits, so that real runs are first-class citizens on the Floor.
20. As a teammate of other operators, I want to pick or create my named operator profile once, so that my actions are attributed to me, not to a shared mock user.
21. As a teammate, I want every gate decision, recovery action, steer, and comment stamped with the operator and time, so that "who did this?" is never a mystery.
22. As a teammate, I want the second of two racing approvals to get a clear in-place outcome ("Approved by Kim P. at 14:02"), so that a race never produces confusion or double side effects.
23. As a teammate, I want merge approval protected by the same one-winner atomic update as spec approval, so that irreversible side effects can never run twice.
24. As an operator, I want "Recently" on the Floor to list the last outcomes with who decided and when, so that catch-up after hours away takes one glance.
25. As an operator, I want three honest numbers (shipped this week, median cycle time, median wait-on-human), so that I sense factory health without an analytics tool.
26. As an operator, I want the Dossier timeline to group raw events into stages, gates, and human actions, so that I read a story, not a firehose.
27. As an operator, I want any timeline chapter to expand into its raw events, verification payloads, and attachments with deep links, so that evidence is one layer beneath meaning.
28. As an operator, I want to comment on an explicitly chosen request from its Dossier, so that discussion always lands on the right work.
29. As an operator, I want the Library to filter by app and state via the URL, so that a filtered view is shareable and a drill-down link actually works.
30. As an operator, I want Studio to persist my notification preferences per app on the server, so that muting an app means it stays muted on every machine.
31. As an operator, I want to register and edit apps in Studio, so that the registry stays current without touching the database.
32. As an operator, I want the console to show data freshness ("synced 4 s ago") and never silently reorder what I'm reading, so that I trust the screen.
33. As an operator, I want changes made by teammates (including registry and profile edits) to reach my browser within one polling cycle, so that no one acts on stale state.
34. As a keyboard user, I want the command palette, G-chords, and gate keys (J/K/Enter/A/S) preserved, so that frequent actions never need the mouse.
35. As an operator, I want the console to look and speak like the intake app (Micron Atlas: purple accent, amber=gate, red=needs-human, green=success, friendly sentences), so that the factory feels like one product.
36. As an operator, I want light and dark themes that both meet contrast standards at desktop and phone widths, so that the console works on any shift and any screen.
37. As a motion-sensitive user, I want all animation subtle, interruptible, and disabled under prefers-reduced-motion, so that the Floor stays calm.
38. As an operator with old bookmarks, I want legacy /admin/* URLs to redirect to the new surfaces, so that nothing breaks on cutover.
39. As an operator, I want an all-clear Floor state ("Nothing needs you — 3 requests in motion"), so that a healthy factory reads as peace, not absence.
40. As a maintainer, I want the old eight surfaces, dead routes, and dead style tokens deleted at cutover with an ADR recording the new IA, so that the codebase tells one truth.

## Implementation Decisions

- **IA**: four surfaces — The Floor (default route), Dossier, Library,
  Studio. Mission control, Factory map, Gates queue, Needs-me inbox, per-app
  Feed, and preview-only Settings are removed; their jobs fold into the four.
  Navigation is a slim top bar plus the command palette; no sidebar.
- **Visual identity**: the intake app's Micron Atlas tokens verbatim (shared
  or copied token source), Micron Basis + JetBrains Mono, small radii,
  hairline borders, one purple accent, amber/red/green status discipline —
  at most one amber and one red block per surface. Reference artifact:
  the approved Family mockup lab (came out of the prototype ticket; encode
  its card/lane/chip patterns rather than inventing new ones).
- **Operator identity**: an operator table (name, initials, hue, email);
  pick-or-create on first visit; client stores only a pointer to the server
  row; no passwords now, seam shaped so real auth can replace profile-picking
  later. All mutations carry the operator id; the server resolves and stores
  the actor.
- **Coordination**: no claims, no presence, no leases. Every state-changing
  endpoint validates against current state with an atomic compare-and-set
  (extending the existing spec-approval pattern to merge approval, send-back,
  retry, take-over, cancel) and returns a structured conflict
  (acted_by, acted_at, resulting_state) that the UI renders in place.
- **Recovery verbs**: retry stage (exists), plus new take-over and
  send-back-to-stage endpoints; cancel preserved. Each verb states its blast
  radius before confirming.
- **Supervision honesty**: the real runner emits per-stage step_summary
  events, reads pending steer notes at stage boundaries, injects them into
  stage prompts, and reports acked_steer_ids in its next step summary. Steer
  rows and progress events are never mutated (append-only log invariant,
  ADR 0008).
- **Decided-by projection**: gate decisions expose decided_by/decided_at
  from the already-persisted gate_event/audit actor data; the UI renders it
  on the Floor's Recently list and throughout the Dossier timeline.
- **Notifications**: email only, on gate-raised / escalation / stall, to
  operators subscribed to that app (default all), with a Dossier deep link.
  SMTP config via environment; missing config degrades to log-only and
  Studio says so.
- **Freshness**: keep the 4-second cursor poll over the append-only event
  log; add a lightweight revision counter bumped by mutations that emit no
  progress event (registry, operator, preferences) so all browsers converge.
  No WebSockets — polling is sufficient at 1–5 concurrent runs and respects
  the single-worker invariant (ADR 0013 area).
- **Runner-mode badge**: the shell reads the health endpoint's actual
  runner-mode values instead of testing for a value that never occurs.
- **Cutover**: build on a worktree branch; backend slices land first
  (invisible to the old UI), new surfaces replace old routes at the end of
  the branch, old components and dead tokens deleted in the same branch,
  legacy routes 301-redirect. One new ADR records the IA and supersedes the
  affected parts of the supervision-console and factory-map ADRs.

## Testing Decisions

- **Primary seam: the FastAPI HTTP API via the existing pytest TestClient
  suite.** All new behavior (operator CRUD, CAS winners and losers, take-over,
  send-back-to-stage, decided-by projection, steer ack round-trip, email
  trigger selection, revision counter) is asserted through HTTP requests and
  observable responses/events — never by poking internals. Prior art: the
  existing gate and lifecycle tests in the API test suite.
- **Runner behavior** is tested through the same seam using the simulator
  (full contract) plus a faked runner exercising the real-runner code path
  for step summaries and steer consumption; email sending is asserted via a
  captured transport, not a live SMTP server.
- **Console components** are tested with the existing vitest setup against
  mocked API payloads: gate card renders evidence and consequence, conflict
  409 renders the outcome line, lanes derive position from step data, steer
  chip flips only on server ack, Library filters follow query params. Prior
  art: existing console component specs.
- **What makes a good test here**: assert what an operator can observe
  (response bodies, emitted events, rendered text/roles), not implementation
  details; every CAS test must cover both the winner and the loser; nothing
  may assert against mutated progress_event history (append-only).
- **Whole-system gate**: `make verify` (lint + pytest + vitest + Angular
  build + smoke) green before merge, plus the visual proof matrix
  (1440/390 × light/dark per surface) and a keyboard/reduced-motion pass.

## Out of Scope

- Intake app changes; frontend framework migration.
- RBAC, roles, or real authentication beyond named operator profiles (seam
  left for later).
- Claim/lease/presence coordination (explicit decision: conflicts, not
  claims).
- Cross-request audit/history surface; analytics or cost dashboards beyond
  the three Floor numbers.
- Slack/chat notifications (email only this round); WebSockets/live push.
- Multi-worker or horizontal scaling (single uvicorn worker invariant
  stands).

## Further Notes

- Decision provenance: wayfinder map at docs/wayfinder/console-redesign/
  (research, audit, grilling resolutions), design spec
  2026-07-11-console-redesign-design.md (approved), visual direction lab
  mockups/console-floor-family.html (approved). Execution is pre-sliced into
  tickets 007–014 in the map's tickets directory — agents can work those in
  order; 007/008/009 are parallel-safe.
- Hard invariants for any implementer: progress_event rows are never updated
  or deleted; single uvicorn worker; the two human gates keep their
  semantics; never commit or push without the user's explicit ask; merge only
  after showing green `make verify` output.
