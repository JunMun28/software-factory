---
id: 009
title: "Task: backend — real-runner step_summary and steer consumption"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: []
---

## Question

Implement spec §10 items 6–7 (docs/superpowers/specs/2026-07-11-console-redesign-design.md (repo root)): the real runner emits per-stage
`step_summary` events, reads pending steer notes at stage boundaries,
includes them in stage prompts, and writes `acked_steer_ids` in its next
step summary. Never mutate steer rows. Test via simulator parity + a faked
runner. Branch: console-redesign.
