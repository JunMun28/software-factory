---
id: 010
title: "Task: backend — email notifications, projection freshness, runner-mode fix"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [007]
---

## Question

Implement spec §10 items 8–10 (docs/superpowers/specs/2026-07-11-console-redesign-design.md (repo root)): email on gate/escalation/stall to
subscribed operators (SMTP via env, log-only fallback surfaced in Studio);
revision counter so non-event mutations (registry/operator/prefs) refresh
other browsers; health endpoint/shell agree on runner-mode values.
Blocked by operator identity (prefs are per-operator).
