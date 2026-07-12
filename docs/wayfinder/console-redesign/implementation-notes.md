# Console redesign implementation notes

## Deviations

- Slice 2: no deviations from ticket 008. The mission `recent` rows now use a signed outcome wrapper (`request`, `outcome`, `decided_by`, `decided_at`) derived from existing audit events; unsigned historical rows are omitted rather than guessed or backfilled.

- The existing `/api/mission` payload does not include cycle-time or human-wait durations, so The Floor shows an honest em dash for median cycle and wait-on-human. No backend endpoint or inferred number was added in Slice 1.
- Merge-gate evidence has diff and test totals but no pull-request number or explicit deploy target. The consequence sentence therefore says that approval merges the approved work into main and deploys the named app, without inventing a PR number.
- Recent mission outcomes include request timestamps but no deciding actor. Recently renders the available outcome, title, and relative update time; signed decision provenance remains for the later backend/projection slice.
- The current frontend API exposes retry and cancel for stalled requests, but no take-over or send-back-to-stage endpoint. Slice 1 keeps those existing recovery actions plus the Dossier link; the missing verbs belong to the later recovery endpoint slice.
- Angular router redirects are deterministic client-side route replacements. A true HTTP 301/308 is a hosting concern outside this frontend-only slice.

## Slice 007 review pass (fable-5, 2026-07-12)

- codex's `ng build`/`task lint` failures were its sandbox (malloc crash, uv
  cache); both pass outside the sandbox. Do not chase these in later slices.
- Fixed in review: raw `href` → `routerLink` (SPA nav), tests fact rendered
  failures in green, palette lost type-to-filter, C shortcut dead on Floor,
  first J skipped row 0, missing assumptions fact, mobile hid primary nav,
  all-clear used a side-tab border foreign to the approved mockup.
- `shipped this week` derives from the mission `recent` list (capped at 10 by
  the API) — fine at current volume; revisit if weekly volume exceeds 10.
- Story 25's median cycle / wait-on-human need backend numbers; chips show an
  em dash until a later slice adds them (candidate: 013 or 016).
- Browser-pane screenshots go blank when scrolled — capture-tool quirk, not an
  app bug (DOM/opacity verified). Workaround: offset `main` margin-top.

## Slice 008 review pass (fable-5, 2026-07-13)

- BLOCKER codex missed: changing `MissionOut.recent` to `MissionRecent[]` broke
  the old `admin/mission.ts` build; codex reported build green but it was not.
  Always re-run `npx ng build console` in review — do not trust the agent's
  build claim for shared-model changes.
- The mission `recent` projection now includes spec `approved` outcomes, so a
  single request can appear twice in Recently (spec-approved, then shipped).
  Intentional — both are distinct signed decisions; revisit if it reads noisy.
- `OperatorIn.email` is a plain length-checked string (no EmailStr) to avoid a
  new dependency; the Studio form uses `type=email` client-side.
- The shared Api mutation methods keep an actor-shaped `string | number` compat
  signature; the `string` branch is now dead (all callers pass operator id).
  Cutover (016) should drop the compat overloads.
