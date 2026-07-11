---
id: 006
title: "Grilling: multi-operator model (identity, presence, claiming)"
labels: [wayfinder:grilling]
status: closed
assignee: junmun (session 132e3c43)
resolved: 2026-07-11
blocked-by: [003]
---

## Question

How do equal-role operators exist in the system — and what coordination
mechanics does the console need so a small team can work the same factory
without collisions?

Decide, informed by ticket 003's coordination requirements:
- Identity mechanism: lightweight named profiles (pick-your-name) vs real
  accounts/auth. Equal roles either way — no RBAC.
- What actions record the operator (gate decisions, steers, take-overs) and how
  "decided by" surfaces.
- Presence/claiming: does an operator claim a gate/run before acting? What do
  others see? What happens on conflict (two approvals racing)?
- Backend shape: where operator identity lives given full-stack-additive rules
  and the single-worker invariant.

Resolve via /grilling + /domain-modeling. The answer fixes the operator domain
model and feeds the backend work list in the fog.

## Resolution

Decided by delegation ("you decide everything and write spec"), 2026-07-11,
constrained by the user's grilled choice of NO claim UI (ticket 003 Q6).
Full detail: [docs/superpowers/specs/2026-07-11-console-redesign-design.md](../../../superpowers/specs/2026-07-11-console-redesign-design.md) section 9.

- **Identity: named operator profiles, server-side** (`operator` table:
  name, initials, hue, email). Pick-or-create on first visit; the client
  stores only a pointer to the server row. No passwords; seam shaped for
  a later Entra swap. The shared "Kim P." mock dies.
- **Attribution:** every mutation carries `operator_id`; server resolves and
  stores the actor (as today) and the UI now renders decided-by + timestamp
  on every consequential event.
- **Coordination: conflicts, not claims.** All state-changing endpoints
  become compare-and-set (extending the spec-approval CAS to merge, send-back,
  retry, take-over, cancel); losers receive a structured conflict
  ({acted_by, acted_at, resulting_state}) rendered in place as a quiet
  outcome line. No leases, no presence, no claim endpoints.
- **Per-operator notification prefs** keyed to the operator row (email,
  needs-human events only).
