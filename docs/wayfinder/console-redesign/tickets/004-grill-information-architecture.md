---
id: 004
title: "Grilling: information architecture from zero"
labels: [wayfinder:grilling]
status: closed
assignee: junmun (session 132e3c43)
resolved: 2026-07-11
blocked-by: [003]
---

## Question

Given the ranked jobs-to-be-done (ticket 003), what are the surfaces and
navigation of the new console — designed from zero, not inherited from the June
revamp?

Decide: the home surface (what an operator sees first), the full surface list,
navigation model (sidebar? command-first? spatial?), how live fleet state,
gates, and history relate, and what from the current console survives on merit
(e.g. keyboard-first J/K/A/S/T, trace page) vs dies. Explicitly compare against
the June IA (Mission control / Gates / All requests / Registry) and justify
each divergence.

Resolve via /grilling with sketch-level artifacts where words are ambiguous.
The answer is the surface map + navigation model that per-surface spec tickets
will hang off.

## Resolution

Decided by delegation ("you decide everything and write spec"), 2026-07-11.
Full detail: [docs/superpowers/specs/2026-07-11-console-redesign-design.md](../../../superpowers/specs/2026-07-11-console-redesign-design.md) sections 4-7.

Eight June surfaces collapse to **four**: **The Floor** (`/`, attention-first
editorial home: masthead numbers, "Needs you" evidence/triage cards, the
"Assembly Line" of in-flight run lanes, "Recently"), **Dossier**
(`/requests/:id`, semantic timeline with decided-by + raw evidence drawer),
**Library** (`/library`, the only list, filterable), **Studio** (`/studio`,
registry + operator profile + persisted notification prefs).

Killed with reasons: Mission control (becomes The Floor), Factory map (cut;
its stage-progress idea survives as the Assembly Line strip), Gates queue +
Needs me (redundant with a truthful Floor; email deep-links land on the
Dossier), per-app Feed (comments move to the Dossier timeline; filtering to
Library), Settings-as-preview (becomes real in Studio).

Navigation: no sidebar — slim hairline top bar + command palette; keyboard
grammar (palette, G chords, gate J/K/Enter/A/S) survives on merit. Legacy
`/admin/*` routes redirect.
