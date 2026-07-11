# PROTOTYPE — Basics form revamp (10 directions)

> **Throwaway.** Answers one question: *what should the intake basics step look like
> so it guides users visually, never overwhelms, and asks the right questions?*
> When a direction wins, fold it into `apps/intake/src/app/submitter/basics-card.ts`
> (rewritten properly) and delete this folder.

**Live target being revamped:** the BASICS card on the interview intro
(`/submit/:id/interview`, phase `intro`): heading "A few details will help us get
this right.", card "Tell us who this is for", rows Request-type / Who-will-use-it /
Expected-benefit, then a **Submit/Start interview** button. An AI interview follows,
so the basics only need the *minimum structured facts* — everything else can be
deferred to the interview.

**View at:** `http://localhost:4456/basics-form/` (launch config `mockup` serves
`mockups/` on 4456). `index.html` hosts variants in an iframe with a floating
switcher (← / label / →, arrow keys, `?v=` param). Each `vNN-*.html` also opens
standalone.

---

## Critique of the current form (why we're here)

1. **Everything at once** — 3 rows, ~15 interactive elements (4+6+3 pills, 2 free
   inputs) visible simultaneously. No focus, no order, no momentum.
2. **The hardest question is asked coldest** — "Expected benefit: enter estimate +
   pick unit". Nobody can estimate "hours saved / year" on the spot; it invites
   made-up numbers or abandonment.
3. **Zero visual differentiation** — every choice is an identical small pill;
   no icons, no examples, no "why we ask".
4. **Mixed axes** — "Who will use it?" mixes org size (me/team/dept) with
   geography (one site/across sites) in one pill row.
5. **Cryptic progress** — "0 of 2" counter (which doesn't even match the 3 visible
   rows) is the only feedback; answers produce no visible payoff.

## Shared question bank (variants pick/rephrase from this)

- **Type** (routing, keep): Fix a problem / Improve an app / Build a new app /
  Something else — but give each an icon + one-line example.
- **Audience** (better): size bands with people anchors — "Just me (1)" /
  "My team (2–10)" / "A department (10–50)" / "Lots of us (50+)" — plus optional
  free-text "who exactly?". Drops the site/geo axis (interview recovers it).
- **Impact** (replace the raw estimate) — three strategies, used across variants:
  a) **compute it**: how many people × how often × how long each time → live
     "≈ N hours/year" tally;
  b) **qualitative severity**: nice-to-have / real time-sink / business-critical;
  c) **success statement**: "What would success look like?" chips
     (saves time / saves money / fewer errors / makes something possible).
- **Optional extras** some variants trial: "How do you handle this today?"
  (workaround), "When do you need it?" (urgency).

---

## Shared scaffolding (every variant)

- **Standalone HTML file**, no build step, vanilla JS, all CSS inline in the file.
- **Fonts:** Space Grotesk (display+body) + JetBrains Mono via Google Fonts
  (same as app).
- **Tokens:** copy the light+dark token set from
  `mockups/intake-submission-redesign.html` (`:root` = light, `.dark` on `<html>` =
  dark; accent `#BD03F7` / dark `#D65CFF`). **Default to dark** (matches the
  screenshot being critiqued). Include the same theme toggle behaviour: a ☀/☾
  button toggling `document.documentElement.classList.toggle('dark')`.
- **Shell chrome (identical across variants — do NOT redesign it):** top bar with
  the 3×3 dots mark + "Software Factory", right side: nav pills "New request"
  (active, filled accent) + "My requests", theme toggle, small avatar "JD Jordan D.".
  Below it the page area (max-width ~760px, centered). The *page content* —
  heading copy, badge, card, everything below the top bar — is fully yours per
  variant.
- **Responsive:** must hold together at 1440 and 390 wide (pills wrap, panes stack).
- **State readout (skill rule "surface the state"):** a tiny fixed pill bottom-left
  (`font: var(--mono) 10px`, collapsed to "state" by default, click to expand)
  showing the collected answers as JSON, updated on every interaction. Visually
  neutral (grey), clearly not part of the design.
- **Submit:** each variant ends in its own idea of a primary action (default label
  "Start the interview"); clicking just flashes the state pill — no backend.
- **Prototype quality bar:** no frameworks, no error handling, but interactions the
  variant *is about* (auto-advance, live math, flips…) must actually work.
  Respect `prefers-reduced-motion` (skip the fancy transitions).

---

## The 10 variants

Structural rule: each variant must disagree with the others about **layout,
information hierarchy, or the questions themselves** — not colour. If your draft
looks like "the same card with nicer pills", start over.

