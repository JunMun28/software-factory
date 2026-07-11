---
title: Console redesign — world-class factory control room
labels: [wayfinder:map]
status: open
created: 2026-07-10
tracker: local-markdown
---

<!--
Local-markdown tracker conventions (no external tracker connected):
- This file is the map. Tickets are child files in ./tickets/, one per issue.
- Ticket identity = its file (id + title in frontmatter). Refer by title, link the file.
- status: open | closed. assignee: empty = unclaimed; a session claims a ticket by
  setting assignee BEFORE any work.
- blocked-by: [ids]. A ticket is unblocked when every listed ticket is closed.
- Frontier = open + unblocked + unassigned tickets.
- Resolutions are appended to the ticket file under `## Resolution`, then status
  flips to closed and a one-line pointer is added to Decisions so far below.
-->

## Destination

A from-zero redesign of `apps/console` as a small engineering team's control room
for the automated AI software delivery platform — shipped to main, `make verify`
green, visually verified in light and dark mode. Execution is in scope: the map
is done when the redesigned console is merged, not merely specified.

## Notes

- **Execution override:** this map carries execution tickets, not only decisions
  (user chose "shipped in code" as the destination).
- **Stack fixed:** Angular 22 (signals, standalone) + FastAPI monorepo. No
  framework migration.
- **Full-stack additive:** new endpoints/event kinds allowed. Hard invariants
  hold: append-only `progress_event` (ADR 0008), single uvicorn worker, existing
  gate workflow semantics.
- **Scope:** `apps/console` only. Intake app untouched.
- **Audience:** small engineering team, equal roles — no RBAC, no role hierarchy.
- **Design flow:** online research → local HTML mockup labs in `mockups/` → user
  approval before building. User rules: visual mockups approved before build;
  never commit/push without asking; merge only after `make verify` output is
  shown; verify UI at 1440px and 390px, light + dark.
- **Skills to consult:** research, grilling, domain-modeling, prototype,
  impeccable, frontend-design, spartan, angular-developer, design-review.
- **Prior art in repo:** June 2026 supervision revamp spec
  `docs/superpowers/specs/2026-06-12-ui-supervision-revamp-design.md` and plans
  under `docs/superpowers/plans/2026-06-12-supervision-revamp-*.md`; ADR 0015.
  Known deferred gaps: no approver field on RequestDetail, real runner emits no
  supervision events, take-over/send-back endpoints missing.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

- [Research: world-class control-room and agent-fleet references](tickets/001-research-world-class-control-rooms.md) — 15 recommended patterns + 14 anti-patterns from Linear/Vercel/Datadog/Temporal/GitHub Actions, incident tooling, agent-fleet products, and NASA/ISA HMI standards; core thread: attention-first home, dense fleet table, three-layer drill-down, atomic claims, alarm color budget. Full study: [assets/001-references.md](assets/001-references.md).
- [Research: audit the current console and supervision backend](tickets/002-audit-current-console-and-backend.md) — ten surfaces inventoried with feeds/events/refresh; deferred gaps verified against code (approver identity + take-over/send-back CONFIRMED absent, real-runner verification FIXED, steer notes PARTIAL); 14 multi-operator hazards (mock shared identity, no claims, silent action errors); 12 candidate additive backend items; keep lifecycle/event-log/derived read models, treat IA/routes/styling/local identity as disposable. Full audit: [assets/002-current-state-audit.md](assets/002-current-state-audit.md).
- [Grilling: operator workflows and jobs-to-be-done](tickets/003-grill-operator-workflows.md) — notification-driven + check-ins; jobs ranked gates → triage → glance → steer → history → numbers; email pings (needs-human only), gates decided fully in-console, full scoped recovery verbs, **no claim UI** (first decision wins + conflict feedback), steering made real, 1–5 concurrent scale, embedded metrics only, per-request history with decided-by.
- [Grilling: information architecture from zero](tickets/004-grill-information-architecture.md) — (delegated) eight June surfaces collapse to four: **The Floor** home, **Dossier**, **Library**, **Studio**; Factory map/queue/inbox/feed killed with reasons; no sidebar — hairline top bar + command palette. Detail: spec §4–7.
- [Grilling: multi-operator model](tickets/006-grill-multi-operator-model.md) — (delegated) server-side named operator profiles (no passwords, Entra-shaped seam); decided-by rendered everywhere; compare-and-set on all mutations with structured conflict payloads; no leases/presence/claims. Detail: spec §9.
- **Redesign spec approved:** [docs/superpowers/specs/2026-07-11-console-redesign-design.md](../../superpowers/specs/2026-07-11-console-redesign-design.md) — "The Floor": IA, surface specs, backend work list (10 items), verification plan, build & cutover. User approved 2026-07-11.
- [Prototype: visual identity directions](tickets/005-prototype-visual-identity.md) — **"Family" approved**: the console adopts the intake app's Micron Atlas theme verbatim (purple accent, amber/red/green status discipline, friendly plain-language copy). Winning lab: `mockups/console-floor-family.html`; A/B/C kept as rejected references. Dossier/Library/Studio inherit the direction — no more mini-labs.

## Not yet specified

(Nothing — the design phase is complete. The route to the destination is now
the eight open execution tickets, 007–014: four backend slices → shell +
Floor → Dossier → Library/Studio → cutover/verify/merge. All build work
happens on the `console-redesign` worktree branch.)

## Out of scope

- Intake app changes (console only — scoping decision at charting).
- Frontend framework migration (stack fixed at charting).
- Role hierarchies / RBAC (equal-role team by decision at charting).
- Multi-worker / horizontal scaling (single-worker invariant stands).
