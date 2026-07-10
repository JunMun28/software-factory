---
id: 006
title: "Grilling: multi-operator model (identity, presence, claiming)"
labels: [wayfinder:grilling]
status: open
assignee:
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
