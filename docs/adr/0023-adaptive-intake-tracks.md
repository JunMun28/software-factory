# Intake classifies the Request type instead of asking, and shapes the journey per Track

**Status:** accepted

The Intake form stops asking the Submitter to pick a Request type up front. Instead the
Submitter just describes the request; the Stage 1 brain classifies it **once, when they
finish describing**, and the journey is assembled as a **Track** — one universal skeleton
(Describe → classify → Basics → adaptive interview → Review → Submit; the New track inserts
Prototype) configured per type. The guess is shown as a **visible, correctable chip**
("Bug fix · quick path" — qualitative weight, never minutes); low confidence degrades to the
explicit type cards, which are also the chip's correction UI.

Two invariants make the adaptivity trustworthy:

1. **Answers are never destroyed, only re-scoped.** Correcting the type (or an escalation)
   carries applicable facts over and leaves the rest dormant in the draft — switching back
   restores them. No re-asking.
2. **The AI may change how much it asks, never what the request is, without consent.**
   Interview depth is complexity-driven and adjusts silently (ceilings: bug 3, improvement 4,
   something else 4, new app uncapped — the Submitter can end it conversationally); a type
   change mid-interview is *proposed* via the chip and accepted or declined by the Submitter.

## Why recorded

- **Hard to reverse** — the composer-first, classify-later shape drives the UI, the draft
  PATCH semantics, and a new classify call on the Stage 1 brain; going back to type-first is
  a flow restructure.
- **Surprising without context** — a reader will wonder why there is no type question at the
  start of an intake form, and why the type cards still exist but render collapsed.
- **Real trade-off** — rejected alternatives: type-first (forces a taxonomy decision before
  the user has articulated the request), silent pure inference (breaks trust on the first
  misclassification), and escalate-only-from-shortest (bait-and-switch mid-flow). Chosen:
  visible correctable inference + consent-gated escalation.

The **Track** is Intake-app vocabulary only (see CONTEXT.md) — the Factory consumes the
Request type, never the Track. Prototype remains New-track-only: mocking an existing app the
brain has never seen invents fantasy UI that anchors the spec wrongly.
