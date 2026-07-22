# Overview — futuristic prototype

**Question:** the console Overview shipped as a restrained Linear/Vercel surface
(commit `aab3c08`). Should it instead be futuristic — and if so, in what shape?

Run the `mockup` server on :4456.

| File | What it is |
|---|---|
| `index.html` | Wave 1 — 3 variants, `?variant=A..C` |
| `wave-2.html` | Wave 2 — 10 structures in the Micron language, `?variant=A..J` |
| `wave-3.html` | **Wave 3 — A kept, 10 compositions of it, `?variant=1..10`** (current) |

Switch with the bottom bar, `←`/`→`, or the URL. Data is real: 28 live requests
pulled from the running API into `data.js` (19 gates, 4 waiting, 1 stalled,
4 shipped). Stage indices match the console's `DISPLAY_STAGES` projection.

## Wave 2 — one visual language, ten structures

Wave 1 and an abandoned intermediate pass both drifted off-brand. Wave 2 is the
corrected brief: **futuristic and tech-savvy, in Micron, consistent with the
intake app.** Everything below shares one system, so the choice is about
*structure and information design*, not about palette.

Tokens are canonical, from `jm-design/.../micron-tokens.css`:

- `#bd03f7` **Purple A is the only accent.**
- `#32c8ff` cyan is reserved for **data / input movement** — which is exactly what
  a pipeline is, so here it carries flow and nothing else.
- Semiotic green / gold / red carry **status only** (shipped / gate / stalled),
  lifted slightly for legibility on black.
- Near-blacks are biased toward purple (`#08060c`, `#100c18`, `#181222`) rather
  than neutral grey — chosen, not inherited.
- Type: **real Archivo** (loaded from the sibling `hero-ascii-bg` mockup,
  verified loading — not the Plus Jakarta fallback) + JetBrains Mono for data.
  Scale is the Micron 1.333 perfect fourth: 11 / 14 / 19 / 25 / 34 / 45 / 60.
- The **ignition glyph field** from the intake hero is carried across as ambient
  depth on every variant — same glyph tiers, same glow rising from the bottom.

| | Name | Structure |
|---|---|---|
| A | Ignition | Intake's hero grammar in the console: thesis headline, gauge row, stage rail |
| B | Reactor | Concentric rings; each arc is that stage's share of the line, core = what needs you |
| C | Trace | Oscilloscope, one channel per stage; each pulse a request, height = time waiting |
| D | Board | The line as a printed circuit — stage pads wired in series, requests as vias |
| E | Flux | Requests as particles in six lanes; only moving work actually moves |
| F | Deck | Dense 12-column telemetry panels |
| G | Matrix | One cell per request, purple intensity = time waiting |
| H | Graph | Nodes by stage on the x axis, edges back to origin |
| I | Column | Vertical ascent stack + live telemetry roll |
| J | Spectrum | Stage load as an analyser with cyan peak-hold |

## Wave 3 — A kept, ten compositions of it (`wave-3.html`, `?variant=1..10`)

Variant A (Ignition) won the direction. Wave 3 keeps it and varies **how the
four figures are stated** — the gauge row is the axis, the layout follows.

Constant across all ten: the ignition glyph field, real Archivo, the
canonical tokens, and the thesis headline. The six-stage rail is shared by seven
of them; A3, A9 and A10 deliberately replace it (with an oldest-first list, a
pure quadrant, and chip lanes respectively). Nothing else is shared, so each
composition is free to rebuild the page around its gauge idea.

| | Name | The gauge move | |
|---|---|---|---|
| A1 | Ledger | Figures on one rule, no boxes at all — the quietest reading | **kept** |
| A2 | Marquee | One figure owns the page; the other three become footnotes | **kept** |
| A6 | Distribution | Each figure carries a real age distribution beneath it, unboxed | **kept** |
| A7 | Sentence | The numbers live inside a display sentence, editorial | **kept** |
| A3 | Split | Thesis + stacked figures left, the line oldest-first right | cut |
| A4 | Proportion | The four figures ARE one bar — shares of the total | cut |
| A5 | Readout | Mono key/value status block with qualifiers | cut |
| A8 | Rail | Figures pinned to a fixed vertical edge | cut |
| A9 | Quadrant | Four equal fields, no hierarchy between them | cut |
| A10 | Strip | Thin ticker; the line itself becomes the page body | cut |

**Culled to four (A1, A2, A6, A7).** The six cut compositions and their CSS are
deleted from `wave-3.html`, not just hidden — along with two symbols that only
they used (`waits`, fed A4's bar; `WORD`, fed A3's row labels). Original numbers
are kept rather than renumbering, so every reference in these notes still
resolves. A stale `?variant=` pointing at a cut composition falls back to A1
(verified with `?variant=9`).

