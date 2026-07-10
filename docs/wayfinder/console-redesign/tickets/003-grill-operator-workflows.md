---
id: 003
title: "Grilling: operator workflows and jobs-to-be-done"
labels: [wayfinder:grilling]
status: open
assignee: junmun (session 132e3c43)
blocked-by: [001, 002]
---

## Question

What does the small engineering team actually do in this console, day to day —
and which jobs is the console optimized for?

Candidate jobs to test with the user (informed by ticket 001's patterns and
ticket 002's ground truth): monitoring the fleet of runs, approving/rejecting
gates, steering in-flight runs, triaging failures and stalls, tracking
throughput/cost, onboarding a new request, reviewing history/audit. Which are
primary vs occasional? What does a "shift" look like — always-on wall display,
periodic check-ins, or notification-driven? What coordination do equal-role
operators need so two people don't collide on the same gate?

Resolve via /grilling + /domain-modeling, one question at a time. The answer is
a ranked list of jobs-to-be-done with the coordination requirements, recorded in
the resolution — it drives the IA ticket.
