# Intake submission journey redesign — design spec

Date: 2026-07-02
Status: awaiting user review
Approach: refined four-step wizard + live "what we understood" panel (Approach 2, user-approved)

## References

- Design brief: `docs/design/intake-redesign-brief.md` (purpose, tone, six load-bearing rules)
- UX audit: `docs/reviews/2026-07-02-intake-submission-ux-audit.md` (47 confirmed findings)
- Approved mockup: `mockups/intake-submission-redesign.html`
- Code under change: `apps/intake/src/app/submitter/*`, `apps/intake/src/app/core/session.service.ts`, plus contained API changes in `api/app/` (see Backend section)

## 1. Goal

Redesign the whole submitter journey — Describe → Questions → Check → Done, plus
tracking — so a non-technical employee feels guided and understood, while the factory
collects sharper requirements. Fix all 13 high-severity audit findings as a baseline.

Success criteria (all verifiable before "done"):

1. All 13 high-severity audit findings closed.
2. The full flow completes keyboard-only.
3. Every user action has a visible error state with a recovery path (simulated API
   failure on each step).
4. The Check step shows the real draft spec with provenance and flagged assumptions.
5. Light and dark screenshots pass at 1440px and 390px.

## 2. Decisions made in the interview (fixed scope)

1. Scope: whole journey, form → confirm, plus full tracking redesign.
2. Form slims to: type + app (+ new-app name) + description + optional attachments.
   Reach, impact, and urgency move into the adaptive interview.
3. The draft spec is generated when the interview ends (backend change included) and
   shown at the Check step — provenance tags and flagged assumptions.
4. Interview gets full polish: one input surface per question, honest progress,
   skip-with-consequence, no re-asking what the form answered.
