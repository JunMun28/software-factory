---
id: 007
title: "Task: backend — operator identity, conditional mutations, decision projection"
labels: [wayfinder:task]
status: open
assignee: junmun (session bd7f4bff)
blocked-by: []
---

## Question

Implement spec §10 items 1–3 (docs/superpowers/specs/2026-07-11-console-redesign-design.md (repo root)):
`operator` table + CRUD; all gate/recovery mutations take `operator_id` and
become compare-and-set with structured 409 conflict payloads
({acted_by, acted_at, resulting_state}); request detail exposes
`decided_by`/`decided_at` per gate. Additive only; `progress_event` untouched;
pytest coverage for CAS winners and losers. Work on the `console-redesign`
worktree branch.