**Brand corrected:** the masthead now uses the real AIRES lockup (the shipped
`sf-mark` geometry + hairline rule + wide-tracked 300-weight caps) rather than
the stale "Software Factory" wordmark, matching the console shell and intake.

### Honest notes
- **A5 and A6 are the only two that add information**, rather than restyling the
  same four numbers. A5's qualifiers ("oldest 5w", "automation stopped") and A6's
  age histograms both answer the obvious follow-up question in place.
- **A6's distributions are real** — six buckets of actual age data, not an
  invented trend line. A sparkline would have had to be fabricated; this did not.
  Drawn as an area with a line on top (was bars). **Straight segments between
  buckets, not a spline** — the data is six discrete bins and a smoothed curve
  would invent shape between them. The peak bucket carries a dot so the shape has
  an anchor. An empty set (live "Being built" = 0) collapses to a flat baseline
  with no peak dot, which is the honest picture of "none of these exist" rather
  than a hidden or broken chart. `preserveAspectRatio="none"` fills the card, so
  the stroke uses `non-scaling-stroke` to stop it thickening horizontally.
- **A6 lost its card box.** It was a bordered grid with 1px gaps showing through
  as dividers. The border and the per-card fill are gone; the figures now sit
  straight on the page and a 30px gap does the separating. Same move the shipped
  console made (boxes become hairlines), and it keeps A6 visually distinct from
  A1, which separates its figures with vertical rules.

- **A9 is the weakest.** Four equal quadrants give the stalled request the same
  weight as the shipped count, which is exactly the hierarchy the console spent
  this whole session removing.
- **A2 is the most honest to the finding** — one number does dominate the
  factory right now — but it degrades badly on a healthy day when that number
  is 0 or 1.
- **A10 shows all 28 titles at once**, which is genuinely useful and also the
  densest. Worth testing at 60+ requests before trusting it.

### The stage rail now states its status mix

The rail listed six titles per stage with a coloured dot each. Against the real
data that hid the most important thing on the page: **Spec holds 15 gate, 4
submitter and 1 stalled**, but the first six in data order were all gates, so it
rendered as six identical gold dots and the stalled request was invisible.

Three changes, all in the shared `RAIL()` so every composition gets them:

1. **A status-mix bar + key per stage** — a 1:15:4 segmented rule and the words
   "1 stalled · 15 gate · 4 submitter", so the spread is stated even when the
   list truncates. Verified the segments render proportionally (10.7 / 159.8 /
   42.6 px).
2. **Urgency ordering** (stalled → gate → human → submitter → working → shipped,
   then oldest first) so a truncated list surfaces the variety instead of the
   first six of whatever dominates. The stalled request now leads Spec.
3. **The status word on every row**, not just a dot — verified readable in
   greyscale, so the encoding does not depend on colour.

Empty stages read "standby" with a neutral rule; a `+N more` line now states
what the truncation hid instead of silently dropping it.

**The mix bar replaced the accent rule.** Each stage previously had a 2px purple
`border-top` above it. Once the mix bar existed that was a second horizontal
stroke carrying nothing — and it spent the reserved brand accent on decoration
directly above a bar that encodes real data. The purple is gone; the mix bar now
sits where it was and does both jobs.

**The counts under each stage were cut entirely.** They went text key → column
chart → gone. Both intermediate versions were a third encoding of what the page
already said twice: the stacked rule shows the proportion, and the rows beneath
name each request's status in words. A stage now reads: coloured rule, count and
name, then the requests. Nothing else.

What that costs, stated plainly: the per-status **counts** are no longer on
screen — you can see Spec is mostly amber, but not that it is exactly
15 gate / 4 submitter / 1 stalled. Two things soften it. The urgency sort puts
the rarest and most urgent statuses first, so the single stalled request still
leads the list rather than hiding behind fifteen gates; and the full breakdown
moved onto the rule's `title`, so a hover still gives the exact numbers.
If those counts turn out to be load-bearing, the honest place for them is one
line of text, not a chart.

**Why the old text key wrapped to two lines.** Three labelled counts need ~169px; a rail
column is ~217px at 1440 but only ~130px at 1100, so "4 submitter" fell to a
second line. Shrinking the type alone could not fix it — at 1100 three labelled
counts genuinely do not fit. It now degrades instead: above 1330px it reads
"1 stalled · 15 gate · 4 submitter", below that the words drop and the
colour-linked counts carry it on one line, with the full phrase kept on the
element's `title`. Verified single-line for every stage across all seven
rail-using compositions at both 1100 and 1500.

