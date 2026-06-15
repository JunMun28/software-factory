# impeccable critique — ignore list
# One finding per non-comment line. A critique finding is dropped when one of
# these lines appears (case-insensitive substring) in its rule name or snippet.
#
# These are DELIBERATE, owner-confirmed deviations for the Factory map "cockpit"
# surface (the spatial pipeline lens). Confirmed intentional 2026-06-16: the map
# is branded as a distinct cockpit, separate from the calm Micron system used by
# the rest of the app. Should be formalized in a written ADR 0016 (referenced by
# web/src/app/admin/map.ts but not yet present in docs/adr/).

# 3px colored card spine — already a documented exception in DESIGN.md
# ("Board/feed cards carry a 3px colored left edge as the stage/kind cue").
border-left-width: 3px
Side-tab accent border

# Cockpit aesthetic, intentional on the Factory map only:
glassmorphism
backdrop-filter
glass-card
neon glow
glow shadow
cyan accent
HUD corner tick
