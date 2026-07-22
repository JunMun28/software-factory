---
id: 001
title: "Research: world-class control-room and agent-fleet references"
labels: [wayfinder:research]
status: closed
assignee: unassigned (session 132e3c43)
resolved: 2026-07-10
blocked-by: []
---

## Question

What do the best operations consoles, control rooms, and agent-fleet products do
that this console should learn from — in IA, data display, coordination, and
visual craft?

Survey (online): Linear, Vercel, Datadog, Temporal UI, GitHub Actions, incident
response tools (incident.io, FireHydrant, PagerDuty), AI-agent fleet dashboards
(OpenAI/Anthropic operator consoles, Devin, Factory.ai, agent-ops startups), and
industrial HMI / mission-control design principles (NASA, SCADA, high-density
monitoring UX).

Extract: recurring surface patterns (what screens exist), density and hierarchy
techniques, live-data presentation, team-coordination affordances, and visual
identity moves that make a console read as "world class". Note anti-patterns too.

Deliverable: markdown summary as a linked asset (e.g.
`docs/wayfinder/console-redesign/assets/001-references.md`), organized by
pattern with sources, ending with a shortlist of patterns recommended for this
factory.

## Resolution

Asset: [001-references.md](../assets/001-references.md) — 331 lines, ~48
primary-source citations, researched via codex gpt-5.5 with browser access
(Claude subagents were blocked by the account's monthly spend cap).

Four survey areas covered: product-tool craft (Linear, Vercel, Datadog,
Temporal, GitHub Actions), incident-response coordination (incident.io,
FireHydrant, PagerDuty), AI-agent fleet supervision (Devin, LangSmith,
OpenAI Operator, Claude Code), and mission-control/HMI standards (NASA,
ISA-101, ISA-18.2, Endsley situational awareness).

The 15-pattern shortlist, gisted:

1. Attention-first home (actionable items before healthy throughput).
2. Dense fleet table as the default view of parallel runs.
3. Three-layer drill-down: fleet → semantic timeline → raw evidence.
4. Atomic "I'm on it" claim to prevent duplicate gate work among equals.
5. Actor + timestamp on every consequential event ("decided by").
6. Small explicit status taxonomy (running/waiting/needs-human/claimed/
   failed/canceled/completed — never one overloaded red/green field).
7. Freshness as data; no silent auto-refresh stealing reading position.
8. Context-sensitive command palette; one action grammar everywhere.
9. Saved shareable operational views instead of dashboard sprawl.
10. Alarm color budget: neutral surfaces normal, saturated color = actionable.
11. Approval evidence card at irreversible boundaries (action, diff, tests,
    blast radius, requester, expiry).
12. Scoped recovery (retry failed stage vs rerun pipeline vs cancel).
13. Shared situation home + focused detail workstation (NASA model).
14. Perceive → comprehend → project ordering of information.
15. Append-only semantic timeline: raw events preserved, grouped into
    stages/gates/human actions with deep links.

Plus 14 anti-patterns; the ones most likely to bite this redesign:
mission-control cosplay (neon/CRT aesthetics without function), wall of
live logs as IA, presence without claims, one giant "running" state,
alarm floods.

Feeds: operator-workflows grilling, IA-from-zero, visual-identity
prototype (now unblocked), multi-operator model.
