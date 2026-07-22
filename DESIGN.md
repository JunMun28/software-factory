# AIRES — design system (implemented in apps/intake/src/styles.css and apps/console/src/styles.css)

## Color (light, single accent)
- Canvas `--bg #FAF9FB` · surface `#FFFFFF` · wells `#F4F3F7` / `#ECEBF1`
- Ink `--fg1 #1A1A1F` · `--fg2 #3A3A42` · muted `#6C6C78` · faint `#75757F` (AA floor)
- Borders `#E6E6EA` / strong `#D7D7DE` / hairline `#EEEEF2`
- Accent ramp a50–a900 around Micron purple `#BD03F7`; working accent `--accent #A402DC`
- Signals: amber `#C77800` (gate) · red `#C0392B` (needs-human) · green `#2E7D52`
  (success only). One amber + one red max per surface; purple never replaces them.

## Type
- Display/body: "Archivo" (variable 100–900, local woff2, SIL OFL), mono: JetBrains Mono
- Admin body 13–14px dense rows; Submitter body 15–16px; headings 600, tracking -0.01em
- Mono for REQ refs, repos, diffs, keycaps; `font-variant-ligatures: none`

## Shape & elevation
- Radii: 4 / 6 / 10 px (+pill); shadows only on overlays (`--shadow-pop/overlay/panel`)
- Cards/rows: 1px `--border`, hover → border-strong or pop shadow; no decorative shadows
- Board/feed cards carry a 3px colored left edge as the stage/kind cue (design-system
  exception, part of the documented visual language)

## Motion
- 80/140/240ms, `cubic-bezier(.2,.6,.2,1)`; transform/opacity only; reduced-motion collapses

## Core components (all in global styles.css)
.btn (primary/ghost/danger/sm/lg) · .input · .pill/.chip/.sig (status language) ·
.kbd keycaps · status glyphs (sf-glyph: dotted/ring/check/strike/flag) · .navrow with
hover shortcut tooltips · .palette (⌘K) · .sidepanel + .scrim · stage strips (pipeline)
· Slack-style .smsg/.satt feed · .stepper / .tracker / .tl timelines

## Vocabulary guards
Submitter sees plain stages (Submitted…Deployed, "Needs your input"); Admin sees
Control-center terms (gates, Needs human). Never mix registers on one face.
