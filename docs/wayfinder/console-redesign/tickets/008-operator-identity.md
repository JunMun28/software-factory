---
id: 008
title: "Slice 2: operator identity end-to-end"
labels: [ready-for-agent, wayfinder:task]
status: closed
assignee: claude+codex
blocked-by: [007]
user-stories: "20, 21, 30 (profile)"
---

## Parent

[Spec: Console redesign — The Floor (PRD)](../spec-the-floor-prd.md) · design spec: docs/superpowers/specs/2026-07-11-console-redesign-design.md · visual reference: mockups/console-floor-family.html

## What to build

Real named operators replace the shared mock identity. Server-side operator store (name, initials, hue, email) with list/create API; Studio hosts pick-or-create-your-profile; the client persists only a pointer to the server row. Every mutation (gate decisions, recovery, steer, comments) carries the operator id; the server resolves and records the actor. The Floor's Recently list renders decided-by + time from the persisted actor data. The seam must allow a later real-auth swap without touching call sites.

Hard invariants: progress_event is append-only (ADR 0008); single uvicorn worker; gate semantics preserved; work on the `console-redesign` worktree branch; never commit/push without the user's ask.

## Acceptance criteria

- [ ] First visit prompts profile pick/create in Studio; identity survives reload via server-row pointer
- [ ] Approving a gate records the real operator; Recently shows 'approved by <name> · <time>'
- [ ] All mutation endpoints reject a missing/unknown operator id with a clear error
- [ ] The hard-coded shared mock user is gone from the console
- [ ] pytest covers operator CRUD and actor recording; component test covers the signed Recently row

## Blocked by

[Slice 1](007-shell-and-readonly-floor.md)

## Resolution (2026-07-13)

Implemented by codex gpt-5.6-sol, reviewed and fixed by fable-5, committed on
`console-redesign`. Backend `operator` table (name/initials/hue/email) with
`GET/POST /api/operators`; two seeded demo operators. Every console verb
(approve, send-back, retry, cancel, steer, comment) now takes `operator_id`;
the server resolves it to the row and records that actor — a client-sent name
is ignored (proven by a forged-name test). Missing id → 422, unknown id → 404.
Mission `recent` became a signed projection (`request`, `outcome`, `decided_by`,
`decided_at`) derived from AuditEvent; the Floor's Recently renders
"<Outcome> · <title> · by <name> · <time>". Console `Session` stores only
`sf-console-operator-id` and resolves it against the API on boot (the auth-swap
seam: call sites depend only on the resolved operator/operatorId). First visit
with no valid pointer is routed to Studio by the admin guard; `/studio` itself
is unguarded. Studio replaces its stub with pick-or-create (auto/editable
initials, preset hues, email). The shared Api mutation methods stay
source-compatible so the intake app needed no edits.

Review fixes on top of the codex pass:
- codex's `MissionOut.recent` type change broke the old `admin/mission.ts`
  consumer (still `FactoryRequest[]`); codex's "console build exit 0" claim was
  wrong. Fixed the dead admin component to read `rec.request.*` so it compiles
  (it is deleted at cutover 016).
- `shippedThisWeek` and the "Shipped" outcome looked for `outcome === 'shipped'`,
  but the backend emits `approved_merge` for a ship → the stat was permanently 0
  and no row got the green treatment. Remapped `approved_merge → Shipped` (green,
  counted); added a vitest locking it in.
- Restored `test_illegal_approve_rejected`'s 409 state-guard coverage (it now
  sends a valid operator so it reaches the state check, not just the 422).

Verified live: first-visit `/`→`/studio` redirect; picking Dana Reyes stored the
pointer and stamped the JW mark (#7C5CFC); a merge approval returned 200 and
Recently showed "Shipped · Migrate auth to SSO · by Dana Reyes · now" with
shipped-this-week = 1; seeded rows honestly show their recorded actor. Studio
verified light + dark. pytest 166, console 46, shared 85, intake 33 green;
console + intake build green; console lint green.
