---
id: 014
title: "Task: cutover — delete old console, ADR, verify, merge"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [009, 011, 012, 013]
---

## Question

Spec §12 steps 4–6: remove old surfaces/routes/components/dead tokens,
keep permanent redirects; write the new ADR ("Console IA: The Floor",
superseding parts of 0015/0016); run `make verify` and the visual proof
matrix (1440/390 × light/dark per surface, keyboard pass,
prefers-reduced-motion); show output to the user; merge only after the user
sees green verify. Never commit/push without the user's ask.
