---
id: 008
title: "Task: backend — take-over and send-back-to-stage endpoints"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: []
---

## Question

Implement spec §10 items 4–5 (docs/superpowers/specs/2026-07-11-console-redesign-design.md (repo root)): take-over endpoint (marks request
human-owned, stops runner work, emits audit + timeline events) and
send-back-to-stage (returns an escalated run to a chosen earlier stage with
reason). Gate semantics preserved; pytest coverage. Branch: console-redesign.
