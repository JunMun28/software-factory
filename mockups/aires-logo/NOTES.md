# AIRES mark — prototype notes

**Question:** the intake app was renamed from "Stream" to **AIRES** (Automated
Intelligent Request and Execution System). The current brand mark is the
"Stacked S" — a production line bent into the letter S, with an accent dot as
the part coming off the end. The S no longer stands for anything. What should
the mark be?

**Shape:** 70 concepts across 18 families, all on one page.

- `index.html` — the gallery (shell + renderer + family jump-nav)
- `marks.js` — all 70 mark definitions, `{ n, idea, svg(strokeWidth) }`

Deviation from the prototype skill's default: it caps UI variants at 5 and wants
a `?variant=` switcher, but marks have to be judged *against each other*, so this
is a side-by-side grid — matching how this repo picked the Stacked S (winner of
25) and the hero field (winner of 8).

**Constraint that drove every concept:** the mark renders at **23px** in the
shell (`sub-shell.ts`, `<sf-mark [size]="23" />`) and 16px as a favicon. Every
card shows those two sizes next to the study size. A mark that only works large
is not a candidate. Accent is a single `--a500` element per the brand rule in
CLAUDE.md ("purple is reserved for the brand mark's dot…").

## Families

| # | Family | Round | Concepts |
|---|--------|-------|----------|
| 01–04 | A — monogram | 1 | Apex, Gate, Split A, Round a |
| 05–08 | Aries (AIRES is one letter from ARIES — the ram) | 1 | Aries Glyph, Horns, Single Horn, Aries Dot |
| 09–12 | Request → Execution | 1 | Ascend, Pipeline, Transform, Throughput |
| 13–15 | Automation — the loop | 1 | Loop, Orbit, Return |
| 16–18 | Intelligence | 1 | Node, Spark, Constellation |
| 19–20 | System | 1 | Stack, Aperture |
| 21–24 | Continuous line (the old mark was one unbroken stroke) | 2 | One-Line A, Zigzag, Thread, Link |
| 25–27 | Negative space | 2 | Carved A, Counter, Void Ram |
| 28–31 | **Wordmark lockups** | 2 | Letterspaced, AI Bind, Mono Tag, Stencil |
| 32–34 | Air | 2 | Currents, Updraft, Layers |
| 35–37 | Semiconductor | 2 | Die, Lattice, Mask |
| 38–40 | Energy | 2 | Ignition, Plume, Bloom |
| 41–45 | **Dialogue** | 3 | Bubble A, Two Voices, The Question, Exchange, Prompt |
| 46–50 | Enclosure | 3 | Ring A, Hex, Shield, Chip Badge, Notch Ring |
| 51–55 | Matrix | 3 | Dot Matrix, Pixel A, Bars, Punch Card, Halftone |
| 56–60 | Assembly | 3 | Blocks, Interlock, Nested, Split Cube, Join |
| 61–65 | Gates (your own domain language) | 3 | Checkpoint, Passed, Milestones, Threshold, Stamp |
| 66–70 | Dimensional | 3 | Iso A, Fold, Prism, Depth, Iris |
| 71–80 | **Continuous line — curved** | 4 | Wave, Crescendo, Settle, Crest, Sweep, Coil, Knot, Bounce, Meander, Twist |

| 81–88 | **The dot as counter — "A"** | 5 | Crest A, · low, · bold, · bar, Narrow A, Splay A, Peak A, Heavy A |

**Round 5 is the user's idea and it is the best one so far.** Looking at
74 Crest — an arch with the accent dot floating *above* it — they asked what
happens if the dot moves *inside*. Answer: the arch stops being a bump and
becomes an **A**, with the dot sitting exactly where the letter's counter is.
It solves the brief's central tension in one move: a letterform that is still
one continuous curved stroke, and the brand's signature purple dot is load-
bearing rather than decorative — it *is* the counter, not a garnish.

These eight vary only the things that decide whether it reads as a letter: dot
height, dot size, arch proportion. 84 swaps the dot for a true crossbar as a
control.

