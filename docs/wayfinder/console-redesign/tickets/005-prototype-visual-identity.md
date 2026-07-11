---
id: 005
title: "Prototype: visual identity directions for the control room"
labels: [wayfinder:prototype]
status: closed
assignee: junmun (session 132e3c43)
resolved: 2026-07-11
blocked-by: [001]
---

## Question

What should the new console look like — which visual identity direction makes
it read as a world-class factory control room?

Build 2–3 distinct directions as standalone HTML mockup labs in `mockups/`
(the intake-redesign workflow), each rendering the same representative screen
with realistic data, in light and dark. Directions should draw on ticket 001's
research (e.g. calm mission-control density vs industrial/HMI character vs
refined product-tool minimalism). Typography, color system, density, motion
principles, and data-display style are the axes.

HITL: iterate with the user on the labs until one direction (possibly a blend)
is approved. The answer records the chosen direction and links the winning lab;
per-surface labs later inherit it.

**Sharpened 2026-07-11** by the redesign spec
(`docs/superpowers/specs/2026-07-11-console-redesign-design.md`): the
representative screen is **The Floor** (spec §5); the lead direction to
prototype is **"Atelier"** (spec §8 — editorial typography-as-chrome, warm
paper/ink surfaces, factory-amber signal budget, Assembly Line lanes), plus
1–2 contrasting directions for honest comparison. User approval of a lab
gates all build work (user rule; spec §12 step 1).

**Labs built 2026-07-11** (all: The Floor, same data, light + dark, verified
at 1440 px and 390 px; serve `mockups/` and open, or use the floating A/B/C
switcher inside each page):

- A — Atelier: `mockups/console-floor-atelier.html` (editorial paper/ink,
  Fraunces + Archivo, factory amber, traveling-bead lanes)
- B — Instrument: `mockups/console-floor-instrument.html` (precision
  product-tool, Schibsted Grotesk + IBM Plex Mono, cobalt signal, tick meters)
- C — Night Shift: `mockups/console-floor-nightshift.html` (industrial HMI,
  Big Shoulders + Saira + Overpass Mono, LED gauges, dark-first)

User feedback on A/B/C (2026-07-11): "make the UI cleaner and more friendly
to human and match the color theme as intake app." Built in response:

- **D — Family**: `mockups/console-floor-family.html` — The Floor in the
  intake app's Micron Atlas tokens verbatim (light #faf9fb + graphite dark,
  reserved purple accent, amber=gate / red=needs-human / green=success,
  small radii, hairline borders, JetBrains Mono data); friendly plain-language
  copy ("Good afternoon, Jun. Two things need you.", "Approving will merge…").
  Verified light + dark at 1440/390.

Awaiting user's pick (possibly a blend). Ticket stays open until a direction
is approved.

## Resolution

**Approved direction: D — Family** (user, 2026-07-11: "ok the new one is good").

The console adopts the intake app's Micron Atlas design language verbatim:
light #faf9fb canvas + graphite dark, white cards with hairline borders,
reserved Micron purple accent, amber=gate / red=needs-human / green=success,
small radii, Micron Basis + JetBrains Mono, friendly plain-language copy.
Winning lab: `mockups/console-floor-family.html` (The Floor, light+dark,
verified 1440/390). Labs A/B/C remain in mockups/ as rejected references.

Per-surface treatment: Dossier, Library, and Studio inherit the Family
direction directly from the lab + intake styles.css — no further mini-labs
(delegated decision). This supersedes the spec §8 "Atelier" lead direction.