5. Confirmation copy is honest: track in "My requests"; the email promise is removed.
6. Visual language: light warm canvas, single purple accent (#BD03F7), consistent
   across all screens. Login's dark gradient is replaced with the same light language.
7. Tracking (My requests + Request detail): full redesign, plain-language statuses.
8. Done means the verifiable checklist in section 1.

## 3. Screen designs

Step labels rename to plain verbs: **Describe → Questions → Check → Done**. The shared
shell (`sub-shell.ts`) keeps the stepper; completed steps get checkmarks; forward steps
stay non-clickable (sequence is load-bearing rule 1).

### 3.1 Describe (`/submit/new`, `new-request.ts`)

- Type-first progressive disclosure stays: three selectable cards (Bug fix /
  Enhancement / New app) with one-line plain descriptions; relevant fields appear
  after selection.
- Fields per type:
  - Bug fix: app picker, "What's going wrong?" description, optional attachments.
  - Enhancement: app picker, "What should be better?" description, optional attachments.
  - New app: "What should we call it?" name, description, optional attachments.
  - Bug context fields (where seen / frequency) move to the interview, which asks
    only when useful. Reach / impact metric / impact value / urgency are removed
    from the form entirely.
- App picker: accessible combobox (ARIA combobox pattern), keyboard operable
  (arrows + Enter), filters as you type, hint text "Start typing — then pick one
  from the list." A typed-but-unpicked value produces a visible inline message on
  Continue, never a silently disabled button.
- Continue button is always enabled; pressing it with missing fields scrolls to and
  announces the first inline error (fixes disabled-button mystery + a11y finding).
- Draft autosave: form state persists to localStorage on change (debounced), keyed
  per user; restored on load with a quiet "Draft saved" indicator. Cleared on
  successful submit. Fixes refresh-loses-everything.
- Attachments: staged files that fail to upload stay visible with a retry affordance;
  navigation proceeds only when the user chooses to continue without them (explicit
  "continue without this file" action, not silent dropping).
- Save/continue failure shows: "Something went wrong saving your request — try
  again." (No claim that data is safe on first save — it is not yet on the server.)

### 3.2 Questions (`/submit/:id/interview`, `interview.ts`)

- One input surface per question: option questions render 2–4 radio-semantics
  buttons with one-line explanations and a "Type my own answer instead" swap link;
  free-text questions render only the composer. Typed text can never silently
  override a visually selected option.
- Honest progress: "Question 2 of about 4" from the API's remaining-question
  estimate; thin bar reflects the same number. No hardcoded fake values.
- Skip is per-question and always visible, with its consequence: "Skip this
  question — we'll assume ⟨assumption⟩, and you can correct that on the next step."
  The assumption text comes with the question payload (see Backend).
- Understanding panel (new component, right column ≥861px, below the question on
  mobile): "What we understood so far" — items appear as answers land, each with a
  source line ("from your description" / "from your answer · question N"); skipped
  questions appear as amber "assumed" items; remaining questions show as a single
  muted "About N more questions" row. Panel is `aria-live="polite"`.
- Answer POST failure: inline "That didn't send — try again", answer preserved in
  the input; Retry re-sends.
- Interview load failure (the audit's worst finding): dedicated card with apology,
  "Try again", and "Skip ahead to check" which routes to `/submit/:id/review`.
  The route is never a dead end (load-bearing rule 3).
- The final "anything else?" free-text is saved to the request via API (not
  history.state), so refresh and edit round-trips keep it.
- End copy: "Thanks — that's everything I need. Next, check the summary before it
  goes to a reviewer."

### 3.3 Check (`/submit/:id/review`, `review.ts`)

- Renders the real draft spec (see Backend): a short list of requirement lines,
  each with a provenance chip — "your request" (gray) or "your answer · Q⟨n⟩"
  (purple). Assumption lines render on an amber tint with "assumed — nobody said
  this" and two actions: "That's right" (confirms, becomes a normal line) and
  "Not quite — fix it" (inline text field replaces the line's content, recorded as
  a submitter correction).
- Header shows type + app with an "Edit description" link back to Describe that
  reuses the same request (no duplicate creation — see Backend idempotency).
- Attachments uploaded earlier are listed.
- "Anything to add?" optional input persists to the request as the user types
  (debounced PATCH), replacing history.state.
- Submit: "Send to a reviewer" with honesty note "A person reviews this before
  anything gets built." Failure shows "Something went wrong sending your request —
  nothing was lost. Please try again." (True here: the request row already exists.)

### 3.4 Done (`/submit/:id/done`, `confirm.ts`)

- Calm confirmation: request reference, "A person will review it next — usually
  within two working days", buttons View my requests / Start another request.
- No email promise anywhere.
- "Start another request" clears the draft and creates a fresh request; it must not
  reopen or PATCH the previous one.

### 3.5 Login (`/login`, `login.ts`)

- Restyled to the light warm language (replaces dark gradient).
- "Contact IT" becomes a real link (mailto or the org's support URL — implementer
  picks whichever the org standard is; a mailto to the existing support alias is
  acceptable). No dead spans.

### 3.6 Tracking (`/requests`, `my-requests.ts`; `/requests/:id`, `request-detail.ts`)

- My requests: calm list, most recent first. Status pills in plain language only:
  - Waiting for review (submitted, not yet approved)
  - Needs your answer (send-back)
  - Being built (approved through deploy in progress)
  - Ready to use (deployed/done)
  - Not going ahead (rejected/cancelled — with a gentle explanation on detail)
- Exactly one "needs your answer" band at the top when ≥1 request needs input,
  with the count and a single "Answer now" action (first such request).
- Request detail: milestone story — Sent → Understood → Approved → Being built →
  Ready to use — with dates, a one-sentence plain status line, the original ask,
  and a "See what we understood" section showing the confirmed spec. Send-back
  replies get a labeled input (not placeholder-only). No logs, PRs, or internal
  vocabulary (load-bearing rule 5). Internal statuses map to the five labels above
  in one shared mapping function used by both tracking screens.

## 4. Visual system

- Light warm near-white canvas, white cards, one purple accent `#BD03F7` used only
  for primary actions, active states, and "your answer" provenance. Amber reserved
  for assumptions/needs-input; green for done/confirmed; red for errors.
- Micron Basis for UI text (fallback Inter/system); JetBrains Mono only for request
  refs (REQ-142) and file sizes.
- Body text ≥16px everywhere, including hints and helper copy (audit found 12–13.5px
  guidance). Secondary text may be 14px minimum, never below.
- Interactive targets ≥44px tall. Generous spacing; one h1 per screen at a
  consistent size (28px) across the flow.
- Dark mode: the intake shell already has a theme toggle; every new surface and
  color must pass in both themes (verified by screenshots).

## 5. Backend changes (contained)

All changes live in `api/app/`; the progress_event log stays append-only (ADR 0008)
and nothing here scales workers or touches the tick loop.

1. **Draft spec at interview end.** When the interview completes (or on first GET of
   the review endpoint if no spec exists — covers skipped interviews),
   `get_brain().draft_spec(r)` runs and the spec lines persist on the request.
   The existing after-submit drafting is removed/reused so the spec is drafted
   exactly once and confirmed at submit.
2. **Expose spec lines to intake.** Review endpoint returns spec lines with `prov`
   and `assume` (already in `SpecLineOut`).
3. **Assumption actions.** Endpoint to confirm or correct a spec line pre-submit
   (submitter-scope, own requests only). Corrections mark the line as
   submitter-corrected so reviewers see provenance.
4. **Interview context.** The brain's context includes all form fields (type, app,
   description) so questions never re-ask them, and the question payload gains:
   `skip_assumption` (plain-language consequence text) and an honest
   `remaining_estimate`.
5. **Interview carries reach/impact/urgency.** The scripted fallback brain gets
   neutral, non-leading questions for reach and urgency (replacing the leading
   volume/export presumption); the adaptive brain is prompted to cover them when
   relevant. Answers ground spec lines with question context so "A handful." never
   appears context-free — spec lines phrase the meaning, not the raw option label.
6. **Idempotent edit path.** Returning to Describe from Check edits the same
   request (id in route); "New request" from the shell never reopens an abandoned
   request — it always starts clean.
7. **Extra details field.** Persist the review page's "anything to add" text on the
   request via PATCH.

Out of scope: email/notification infrastructure (decision 5), pipeline changes,
admin console.

## 6. Accessibility requirements

- App picker: ARIA combobox pattern, fully keyboard operable.
- Interview options: radiogroup semantics with visible + programmatic selected state.
- Progress: `role="progressbar"` with value text matching "Question N of about M".
- Understanding panel and chat updates: `aria-live="polite"`.
- All inputs labeled (visible label or aria-label) — no placeholder-only labels.
- Focus moves to the new question/step heading on transition.
- Full flow passes a keyboard-only run; visible focus states throughout.

## 7. Error-handling principles (every screen)

- No silent failures: every subscribe error handler renders copy + a retry.
- Error copy pattern: what happened, whether data is safe (only when true), what to
  do next. Plain, unalarming tone.
- The interview can always be exited forward ("Skip ahead to check").
- Draft autosave means refresh never loses form work; server persistence means
  refresh after Describe never duplicates requests.

## 8. Testing & verification

- Unit: draft autosave restore, status mapping function, spec-line
  confirm/correct state, combobox keyboard interaction, interview input-surface
  switching.
- API: spec drafted exactly once per request; review endpoint returns lines;
  assumption endpoints enforce owner scope; interview context includes form fields.
- Manual/scripted verification per success criteria: keyboard-only run, simulated
  API failures per step (interview load, answer POST, save, submit), light/dark
  screenshots at 1440px and 390px on all six screens.
- `make verify` green before merge.

## 9. Open items deliberately deferred

- Real email/notification system (needs its own design + ADR).
- Analytics instrumentation (time-to-submit, completion rates) — revisit after ship.