Relationship worth knowing: **84 Crest A · bar is essentially 01 Apex drawn
curved instead of angular.** If 84 wins, compare it against 01 directly and pick
a posture — the set does not need both.

Round 4 exists because 21–24 were all angular. It is appended at the **end**
rather than next to its parent family so that numbers 25–70 stay stable — the
gallery had already been reviewed once by number. **71 Wave** is literally
22 Zigzag with every corner rounded; the rest vary amplitude profile (growing,
decaying, single-hump), direction (across vs. up), and where the stroke ends.

## Two structural decisions to make before picking a number

1. **Mark or wordmark?** 28–31 are lockups, not square marks — they replace the
   mark + "AIRES" pair entirely, so there is nothing to shrink to 23px (their
   cards say so rather than faking the test). Going wordmark-only makes the whole
   mark question moot.
2. **Shared or separate?** `sf-mark` is imported by **both** apps. Changing it
   changes the console's logo too, and the console is not called AIRES. This may
   need two marks.

## Assessment at 23px (the only size that matters)

- **Fails outright** (flagged in-page): 11 Transform (collapses to two dots),
  18 Constellation (points nearly vanish).
- **Marginal:** 04 Round a (counter fills in), 07 Single Horn (reads as a blob),
  15 Return, 62 Passed (loses its accent dot at the tip), 77 Knot (blob at 23px).
- **76 Coil reads as a letter G** — legible, but the wrong initial for AIRES.
  Kept in for comparison; would need reshaping before it could be used.
- **Strongest small:** 01 Apex, 05 Aries Glyph, 08 Aries Dot, 10 Pipeline,
  14 Orbit, 17 Spark, 19 Stack, 23 Thread, 25 Carved A, 43 The Question,
  45 Prompt, 51 Dot Matrix, 63 Milestones.

Editorial notes:

- **17 Spark** is the most instantly legible and the most dated — the four-point
  sparkle is the current industry house style for "AI" and will read as
  2025-vintage within a year.
- **05/08 Aries** is the only family tying the mark to the *name* rather than to
  a generic idea about pipelines; it also risks reading as zodiac/astrology,
  which may be wrong for an internal engineering tool.
- **23 Thread** is the truest descendant of the Stacked S: one stroke in, one
  out, accent where it lands.
- **41–45 Dialogue** is the only family that draws what AIRES actually *does* —
  it interviews you. Rounds 1 and 2 both missed this entirely.
- **61–65 Gates** borrows the factory's own vocabulary (gates, approvals,
  stages), so it is the most "native" family to this codebase.
- **25 Carved A** is the only real answer to the app-icon / favicon-tile case.
- **81–88 (round 5) is the strongest family in the set.** It is the only idea
  where the accent dot does structural work instead of sitting alongside the
  mark. Of the eight: **83 · bold** and **88 Heavy** survive 16px best (the
  bigger dot holds the counter open); **84 · bar** is the clearest *letter* but
  spends the purple on a bar rather than the dot, which weakens the brand tie;
  **87 Peak A** is the best balance of letter-legibility and curve.

## Identity directions — `identity.html` (2026-07-21)

Second prototype, after the mark question narrowed. **User selected the zigzag
(22) as the logo**, so this asks the next question: what identity goes *around*
a fixed mark? Ten directions, mark constant, varying typeface / case /
arrangement / colour. Each is shown as a display lockup **and in a replica of
the real intake nav at true size** — the nav is where this lives, and a lockup
that only works on a white stage is not an answer.

| # | Direction | The idea |
|---|-----------|----------|
| 01 | Incumbent | Archivo Black, caps — the control |
| 02 | Rounded | M PLUS Rounded 1c, matching the mark's round caps |
| 03 | **Lowercase rhyme** | "aires" — the i-dot and the accent dot become one motif |
| 04 | Stacked | Masthead arrangement; costs nav height |
| 05 | **Tile** | White mark on a purple tile — the app-icon/favicon answer |
| 06 | Terminal | JetBrains Mono, bracketed — matches the ASCII hero |
| 07 | Contained | Mark in a ring; also stops the zigzag reading as a stray N |
| 08 | Gradient | Hero gradient in the mark |
| 09 | Institutional | Wide-tracked light caps + divider |
| 10 | With descriptor | Adds "Request & Execution" — the only one that explains the name |

