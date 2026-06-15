---
target: the light theme factory map
total_score: 21
p0_count: 2
p1_count: 2
timestamp: 2026-06-15T15-39-20Z
slug: web-src-app-admin-map-ts
---
# Design critique — Factory map (light theme)

Target: web/src/app/admin/map.ts (+ tokens in web/src/styles.css)
Register: product. Method: independent LLM review + deterministic detector + live computed-style checks (light, /admin/map). Live data was empty (unrelated port conflict: html-hub backend on :8000); judged populated state from source + the user's reference screenshot.

## Design health (Nielsen, synthesized)

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 3 | Now-band/rings/pulse/poll-freshness strong; KPIs+rings+now-band over-report "how busy" |
| 2 | Match system / real world | 3 | "Awaiting approval / Needs a human" excellent; undercut by `SINGLE-LANE · 1/1 ACTIVE`, `AGENT //` |
| 3 | User control & freedom | 2 | Cards/chips navigate away; no clear-all on search, no drill back-affordance |
| 4 | Consistency & standards | 1 | Invents a cyan HUD language used nowhere else; `.fm-card` duplicates `.bcard`; KPI tiles unlike any other card |
| 5 | Error prevention | 3 | Mostly read-only/navigational, low error surface |
| 6 | Recognition vs recall | 2 | Ring fill = "÷ busiest column" is unlabeled and disagrees with the count inside; glow colors carry meaning with no key |
| 7 | Flexibility & efficiency | 2 | Zero keyboard path on a surface whose primary user is "keyboard-first, all day" |
| 8 | Aesthetic & minimalist | 1 | Decorative HUD ticks, sheen, rail animation, glows, gradients — noise the brief explicitly bans |
| 9 | Help users recover | 2 | No failed-fetch state; stalled cards say "Needs human" but no next step |
| 10 | Help & documentation | 2 | No legend for ring semantics, glow colors, or what "in flight" counts |
| **Total** | | **21/40** | **Below average — needs work** |

Cognitive load: 6/8 failures (competing focal points, low info scent on rings, inconsistent patterns vs the rest of the app, HUD jargon, no clear primary action, too many simultaneous options). Strength: progressive disclosure (exception-peek + collapse chips).

## Anti-patterns verdict — would you believe "AI made this"? Yes.

The information architecture is human-grade; the skin is an AI cockpit costume. Tells, all confirmed in light-mode computed styles:
- Glassmorphism literally (`--glass = rgba(255,255,255,0.72)` + `backdrop-filter: blur(12–16px)` on every surface). On a `#faf9fb` canvas the blur does nothing; cards separate only via a 10%-alpha border.
- Neon glow on white: `.fm-kpi` box-shadow includes `rgb(189,3,247) 0 0 30px -18px` (purple bloom) + `rgba(50,30,90,0.4) 0 22px 48px` (dark-tuned drop shadow). Now-band adds `0 0 50px -22px` cyan glow.
- Hero-metric template: four identical KPI tiles, 40px mono numbers, dot + ALL-CAPS micro-label.
- HUD cosplay copy + chrome: `AGENT // NOW WORKING`, `SINGLE-LANE · 1/1 ACTIVE`, corner ticks (::before/::after), animated `fm-rail` conveyor, `fm-sheen` progress sweep.
- Gradients on progress bar, rail, spines, card washes.

Deterministic detector (impeccable detect): 2 findings.
- `side-tab` — `border-left-width: 3px` (map.ts:648). This is a DOCUMENTED exception in DESIGN.md ("Board/feed cards carry a 3px colored left edge as the stage/kind cue"), used correctly with state colors. Sanctioned deviation, not a defect — candidate for the ignore list.
- `layout-transition` — `transition: width` (map.ts:386, progress bar). Real (minor): animating width thrashes layout; use transform: scaleX.

## The headline: it contradicts its own brief, by name

PRODUCT.md anti-references list "glassmorphism", "consumer-SaaS gradients", "dark-mode-by-default tool aesthetic". DESIGN.md mandates "single purple accent" (+ amber/red/green signals only), "structure felt not seen (hairlines, not boxes)", "shadows only on overlays, no decorative shadows". The Factory map violates every one of these and introduces an undocumented cyan accent (`--cyan #0a8fa3`) as a co-primary (now-band, run-state, progress bar, rail, live dot). It is the most off-brand surface in an otherwise disciplined system — compare the calm `.bcard`/`.lrow`/`.pill` components in the same stylesheet.

## What's working
1. Aggregate-first card body: exception-peek (top-5 by severity) + "+N running" + "+N more → drill" is genuinely good progressive disclosure.
2. The amber waiting-chip is a real interaction: "{count} items · {w} awaiting approval →" routes to a filtered worklist. Correct tier-by-consequence.
3. Plain-language status (`pill()` → "Awaiting approval / Needs a human") + thorough aria-labels + reduced-motion guards on every animation.

## Priority issues
- P0 Strip glassmorphism + glow; re-ground in the documented system. Replace `--glass`/blur/glow shadows on `.fm-kpi`/`.fm-now`/`.fm-card` with `--surface` + 1px `--border`, hover → `--border-strong`/`--shadow-pop`. Make `.fm-card` reuse `.bcard`.
- P0 Retire the cyan; restore single-accent purple. Move "running/live" to the purple ramp; keep amber/red as the only loud signals so the operator can triage at a glance.
- P1 Give the admin a keyboard (principle #3): `/` focus search, toggle filter, j/k + Enter through cards, reuse `.kbd`/⌘K palette.
- P1 Label or drop the ring. Fill ("÷ busiest stage") is unlabeled and disagrees with the count inside; either label it or replace with count + status glyph.
- P2 Cut HUD cosplay copy + decorative motion (corner ticks, rail animation, sheen). Keep the single status pulse.
- P2 Tame competing focal points: the `subtitle()` line already states "N in flight · N waiting · N stalled" — the four glowing KPI tiles may be redundant.

## Persona red flags
Alex (keyboard-first power admin): zero hotkeys; perpetual rail/pulse/sheen motion = all-day fatigue; glass translucency lowers contrast on 11px mono refs; KPIs eat ~120px to repeat the subtitle.
Jordan (first-timer): HUD jargon meaningless on first contact; unlabeled rings + glow colors have no legend; no orientation that this is "a lens, not the worklist"; two color systems (cyan + purple) to learn.
