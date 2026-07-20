---
name: concept-explainer
description: Build a beautiful, self-contained HTML page that explains one concept end to end, with real art direction and real teaching structure. Use when the user asks for an explainer, a visual guide, an onboarding doc, a "how X works" or "end to end" page, wants a system or codebase or idea explained as a web page or HTML file, or wants something they can share, print, or return to later.
---

# Concept explainer

One HTML file that makes one concept click. Design quality and teaching quality
are the same job: a page nobody wants to read teaches nothing, and a beautiful
page that explains nothing wastes the reader's time.

## Workflow

### 1. Pin the target — before anything else

- **The concept.** One. Concrete. If the request names three, ask which one.
- **The reader.** What do they already know? Start there, not at first
  principles. An explainer that re-teaches what they know is condescending;
  one that skips what they lack is useless.
- **The one win.** The single thing they can do or say afterwards. Write it
  down. Anything on the page that does not serve it gets cut.
- **The why now.** What decision or task is this serving? If you cannot answer,
  ask — ungrounded explainers drift into abstraction.

### 2. Get the facts from the source

Never write an explainer from memory. Read the code, the ADRs, the docs, the
actual test that proves the behavior. Every non-obvious claim should trace to
something you opened. When a claim is load-bearing and you could not verify it,
say so on the page rather than asserting it.

### 3. Write the design plan — before any code

Four lines, no more:

- **Subject hook** — the most characteristic thing in this concept's world.
  That becomes the page's recurring visual event.
- **Color** — 4–6 named hex values, one accent spent on one idea.
- **Type** — 2–3 typefaces with assigned roles (display / body / utility).
- **Layout** — one sentence.

Then check the plan against the anti-generic list in [DESIGN.md](DESIGN.md).
Revise anything that would look identical for any other subject.

### 4. Build

Self-contained: one file, inline CSS, no CDN links. It will be printed,
emailed, opened on a phone, and opened in three years.

Follow [DESIGN.md](DESIGN.md) for tokens, theming, and the traps that have
actually bitten. Follow [TEACHING.md](TEACHING.md) for the shape that makes it
teach rather than merely inform.

### 5. Verify in the browser — never by eye alone

Serve the file and run [scripts/audit.js](scripts/audit.js) in the page. It
reports theme pinning, contrast ratios, text below 13px, sideways scroll, and
fonts that silently fell back. Fix what it finds, then screenshot at desktop
and at 375px.

Eyeballing misses exactly the failures that matter: dark-on-dark, 11px labels,
and a font stack that never resolved.

### 6. Land it

Save next to related material, tell the user the path, and say what you could
not verify. If the page will be hosted somewhere that may not declare a
charset, make it ASCII-safe (HTML entities, CSS unicode escapes).

## Checklist

- [ ] One concept, one reader, one win — all three written down
- [ ] Every non-obvious claim traced to a real source
- [ ] Design plan written before the first line of CSS
- [ ] Plan checked against the anti-generic list
- [ ] Self-contained: no external CSS, JS, fonts, or images
- [ ] Theme pinned all three ways (see DESIGN.md)
- [ ] `audit.js` run and clean
- [ ] Screenshotted at desktop and 375px
- [ ] Prints sensibly (`@media print`)
- [ ] Ends with a way to ask a follow-up question