Four carry in-page warnings. Two of those were **measured, not assumed**:

- **09** — I first flagged a contrast risk. Measurement disproved it (17.3:1 on
  dark). The real risk is optical: weight 300 looks fragile beside the mark.
- **10** — the descriptor measures **4.49:1, just under the 4.5:1 floor**, at
  7.5px. It fails accessibility as drawn and needs a lighter grey or a
  breakpoint drop.
- **04** stacked costs vertical space the 58px nav does not have.
- **08** a gradient mark cannot be recoloured for dark tiles, print, or
  single-colour use — a real constraint, not a taste note.

Structural finding: **05 Tile and the others are not mutually exclusive.** Every
identity still needs an app-icon form, and the tile is the only direction that
survives an arbitrary background. The likely answer is one wordmark direction
(01/02/03/06) *plus* 05 as the icon lockup.

## Round 6 — variations on the shipped mark — `variations.html` (2026-07-22)

Third prototype. The mark question is **settled**: `mark.ts` ships the folded
stroke (`M9 32 L19 17 L28 32 L39 16` + accent dot off the tip). This round does
not propose new marks — it asks **which dial on that exact shape makes it
better**. Twenty variations, one variable moved per card, the shipped mark drawn
as a ghost under every study so each change reads as a *delta* rather than
something you have to hold in memory. Card **00 is the control**, unchanged.

Every card is the **full lockup** (mark + "AIRES"), not a bare icon — the logo
is the pair, and a mark can only be judged against the wordmark it sits beside.
The wordmark is constant across all 20, so only the mark is ghosted. Proportions
and face are lifted from the real `.sub-brand` rule in
`apps/intake/src/styles.css` (mark 22 / Archivo 700 at 17 / gap 9), scaled ×2.3
for the study and rendered at true size in the nav strip below it. Archivo is
loaded straight from `apps/intake/public/fonts/` so the lockups are not
approximations.

| # | Family | Variations |
|---|--------|-----------|
| 01–06 | Geometry — the fold | Steeper, Flatter, Narrow, Single Fold, Triple Fold, Staircase |
| 07–11 | Stroke & corners | Smoothed, Wave, Heavy, Hairline, Squared |
| 12–13 | The exit leg | Steep Exit, Long Exit |
| 14–19 | The dot | Detached, Large Dot, Small Dot, Dot at Entry, Floating, Trail |
| 20 | Framing | Grounded |

Four carry in-page 16px warnings: **02 Flatter** (folds nearly vanish),
**05 Triple Fold** (collapses to a smear), **10 Hairline** (sub-pixel on
low-DPI), **16 Small Dot** (accent barely visible). The 16px cell here is the
**accent tile** from `apps/*/public/mark.svg`, not a bare stroke, because that
is how the favicon actually ships.

Deviations from the earlier rounds, deliberate:

- One accent element per mark was a round-1 constraint; **19 Trail** breaks it
  (three dots) on purpose, to test whether the "output" reading survives being
  plural. **20 Grounded** adds a second *neutral* element, not a second accent.
- A "Twin Dots" card (accent at both ends) was drawn and cut — it reads as
  symmetrical decoration and directly contradicts the CLAUDE.md brand rule, so
  it was not worth a slot.

One bug worth remembering: the wordmark first rendered in the **wrong face** and
looked plausible. `font-family: 'Archivo', var(--display), sans-serif` — this
page never defines `--display`, and a single undefined `var()` invalidates the
*whole* declaration, so it inherited body copy instead. Measured with
`getComputedStyle`, not eyeballed. Name faces literally in throwaway pages.

