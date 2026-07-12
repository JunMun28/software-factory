# Intake flow redesign — adaptive Tracks

**Date:** 2026-07-12 · **Status:** approved design, pre-plan
**Decision record:** [ADR 0023](../../adr/0023-adaptive-intake-tracks.md) · **Vocabulary:** `Track` in [CONTEXT.md](../../../CONTEXT.md)

## Goal

The intake journey reshapes itself per request: a bug report is a minute of structured
facts, a new app is a deep session. One machine, per-track configuration — not four
bespoke flows.

## The Track model

A **Track** is the shape of one Submitter's journey: which steps it includes and how deep
the interview goes. Derived from the inferred Request type **plus** how rich the
description already is. Intake-app concept only; the Factory consumes the Request type.

### Universal skeleton

```
Describe → [classify] → Basics (per-type sections, chip on top)
        → Adaptive interview → Review (always) → Submit
```

The **New app** track inserts **Prototype** between interview and Review. Prototype stays
New-only: for an existing app the brain would invent fantasy UI and anchor the spec wrongly.

### Per-track configuration (data, not code)

| Track | Basics sections | Interview ceiling | Prototype |
|---|---|---|---|
| Bug fix | Which app · Show us where (link/screenshot) · How often | 3 | — |
| Improvement | Which app · Who benefits · What would winning look like | 4 | — |
| New app | Who feels it if this works · What would winning look like | uncapped | yes |
| Something else | Who is this for · Good outcome | 4 | — |

Basics sections and the `basicsAnswered` contract stay as shipped today (v03 visual
direction per `mockups/basics-form/PLAN.md` verdict). Interview depth below each ceiling is
**complexity-driven**: the brain asks only what the description + evidence cannot answer.
A rich bug report with a screenshot gets zero questions. Ceilings are runaway-guards, never
surfaced in the UI. On the uncapped New track the Submitter ends the interview
conversationally ("that's enough") — no dedicated stop button; the chat is the control.

## Classification and the chip

- **One classify call** when the Submitter finishes describing (Continue on the composer),
  served by the same Stage 1 brain as the interview. Never live-while-typing (chip flicker
  destroys trust), never a client-side heuristic (two classifiers disagree).
- The **chip** shows type + qualitative weight: "Bug fix · quick path", "New app · full
  session". **Never minutes** — minute promises are incompatible with silent depth changes.
- **Confident guess:** the v03 type cards render pre-selected and collapsed behind the chip.
- **Low confidence:** chip renders in a "pick one" state and the type cards open — exactly
  the pre-redesign explicit choice. Same component, two states; the correction UI (tap the
  chip anytime) is that same component reopened.

## Correction and escalation

- **Answers are never destroyed, only re-scoped.** On a type change, applicable facts carry
  over (app name, attachments); inapplicable ones go dormant in the draft and return if the
  Submitter switches back. Draft PATCH semantics already accumulate fields — no new storage.
- **Depth changes are silent; type changes need consent.** The brain may ask one more or one
  fewer question without ceremony. If mid-interview it concludes the request is a different
  type ("this bug is actually a new app"), it **proposes**: chip pulses + in-chat question;
  the Submitter accepts or declines. The AI may change *how much it asks*, never *what the
  request is*, on its own.
- Escalation/demotion = swapping the track config mid-flight; the interview transcript and
  all draft facts persist across the swap.

## Review

Every track ends in Review, including the bug quick path — compact card there: "here's what
the factory understood, here's what happens next." Cheapest trust in the flow.

## Touchpoints (for the implementation plan)

- **Backend:** a classify operation on the Stage 1 brain surface (description → type +
  confidence); interview brain honors per-track ceilings, complexity-driven stop, the
  conversational stop, and the escalation *proposal* (not silent type write).
- **Frontend (`apps/intake/src/app/submitter/`):** composer Continue triggers classify;
  chip component (confident/unsure/pulse states) atop `basics-card`; type cards
  collapsed-behind-chip behavior; interview step-count honesty; compact Review variant for
  short tracks; prototype insertion unchanged (New-only, existing soft-gate skip).
- **Draft (`intake-draft.service`):** type becomes brain-written-then-user-confirmed;
  dormant-field re-scoping on type change (no deletions).
- **Out of scope:** prototype for enhancements, minute estimates, live-typing
  classification, stop button, changes to `progress_event` or Factory stages.

## Testing

- Unit: chip state machine (confident / unsure / pulse-proposal), re-scoping on type change
  (facts survive a round-trip bug→enh→bug), `basicsAnswered` unchanged per type.
- Interview contract: ceilings enforced for bug/enh/other; New uncapped; conversational
  stop ends the interview and advances the journey.
- E2E happy paths: rich bug (0 questions, straight to compact Review), thin bug (≤3
  questions), new app (full session incl. prototype), misclassification corrected via chip
  with no data loss.