### A fifth figure: "Being built"

The gauge row was four figures; it is now five, across all four compositions:

**Awaiting your review · Stalled · Being built · Open requests · Shipped this week**

"Open requests" was carrying two jobs badly — it is *everything not shipped*
(27 = 11 working + 9 gate + 1 stalled + 6 submitter), so it said nothing about
whether the factory was actually moving. "Being built" states that directly, and
is the one figure that reads **0** on the live data — which is the single most
useful fact about the current state.

**Cyan moved with it.** Per the Micron tokens cyan is reserved for *data /
input movement*; "Open requests" is a static total and should never have worn
it. Cyan now marks "Being built" (real movement) and Open requests is neutral.
Colour now maps: amber = your gate, red = stalled, cyan = moving, neutral =
totals.

A7's prose was rewritten with it, and two latent bugs went with the rewrite:
it hardcoded **"0 agents running"** (false the moment anything runs) and a
singular **"1 has stalled"** (wrong for any other count). Both now derive.
Zero reads "Nothing is being built", not "0 are being built" — A7's whole
premise is plain words.

### "Awaiting your decision" → "Awaiting your review", and A2's headline

Renamed across all four compositions, not just the one it was raised on —
otherwise the same number carries two names.

**A2 (Marquee) now leads with the operator's whole workload**, not just the
gates: `gates + stalled`. Both demand the same thing — you — so the figure that
"owns the page" in a one-number composition should be the total, not one part of
it. The "awaiting your review" label moved down into the breakdown row, where it
now sits beside stalled / open / shipped.

The first two items in that row sum to the headline (9 + 1 = 10 on the demo set,
19 + 1 = 20 on live), which makes the relationship legible instead of leaving
four unrelated figures.

**The headline figure is Purple A (`#bd03f7`), not a status colour.** It sums
two statuses, so amber or red would claim all ten are one or the other. Purple
carries no status meaning in this system, so it emphasises without asserting —
and it is the brand's single accent, spent once, on the largest element on the
page. Measured 4.52:1 on black, past the 3:1 large-text floor (and past 4.5:1
for normal text), so the canonical token needed no brightening. The row
underneath still carries the amber/red/cyan split.

### "On the line" → "Open requests"

Factory-metaphor jargon that never said what the number counted — and the same
overloaded word the Line view was renamed away from.

The obvious alternatives are all **false**. On the live set that 24 is
19 gate + 1 stalled + 4 submitter + **0 working**: nothing is progressing.
"In progress", "In flight" and "Active" would each claim motion that does not
exist. "Open requests" says only what is true — not finished — and pairs
against "Shipped this week".

Two bits of sub-copy made the same false claim and were fixed with it: A5's
"in flight across N stages" → "spread across N stages", and A9's "In flight
right now" → "Everything not yet shipped".

Also worth stating: the first two gauges are **subsets** of this one
(19 + 1 are part of the 24), which "Open requests" makes readable and "On the
line" did not.

### "Needs a human" → "Error"

