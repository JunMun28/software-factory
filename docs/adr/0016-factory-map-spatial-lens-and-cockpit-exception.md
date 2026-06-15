# The Factory map is a spatial pipeline lens with a deliberate "cockpit" visual exception

**Status:** accepted (complements ADR 0015; the map is an alternate lens, not the default landing)

The Factory map (`/admin/map`) is a spatial overview of every live Work item laid
across the six stage columns — a lens, NOT the worklist. Mission control (ADR 0015)
remains the default landing and the place an Admin reads, judges, and acts; the map
answers a different pair of questions at a glance — *where is everything* and *which
stage is hot right now*. It derives entirely from `store.requests` + the page-scoped
`/api/mission` aggregate and stores nothing new (no schema, no events).

The map intentionally wears a distinct **cockpit** aesthetic — glass surfaces, neon
glow, a blueprint-grid canvas, conic progress rings, an animated stage rail, and a
cyan "live" accent. This DEVIATES, on purpose, from the calm Micron-Atlas system the
rest of the console follows: single purple accent, hairlines over boxes, shadows only
on overlays (see DESIGN.md), and PRODUCT.md's explicit anti-references to
glassmorphism, gradients, and the dark-mode tool aesthetic. This ADR exists to record
that exception — it contradicts a load-bearing brand rule, so it must be a named,
bounded decision rather than silent drift, and must not spread to other surfaces.

## Why recorded (the exception, not the lens)

- **Surprising** — the rest of the app bans glassmorphism, decorative glows, and a
  second accent color *by name*, yet the map uses all three. Anyone reading the design
  docs would expect the map to look like `.bcard` / `.pill`; it does not.
- **Real trade-off** — the cockpit gives the spatial overview a "live operations" read
  the flat system could not convey, reinforcing that the map is a watch-the-floor lens
  and not another worklist. The cost is a second visual language to learn and a cyan
  accent (`--cyan`) that competes with purple for "this is important." We accept the
  cost only because the map is a glanceable lens, not an action surface.
- **Hard to reverse** — the aesthetic is baked into `map.ts`'s inline styles
  (`--glass`, `--cyan`, `--glow-*`, conic rings, the `fm-rail` animation). Pulling it
  back to the system later is a full restyle, not a token swap.

## Scope of the exception (the boundary)

- The cockpit aesthetic is confined to `/admin/map`. No other surface adopts glass,
  cyan, glows, or the blueprint grid.
- Cyan is map-only. Everywhere else purple stays the single accent and amber/red stay
  the only loud signals.
- Status meaning still rides on shape + the documented amber (gate) / red (needs-human)
  signals; the cockpit decorates that language, it does not replace it.
- The map adds no persistence and is not the default landing — Mission control keeps
  that role (ADR 0015).

## Consequences

- DESIGN.md's "single purple accent" rule now has exactly one named exception: the
  Factory map cockpit. `.impeccable/critique/ignore.md` records the deliberate
  deviations (glass, glow, cyan, the 3px spine) so design audits stop re-flagging them.
- Defects that are independent of the aesthetic remain open and are NOT covered by this
  exception: the map has no keyboard parity (violates ADR 0015 / keyboard-first), its
  conic ring fill is unlabeled and disagrees with the count it encircles, and the
  progress bar animates `width` (layout thrash). These are tracked as follow-up fixes.
- If a future surface wants cockpit styling, it needs its own ADR amending this scope —
  the exception does not generalize.
