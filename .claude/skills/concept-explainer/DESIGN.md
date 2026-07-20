# Design: the explainer as an object

The page is a document, not a landing page. Give it the craft of a landing page
and the restraint of a document. Most explainers do not need a giant hero.

## Ground it in the subject

Distinctive choices come from the concept's own world — its materials,
instruments, vernacular. A CI pipeline is not a meditation app.

Pick the **subject hook** first: the most characteristic thing in that world.
Make it the page's recurring visual event, and let the accent color mean that
one thing and nothing else.

> Worked example: for a factory that stops and asks a human at five points,
> the hook is *the gate*. Amber means "a human must decide" and appears nowhere
> else. Machine work is teal, shipped work green — semantic, not accent.

## Color

4–6 named values, declared as custom properties. Spend boldness in one place
and keep everything around it quiet.

- **Choose the neutral, don't inherit it.** A pure mid-grey reads as
  unconsidered. Bias it slightly toward the accent.
- **Semantic color is separate from the accent.** good / warning / critical are
  status, and they do not count as your accent.
- Style components through tokens only, never with literal colors inside a
  media query.

## Type

Two or three roles: a display face used with restraint, a body face, and a
utility face for labels, keys, and paths. Pair them deliberately — a serif that
reads like a report next to a geometric sans reads differently from two sans
faces.

- No CDN links. System stacks or an inlined `@font-face` data URI.
- Running text near 65 characters.
- `text-wrap: balance` on headings, `pretty` on paragraphs.
- Display type wants tight leading (~1.1); body wants 1.5–1.7.

## Layout

Flex or grid with `gap` — not per-element margins that collapse or double.
Wide content (tables, diagrams, code) scrolls inside its own
`overflow-x: auto` container so the page body never scrolls sideways.

## Theming: pin it three ways or it will break

A viewer can carry a dark preference *and* stamp `data-theme` on the root. If
you answer only one, you get dark canvas with dark text. Answer all three:

```css
:root,
:root[data-theme="dark"],
:root[data-theme="light"] { color-scheme: light; /* tokens… */ }

@media (prefers-color-scheme: dark) { :root { /* tokens again */ } }

html { background: <paper>; }   /* html is transparent by default */
body { background: <paper>; color: <ink>; }
```

Committing to a single theme is a legitimate choice for a document that will be
printed — but make it a choice, and pin it. Otherwise design both themes with
the same care; never naively invert.

## Traps that have actually bitten

- **`rem` is not your body size.** `rem` resolves against the root (16px). With
  an 18px body, `0.73rem` labels render at **11.7px**, not the 13px you meant.
  Check computed pixels, not the number you typed.
- **`html` has no background by default.** The body's background usually
  propagates, but a host that paints its own canvas will show through.
- **Charset.** A file hosted without a declared charset renders em-dashes as
  `â€"`. If it may leave your machine, go ASCII-safe.
- **Silent font fallback.** A missing family degrades quietly and the page
  looks generic. Verify the resolved family.
- **Tracking exists to loosen uppercase.** If you drop the uppercase treatment,
  drop the letter-spacing with it.

## Do not reach for the house style of AI

These are the current tells. Where the user specifies a direction, follow it
exactly — their words win. Where nothing is specified, don't spend that freedom
here:

warm cream `#F4F1EA` + serif display + terracotta accent · near-black with a
lone acid-green or vermilion pop · broadsheet hairline rules with dense columns
· purple-to-blue gradient hero on white · Inter or Space Grotesk as the "safe"
face · emoji as section markers · everything centered · `rounded-lg` on
everything · an accent bar or rail down the side of a rounded card · a tracked
uppercase kicker sitting directly above an oversized headline ·
zero-padded `01 / 02 / 03` section markers.

## Structure must be true

Structural devices encode something real or they are decoration.

Numbering is legitimate **only** when the content is genuinely a sequence — and
even then, prefer the domain's own vocabulary over `01 / 02 / 03`. Naming
stages by their real keys (`stage · architecture`) teaches the reader a word
they will meet again in the system; a numeral teaches nothing.

## Copy is design material

Active voice. Name things the way the reader recognizes them, not the way the
system is built. Specific beats clever. Watch the em-dash count: more than two
in body copy reads as machine cadence — use commas, colons, periods, or
parentheses.