Went "Needs a human" → "Stalled" → **"Error"** (user's call, 2026-07-22).
Applied everywhere the state appears: the gauge in all four compositions, the
status word on every rail row, and A7's prose ("1 has errored").

**Known imprecision, accepted deliberately.** `needs_human` has two causes:

1. Technical failure — `_escalate()` from a crashed stage, a spawn or capture
   failure, a timeout, persistent gate infra, an orphaned run. Genuinely errors,
   and the only kind present in the live data ("Spec generation failed 3×").
2. **A human rejecting a gate.** `_reject_gate_effects` sets the same flag with a
   reason like "Architecture gate rejected (scope): …". The dossier for REQ-2136
   shows it: *"Architecture rejected by Jun Mun Wong — refining the plan."*
   Nothing failed there; a person decided no.

Case 2 will read as "Error" when it is a deliberate decision. The
`needs_human_reason` text still states which it was, so the detail is not lost,
but the label overstates it. If that becomes a problem the fix is not renaming
again — it is giving gate rejections their own kind, separate from escalations.


### Done merged into Deploy — five stages, not six

The rail carried a sixth **Done** column. That was my divergence, not the
product's: the console's `DISPLAY_STAGES` is **five** (Spec, Arch, Build,
Review, Deploy) and `done` is index 5, explicitly "shipped, not a lane".
Merging it back is a correction, and it agrees with the design language already
in use here — **shipped is a status, not a stage.** A request that has deployed
is still in Deploy; it has simply finished.

Both datasets still index shipped as 5; `laneOf()` folds it into Deploy (4) on
read, so neither data file needed editing. Deploy now carries gate + working +
shipped together, which is the clearest demonstration of the status axis in the
whole rail — its mix bar reads 1 gate / 2 working / 6 shipped. Shipped sorts
last within the lane, so live work stays on top.

Knock-on fix: the word-dropping breakpoint was tuned for six columns. Five
columns are wider — a column is `(vw - 124) / 5`, so the labelled counts fit
down to ~1000px instead of 1330px. Breakpoint re-tuned and re-verified for both
datasets across every rail-using composition at 983px and 1200px.

### A6 heading studies (`?head=1..5`, HEAD pill)

The original head read *"9 requests are waiting on a person"* over *"Each figure
carries how long its requests have been sitting"* — narrative rather than
operational, and it anthropomorphised the queue. Five rewrites in a more
professional register, all deriving from the data so none can go stale:

| | Name | Reads |
|---|---|---|
| 1 | Operational | PIPELINE STATUS · "9 requests need review, 1 has an error." — states both things a person must act on |
| 2 | Summary | No eyebrow. "9 of 33 requests are held pending review." + an inline metric line |
| 3 | Directive | ACTION REQUIRED · "10 requests need an operator decision." + "No stage advances until these are cleared. The oldest has been held 4d." |
| 4 | Metric-led | TIME IN STAGE · "Request distribution by status and age." — names the measure, not the alarm |
| 5 | Minimal | "Pipeline" as a label + one mono meta line; the figures carry the page |

**Head 1 names both actionable states**, not just the gates. It is assembled
clause by clause because every count can be 0, 1 or many, and a derived headline
must not emit "0 have errors" or a dangling comma. All seven branches were
exercised against synthetic counts:

| gates, errors | reads |
|---|---|
| 9, 1 | "9 requests need review, 1 has an error." |
| 1, 1 | "1 request needs review, 1 has an error." |
| 5, 3 | "5 requests need review, 3 have errors." |
| 0, 1 | "1 request has an error." |
| 0, 2 | "2 requests have errors." |
| 3, 0 | "3 requests need review." |
| 0, 0 | "Nothing is waiting on you." |

The 0-gate cases needed their own phrasing: the noun lives in the first clause,
so "1 has an error." had no subject when the error clause stood alone.

Notes on the set:

- **3 is the only one that states a consequence** ("no stage advances until
  these are cleared"), and the only one whose figure is the *actionable* total
  (gates + errors = 10) rather than gates alone. It is also the pushiest.
- **4 is the only one that describes what the reader is looking at.** The others
  announce a state; the page underneath is a distribution, and 4 is the only head
  that says so — which matters because the distributions are A6's whole reason
  for winning.
- **2 puts the counts twice** — inline in the metric line and again in the
  figures below. Reads well but is the most redundant.
- 1 and 5 are the safest; 5 degrades best on a quiet day, since it makes no
  claim that can look silly when every number is 0.

Verified all five against both datasets: copy derives correctly (live shows
19/28 and 5w, demo 9/33 and 2w), no broken interpolation, no horizontal scroll,
and the HEAD pill correctly disables on A1/A2/A7.

### A6 separation studies (`?sep=1..5`, SEP pill in the switcher)

**The diagnosis first.** A6's two halves were both five-wide rows stacked on top
of each other, so "Awaiting your review" sat directly above "Spec" — implying a
column relationship that does not exist. One row is *statuses*, the other is
*stages*. That false echo, not the gap size, is why the halves blurred.

Five ways to break it, cycled with the SEP pill (enabled on A6 only):

| | Name | The move |
|---|---|---|
| 1 | Labelled rule | A named divider, "The line, stage by stage", states the change of subject |
| 2 | Ground shift | The stage half sits full-bleed on its own surface (`--p1`) |
| 3 | Break the echo | Stages stop being five columns — one full-width row each, so the alignment cannot happen |
| 4 | Scale + air | A real section heading at `--t3` and a 92px gap; summary vs detail |
| 5 | Split axis | Figures stack down the left, stages take the right — two axes, not two rows |

**Chosen: 4, scale + air.** 3 and 5 were the only two that removed the cause
rather than dressing the seam, but both cost more than the fix was worth — 3
gives up the scannable stage grid, 5 makes the page long. 4 was taken knowing it
treats the symptom; the section heading, not the gap, is what carries it.

The other four studies and the SEP pill are **deleted** from `wave-3.html`, not
left switched off — along with `RAIL_ROWS()` (study 3 only) and the `.s1`–`.s5`
CSS.

Verified all five against both datasets: no broken copy, no horizontal scroll,
figures and stage list present in every combination, and the SEP pill correctly
disables on A1/A2/A7.

### Two datasets — every stage populated

The live 28 are a **degenerate distribution**: 20 of them sit in Spec, three
stages are empty, and **not one request is `active`** — so the cyan working
state and the whole flow idea never rendered in any composition, in any wave.
A design cannot be judged against that.

`data-full.js` adds a synthetic 33-request pipeline that fills all six stages
(7/5/8/4/3/6) and exercises all five statuses. It is **never presented as
live**: the switcher carries a pill reading `demo 33` (purple) or `live 28`
(green), and `?data=live|full` is mirrored to the URL. Toggle with the pill.

The copy adapts rather than lying: the lede reads "11 are being built right now"
on the full set and "Nothing is being built right now" on the live one, and A4's
headline moves between "Most of the line is parked at a gate" and "More is
moving than is waiting".

### Bugs found and fixed
- **A4's proportion bar omitted an entire status.** It drew gate/submitter/
  stalled/shipped only, so with the full set it summed to 22 of 33 — a bar whose
  whole claim is "where the N sit" was silently dropping 11 working requests.
  Invisible against the live data precisely because that set has no `active`
  requests. Now sums to the dataset total; asserted for both sets (28 and 33).
- A7's measure was set as `24ch` on the wrapper, but `ch` resolved against the
  wrapper's inherited 14px rather than the child's 58px display size — the line
  collapsed to two words. The measure now lives on the element that carries the
  display size.
- A4's 1-of-28 stalled segment was too narrow to hold its caption and clipped it
  to "S". Segments below ~9% share now go bare and let the legend name them.

## Verdict

**A6 "Distribution", with the "scale + air" separation. Decided 2026-07-22.**

The page is: thesis headline → five figures, each carrying a real age
distribution → a named section heading, "The line, stage by stage" → the
five-stage rail.

Why this one, over the nine other compositions:

- **It is the only survivor that adds information rather than restyling the same
  numbers.** Every composition stated 5 figures; A6 also says *how long each
  group has been sitting*, which is the question a reader asks next and which
  nothing else on the page answers.
- **The distributions are measured, not decorative** — six real age buckets. No
  other composition had a second data dimension to show.
- It degrades honestly: on the live data "Being built" reads 0 with a flat
  baseline, which is the single most useful fact about the current factory.

Why "scale + air" for the separation: a named section heading plus a 92px gap.
Of the five studies only 3 (break the echo) and 5 (split axis) removed the
underlying column echo, but both cost more — 3 gives up the scannable stage
grid, 5 stacks the figures vertically and makes the page long. **4 was chosen
knowing it treats the symptom**: the heading is what does the work, because it
names the second half as a different subject, and the gap alone was not enough.

### Fold-in, when this goes to the real console
The prototype was written under prototype rules — no tests, inline styles,
hand-written demo data. Rewrite rather than lift. Carry over: the five-figure
set with "Being built", the status vocabulary (awaiting your review / stalled /
being built / open requests / shipped), the area distributions, the named
section heading, and the Micron token discipline (Purple A once, cyan for
movement only). Both light and dark are needed — everything here is dark-only.

## Honest notes

- **C, H and J read the data hardest.** Each states the same finding —
  everything is stuck at Spec — and the visual *proves* the headline rather than
  decorating it. H is the sharpest: "twenty of twenty-eight never left the first
  column" is literally the picture.
- **E is honest to a fault.** Nothing is running, so almost nothing moves. That
  is a true statement about the factory, but it makes a motion concept look
  broken. It only earns its keep once agents are actually working.
- **G overspends the accent.** Twenty-eight saturated purple cells turns the one
  reserved brand colour into wallpaper. Against the Micron rule it is the
  weakest of the ten.
- **D is thin.** The circuit metaphor is legible but carries less information per
  pixel than anything else here.
- **Everything is dark.** Micron's base is black and the reference was a dark
  cockpit, so that is deliberate — but the shipped console supports light and
  dark, and none of these has a light counterpart yet. That is real work if one
  of them wins.

## Bugs found and fixed while building

- `#v-K { display: grid }` (specificity 1-0-0) beat `.view { display: none }`
  (0-1-0), so that panel never hid and rendered on top of its neighbour. Display
  now lives on the `.on` state. Classic ID-vs-class cascade collision.
- The Flux canvas measured `0×0` because its container is `display:none` at load;
  it now re-fits when the variant is shown.
- A temporal-dead-zone reference (`fit()` reading `b` while initialising `let b =
  fit()`) threw and killed the whole script — every variant rendered blank.
- The Spectrum count label sat outside the analyser on the tallest bar.