### v01 — `v01-one-at-a-time.html` — Conversational stepper (Typeform-esque)
One question owns the whole stage. Big centered question text ("What kind of
request is this?"), 3–4 giant tap targets (icon + label + example line), progress
dots top-center, auto-advance with a slide/fade after pick, ← back arrow, "or press
1–4" keyboard hints. Q2 "Who's going to use it?" (size bands). Q3 "What would
success look like?" (success chips, then an optional magnitude row appears).
Final screen: summary of the 3 answers + Start the interview. Skippable: every
question has a quiet "Skip — the interview can cover this".

### v02 — `v02-madlibs.html` — Mad-libs sentence builder
The form IS one large editorial sentence (display type, ~34px):
"I want to **[build a new app]** for **[my team]** that should mainly
**[save time]** — roughly **[200 hours a year]**." Each blank is an inline chip:
dashed/empty state, accent-filled when set; click opens a small popover with the
options (last blank = tiny stepper or presets). Sentence reads back as the actual
brief. A quiet caption under it: "This becomes the first line of your request."
Start button enables once the first two blanks are filled.

### v03 — `v03-card-sort.html` — Visual card sort + blast radius
Three sections, strongly visual, all on one scrollable page but visually staged
(next section de-blurs when previous is answered).
S1: 4 big illustrated cards (inline SVG doodles, not emoji) for type, with example
line each. S2: audience as a **concentric-rings diagram** (me → team → department →
whole org), click a ring to select; a live label shows "~2–10 people". S3: impact
as 3 big cards (time-sink / money / unlocks-something). This is the "spatial,
almost no reading" direction.

### v04 — `v04-checklist-ladder.html` — Progressive disclosure ladder
A single card, but only ONE row is alive at a time. Active row is full-size with
its controls; future rows are collapsed, dimmed one-line stubs with a lock/step
number; answered rows collapse to a one-line green summary "✓ Build a new app —
tap to change". A vertical progress line on the left fills as you go. The
"0 of 2" counter becomes a human "1 question left". Zero simultaneous choices
beyond the active row. Questions: type → audience → severity (qualitative:
nice-to-have / real time-sink / business-critical).

### v05 — `v05-live-brief.html` — Split-pane live brief
Two panes. Left (~46%): compact stacked questions (type, audience, "How will we
know it worked?" free-text with suggestion chips). Right: a paper-like "REQUEST
BRIEF" document that literally writes itself as you answer — title line, "For:",
"Success:", a mono footer "Next: a 10-minute AI interview fills in the detail."
Empty fields show as pencil-grey placeholders in the doc, so the payoff of every
answer is visible. On mobile the brief docks as a collapsed bar under the form.

### v06 — `v06-chat.html` — Chat quick-replies (kill the form)
The basics ARE the first messages of the interview. Assistant bubbles arrive one
at a time (typing indicator between), each with quick-reply chips below; picking
one renders it as YOUR sent bubble and the next question arrives. One question
allows chips OR free typing in the composer at the bottom. After 3 answers the
assistant says "Great — let's dig in" and the composer becomes the real interview
input. No card, no rows, no counter — conversation is the progress.

### v07 — `v07-impact-calc.html` — The impact calculator
The hard question becomes the hero, made easy. Top: one compact row combining
type + audience (small segmented controls). Center stage: "Let's size the prize" —
three micro-questions with playful big controls: "How many people deal with this?"
(stepper 1–50+), "How often?" (daily/weekly/monthly chips), "How long each time?"
(15m/1h/half a day chips). A live tally — big animated number + growing bar —
computes "≈ 520 hours a year back". Under it, quiet mono: "rough is fine — we
just need the order of magnitude." This variant answers: *can we compute the
estimate instead of asking for it?*

### v08 — `v08-two-questions.html` — Radical minimal (two questions, giant)
Push back on the form itself. Exactly two questions, everything else explicitly
deferred: (1) "What is it?" — 4 huge segmented tiles across the full width.
(2) "How big a deal is it?" — a single **3×3 grid picker**: x-axis "a few people →
a department → the whole company", y-axis "annoying → painful → business-critical";
click a cell, cells have human micro-labels ("classic time-sink", "all hands
problem"…). Then a fat Start button and the line "That's it. The interview covers
the rest." Tests the floor of how little we can ask.

### v09 — `v09-guided-focus.html` — Annotated spotlight
Keep the single 3-row card structure, but make *guidance* the design: only the
active row is in full contrast — others blur/dim (focus follows answered state);
in the right margin, an annotation card connected by a thin line explains WHY we
ask ("This decides who reviews it and how fast") + a concrete example answer;
each input has an example placeholder ("e.g. the 6 people on quality who file
these reports"). Progress is a sentence up top: "2 quick facts, then the
interview." The conservative-but-polished direction.

### v10 — `v10-ticket.html` — Fill the ticket (form-as-artifact)
Show the thing being created: a physical **work-order ticket** (boarding-pass /
job-ticket aesthetic: perforated edge, mono stamps, barcode strip) with three
empty printed fields: REQUEST TYPE, COMMISSIONED FOR, EXPECTED PAYOFF. Tapping a
blank field opens the picker in a tray beside/below the ticket; the chosen value
gets **stamped** onto the ticket (quick rotate+settle animation, ink texture).
When all fields are stamped, a tear-off "→ START INTERVIEW" stub activates.
Completely different metaphor: you're not filling a form, you're cutting a ticket.

---

## Switcher harness — `index.html`

- Loads `vNN-*.html` in a full-viewport iframe. `?v=1..10`, default 1.
- Floating pill bottom-center (high-contrast, obviously not part of the designs):
  `←` · `3 / 10 — Card sort & blast radius` · `→`. Wraps around.
- Keyboard ← / → in the parent; also forward keydowns from the iframe (same
  origin) so arrows work while it has focus. Never intercept when an
  input/textarea/contenteditable is focused.
- Updates the URL param via `history.replaceState` (shareable, reload-stable).
- No production concern — mockups/ is never shipped.

## Execution protocol (builders: opus-4.8; verify: sonnet-5)

- 10 parallel opus-4.8 agents, one per variant file — each gets: this file's
  Shared-scaffolding + Critique + Question-bank sections, its own variant spec,
  and the token block from `mockups/intake-submission-redesign.html`. Writes ONE
  file, self-reviews the HTML mentally for obvious breakage, returns the path.
- 1 sonnet-5 verifier afterwards: opens each variant at 1440 & 390, dark & light,
  clicks through the core interaction, fixes trivial breakage in place, reports
  anything structural.
- Fable (main agent) does the final taste pass with screenshots for the user.
- **Known risk:** Claude subagents hit a monthly spend cap earlier this month.
  Fallback per user memory: rerun failed variants through codex gpt-5.5
  (`codex exec`) with the same self-contained spec.

## Deviations

- 2026-07-11: The sonnet-5 verifier agent died mid-run on the Claude monthly spend
  cap (after harness/v01/v02). Fable finished verification in the main loop
  instead of the codex fallback, since it overlapped with the planned taste pass.
- 2026-07-11: The :4456 mockup server was found dead after the parallel builds;
  restarted via the `mockup` launch config.
- v08 fix: tile label/description spans ran together inline → `display:block`.
- Harness fix: arrow-key forwarding now calls `stopPropagation()` so variant-
  internal arrow shortcuts (v01 back-nav) can't double-fire with variant cycling.
- Harness fix: iframe loads are cache-busted (`?t=`) — the browser served stale
  variant files during iteration.

### Fold-in deviations (2026-07-11, v03 → basics-card.ts)

- Impact cards alone can't satisfy `basicsAnswered` (needs metric + value), so
  picking a card reveals a small estimate field ("Roughly how many hours a
  year?") under the grid — the mockup had cards only.
- Ring→reach mapping: me/team/dept/**wider**; the outer "The whole org · 50+"
  ring saves as `wider`. Legacy `site`/`network` drafts render as the outer
  ring but are never written back unless re-picked.
- bug/enh shapes got the same staged-section language: app combobox panel,
  evidence panel, frequency mini-cards (not in the mockup, adapted).
- Pre-existing bug fixed in passing: interview.ts `thread` was
  `viewChild.required` but `#thread` only exists after the intro phase —
  NG0951 fired whenever the background question landed while the submitter
  was still on the basics. Now optional + guarded (same pattern as planPanel).
- Pre-existing shell overflow at 390px (top-bar identity chip) fixed in
  sub-shell.ts: chip hides under 560px.

## Verdict

**Winner: v03 — Card sort + blast radius** (user, 2026-07-11: "use 3").
Next step: fold into `apps/intake/src/app/submitter/basics-card.ts` — illustrated
type cards, concentric-rings audience picker, impact cards; adapt the bug/enh
shapes (app picker, evidence, frequency) to the same visual language. Keep the
IntakeDraft PATCH semantics and `basicsAnswered` contract unchanged. Delete this
folder once the real implementation ships.