Prior art inside this folder: **07 Smoothed** and **08 Wave** are the round-4
curved-line question re-asked against the shape that actually won, so if either
beats the control, check it against 71 Wave before redrawing anything.

## Round 7 — the wordmark drawn, not set — `wordmark.html` (2026-07-22)

Fourth prototype. The mark is now **frozen**; the question moves to the word
beside it, which is still Archivo 700 — a licensed typeface any project can buy.
What if the letters were *drawn*, built the way the mark is built? Twelve
wordmarks, mark constant. Card **00 is Archivo**, the control.

**The measurement that makes the page honest.** Every wordmark draws into a
viewBox where the cap line is y=3 and the baseline y=21 (cap height 18). Render
that box 16.5px tall and the cap height lands on **12.4px — exactly Archivo
700/17px's cap height** — while a stroke of `4` measures **2.75px, exactly what
the 22px mark's stroke-6 measures**. So `s = 4` literally means "the mark's own
weight", and every drawn letter is comparable to both the mark and the control
without eyeballing anything. Letters are *stroked*, not filled — one path, round
caps, round joins, same construction as the mark.

| # | Family | Variants |
|---|--------|----------|
| 01–08 | Drawn, mark separate | Monoline, Folded, Condensed, Wide, Heavy, AI Bind, Tittle, Dot Counter |
| 09–12 | Fused, one object | Mark as A, Fold-in, Underline, Knockout |

Each card shows the display lockup, the true-size nav replica, and — new this
round — **the word alone**, because a wordmark that only works propped against
the mark has not solved anything.

### Three things that failed, and why

1. **A stencil / "Cut" alphabet is impossible at this cap height.** Cutting
   every joint open needs two gaps per counter, and at cap 18 with the mark's
   stroke the counters are *narrower than two cuts*. Every letter turned to
   mush — the render read "|-|||{|=". Not a tuning problem; the geometry has no
   room. Slot reused for AI Bind.
2. **A true A+I merge reads as "ARES".** First attempt stood the A's right leg
   up straight so it doubled as the I. A vertical right leg still just looks
   like part of the A, so the word silently lost a letter — and landed on ARES,
   the round-1 ram pun, which is worse than a typo. Fixed by *touching* instead
   of merging: the I slides in until its left edge meets the A's right edge.
   Both letters stay legible and the pair still shares an edge, which is the
   move a font cannot make.
3. **Fold-in (10) does not work, and is kept as a documented negative.** Running
   the mark's final rise on into the A's left leg makes one continuous stroke —
   but the mark already has two peaks of its own, so a third reads as
   **"AAIRES"**. Dropping the mark 2.2 units to subordinate its peak helped and
   did not cure it. The finding is structural: *this* mark cannot fuse into an A,
   because its silhouette is already A-shaped. Flagged in-page rather than
   quietly redrawn.

### Tooling note

`wordmark.html` is a **single file** on purpose. The letter system started as a
separate `wordmarks.js`; the preview pane resolves `file://` sub-resources from
its own snapshot and ignores cache-busting query strings, so edits to the letter
data silently rendered stale for three rounds. Verified via `typeof` on a
newly-added function, not by eye. Anything iterated in the preview pane should
be one file.

## Verdict

**TBD — awaiting the user's pick.**

Once chosen: fold the winner into `packages/shared/src/lib/kit/mark.ts` (rewrite
it properly — this gallery's SVG was written under prototype constraints), update
the docstring, resolve the shared-vs-separate question above, and delete this
folder.

If a **round 7** wordmark wins, it does not go in `mark.ts` — a drawn wordmark
is a second component (`sf-wordmark`) plus a change to `.sub-brand` in
`apps/intake/src/styles.css`, which currently sets the word in Archivo. Two
consequences to settle first: the Archivo `@font-face` and its `.woff2` can be
dropped entirely if nothing else uses the face, and a *fused* winner (09–12)
means `sf-mark` no longer stands alone, so `apps/*/public/mark.svg` becomes the
only icon form and has to be judged on its own.
