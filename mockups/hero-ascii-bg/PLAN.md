# PROTOTYPE — ASCII-gradient background for the intake describe hero

**Question:** should the intake home page ("What should we build?") get an
ASCII-glyph aurora background like the Ailix reference — and if so, which
mood: dark-faithful, light-on-brand, or inverted (glow from below)?

Throwaway mockups. Three variants, switchable via `index.html` (←/→ keys or
the pill at the bottom), or open each `v*.html` directly.

| # | File | Idea |
|---|------|------|
| 1 | `v1-nightfall.html` | The reference arc flipped upside down: full-width glyph bands rise from the bottom edge (red → cream → magenta → violet), curving like a horizon. Light + dark, toggle top-right. |
| 2 | `v2-daylight.html` | Keeps the intake app's light theme: pastel glyph halo around the edges, center kept clear (same philosophy as the current dot-grid hero-fx). |
| 3 | `v3-ignition.html` | Inverted: dark page, the glyph glow rises from the bottom under the composer, like a machine floor lighting up. |
| 4 | `v4-violet-mono.html` | Same arc as Nightfall but strictly one hue: Micron purple ramp, lavender core → orchid → violet → ink. No warm colours. |
| 5 | `v5-whisper.html` | The quietest: light theme, faint grey glyphs everywhere (character version of today's dot grid), one soft purple bloom behind the composer. |
| 6 | `v6-signal-band.html` | Different geometry: a horizontal aurora ribbon (magenta → violet → cyan) runs across mid-screen behind the composer. Dark. |
| 7 | `v7-sunrise-corner.html` | Asymmetric: one warm aurora sweeps in from the top-left corner and dissolves before mid-screen. Light theme. |
| 8 | `v8-deep-field.html` | Boldest: full-viewport glyph field, two aurora blobs drifting very slowly (only animated variant; honors reduced motion). Dark. |

The glyph field is a canvas: a low-res gradient scene is painted offscreen,
then each cell becomes a character — bright cells get dense brand glyphs
(`S`, `F`), dim cells crumble into `#`, `8`, `0`, `X`, `+`, `=` — colored by
the sampled pixel. A blurred copy of the scene underlays the glyphs for the
soft glow.

**Run:** serve the repo root (so the Micron Basis fonts resolve), e.g.
`python3 -m http.server 4173` from the repo root, then open
`http://localhost:4173/mockups/hero-ascii-bg/index.html`.

## Verdict

**Winner: v3 "Ignition"** (2026-07-16) — glow rises from the bottom under a
vertically centered composer; light + dark. Light mode was re-tuned twice on
request: the coral core was dropped for a brand-purple ramp, then lightened
again to a quiet orchid tint (the saturated version read as distracting on
the pale canvas). Ported into
`apps/intake/src/app/submitter/new-request.ts`; delete this folder once the
live page is confirmed.
