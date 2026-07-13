---
id: 014
title: "Slice 8: Dossier"
labels: [ready-for-agent, wayfinder:task]
status: closed
assignee: claude+codex
blocked-by: [008, 010]
user-stories: "21, 26-28"
---

## Parent

[Spec: Console redesign — The Floor (PRD)](../spec-the-floor-prd.md) · design spec: docs/superpowers/specs/2026-07-11-console-redesign-design.md · visual reference: mockups/console-floor-family.html

## What to build

One request's full story. Header with title, app, requester, state-as-a-sentence, and the same action verbs as The Floor (including take-over and send-back-to-stage). Semantic timeline grouping raw events into stages, gates, human decisions, escalations, and comments — every consequential entry signed with decided-by + time; steer notes show their ack state. Comments compose against an explicitly chosen target. Any timeline chapter expands into a raw evidence drawer (events, verification payloads, attachments) with deep links.

Hard invariants: progress_event is append-only (ADR 0008); single uvicorn worker; gate semantics preserved; work on the `console-redesign` worktree branch; never commit/push without the user's ask.

## Acceptance criteria

- [ ] Timeline reads as chapters with decided-by + timestamp on every decision
- [ ] Evidence drawer opens per chapter with raw events and attachments, deep-linkable
- [ ] All verbs work from the header with CAS conflict feedback
- [ ] Comments require an explicit target; no implicit active-request selection
- [ ] Family direction at 1440/390, light + dark; component tests cover timeline grouping and drawer

## Blocked by

[Slice 2](008-operator-identity.md), [Slice 4](010-scoped-recovery.md)

## Resolution (2026-07-13)

Implemented by codex gpt-5.6-sol, reviewed and fixed by fable-5, committed on
`console-redesign`. New `dossier/` module: `dossier-page.ts` (Family-styled
header + timeline + evidence drawers + comments), `dossier-view.ts`
(`buildDossierChapters`, a pure projection wrapping the shared `groupTrace`).
`/requests/:id` now loads DossierPage (was a stub). The header shows title, app,
requester, state-as-a-sentence, and the SAME verbs as the Floor per state (gate →
approve/send-back; escalated → retry/send-back-to-stage/take-over/cancel; always
→ comment), all wired through the shared `floorActionOutcome` CAS formatter
(extracted from floor-page so Floor and Dossier share one conflict vocabulary).
The timeline renders chapters — automated gate-opens are unsigned "Gate"
chapters, human gate decisions are signed "decision" chapters (decided-by +
time), plus stage/escalation/recovery/steer/comment chapters; steer notes derive
queued/heard from later acked_steer_ids. Each chapter expands a raw-evidence
drawer (events + payloads + attachments) deep-linkable via `#chapter-<event-id>`.
Comments post against the route's explicit id.

Review fix on top of the codex pass (a real crash the unit tests missed):
- `toSignal()` in the DossierPage field initializers threw NG0203 in the real
  router-instantiated component, so `/requests/:id` fell through to the Floor.
  TestBed masked it (its injection context differs). Fixed by injecting an
  explicit `Injector` and passing `{ injector }` to both `toSignal` calls.
  Caught only by live navigation — a reminder that green vitest ≠ working route.

Verified live: /requests/9 (shipped) renders signed chapters ("Spec approved by
Kim P. — decided by Kim P. · Jul 10 · 11:32 PM", "Merge approved by Jun Wong");
"Raw evidence ↓" opens the drawer and sets `#chapter-7`; all Dossier data calls
200; /requests/4 (escalated) header shows Retry/Send back to…/Take over/Cancel +
Comment; Family light + dark at 1440 and 375 px. pytest 185, console 66 (9 files,
7 Dossier), lint green; console build green.
