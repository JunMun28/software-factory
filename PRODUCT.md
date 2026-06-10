# Software Factory — product context

register: product

## Product purpose
The operator console for an autonomous-but-governed AI software factory. Requests flow
requirements → architecture → TDD build → review → deploy, with humans gating the
irreversible (spec approval, merge/deploy). Full design rationale: docs/design/ui-ux/.

## Users
- **Submitters** (non-technical Micron staff): file and track requests in plain language,
  never see GitHub or Control-center vocabulary. Guided, 16px, calm.
- **Admins** (a handful of platform reviewers): live in the Control center all day,
  keyboard-first, dense single-line rows. Expert-repeat use, not novice onboarding.

## Brand & tone
Micron Atlas lineage: light surfaces, near-white warm canvas, Micron purple #BD03F7
as the single accent, Micron Basis type, JetBrains Mono for refs/repos. Mission-control
restraint: quiet, precise, fast. The only loud colors are amber (a gate waiting on you)
and red (needs-human), at most one of each per surface.

## Anti-references
Jira's configurability sprawl; Slack's notification volume; consumer-SaaS gradients,
glassmorphism, marketing gloss; dark-mode-by-default "tool aesthetic".

## Strategic principles
1. Quiet by default, loud only when it matters (tier by consequence).
2. Structure felt, not seen (hairlines + 8px rhythm, not boxes).
3. Keyboard-first for Admins; every primary action has a key.
4. Status by shape (dotted/ring/check/strike/flag), color layered on top.
5. Grounded approval beats fast approval (provenance tags, friction only at Approve).
6. Do not over-build: a handful of admins, no WIP limits, no custom views.
