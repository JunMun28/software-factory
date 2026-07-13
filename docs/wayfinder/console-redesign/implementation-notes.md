# Console redesign implementation notes

## Deviations

- Slice 7: no acceptance-criteria deviations. Simulator failures now escalate only the affected request and continue the rest of the tick; simulator, real-runner, and restart-orphan needs-human paths all send pings, while healthy steps and Done remain explicit non-triggers. Live 1440/390 light/dark browser inspection could not run because this sandbox rejects local server binds with `operation not permitted`. Focused Studio DOM tests cover the toggle list, revision-driven reload, and log-only status. Both required production builds were attempted with pinned Node 24.15.0 and aborted at `Building...` with exit 134 before Angular emitted a font or compilation diagnostic; `angular.json` was not changed.

- Slice 6: no acceptance-criteria deviations. Real-runner step summaries now emit at stage start, while the injected prompt and acknowledged steer ids are current, and the new shell maps the health endpoint's `runner` plus `cli` fields directly. The required production builds were attempted without changing `angular.json`, but both `npx ng build console` and `npx ng build intake` aborted in this sandbox with exit 134 immediately after `Building...` (including with pinned Node 24.15.0), before Angular printed a font or compilation diagnostic.

- Slice 5: no acceptance-criteria deviations from ticket 011. The real runner emits one minimal `step_summary` per agent-stage boundary (Architecture, RED, GREEN, Review); these events carry steer acknowledgements without attempting the richer per-step visibility or runner-mode badge reserved for slice 012.

- Slice 4: no acceptance-criteria deviations from ticket 010. The approved slice defines Take over as the terminal automation state `human_owned` (finish by hand), while the older CONTEXT.md vocabulary says a human may later hand control back; this slice implements the approved terminal state and does not add a separate hand-back verb. Human-owned requests use a dedicated signed mission projection in the Needs-you region so ownership stays visible without pretending the request is a gate, stalled run, or active automation.

- Slice 3: no product or conflict-contract deviations from ticket 009. Decisive audit rows gained a nullable `operator_id` pointer so self-replay is resolved by stable identity rather than a potentially duplicated display name; the existing additive SQLite migration path carries this onto established databases. Both production app targets disable Angular's build-time external font inlining so the required builds are hermetic; all other production optimization remains enabled and the existing font stylesheet import is unchanged.

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

## Slice 009 review pass (fable-5, 2026-07-13)

- Reverted codex's `angular.json` `optimization.fonts:false` on both prod
  targets — a sandbox-only build workaround (no network) that would ship a
  runtime external font fetch + FOUT. Builds pass with inlining in a networked
  env. Watch for this pattern: codex adapts build config to its sandbox.
- Behavior change (intended, more correct): cancelling a `done` request now
  returns 409 (was a 200 no-op) — you can't cancel shipped work; the operator
  gets a clear conflict instead of a silent success.
- The CAS is race-safe under the single-worker + SQLite write-serialization
  invariant: concurrent writers block on the row lock, so the second UPDATE
  sees the winner's committed state (or the rolled-back precondition on failure
  and legitimately becomes the new winner).

## Slice 010 review pass (fable-5, 2026-07-13)

- Fixed SendBackStageModal target list for pre-pipeline stalls (indexOf === -1
  gave a wrong non-empty slice); a 'spec'-stage stall now shows an honest empty
  state instead of options the backend rejects with 400.
- Codex left both prod builds unverified (its sandbox lacks network for fonts)
  but correctly did NOT touch angular.json this time. Builds pass here.
- `human_owned` is a status value (not a boolean) so the existing tick filter
  (status==approved) stops automation with no tick-loop edit — fewer moving parts.
- needsCount now includes human_owned, so the greeting counts a taken-over
  request as needing you (you are finishing it). Intended.

## Slice 011 review pass (fable-5, 2026-07-13)

- No fixes needed. Codex restructured the lane to valid HTML (article + inner
  title link, not an anchor wrapping a steer button) and updated the focusRow
  selector to match — a subtle correctness detail it got right on its own.
- The real runner emits step_summary only at stage boundaries this slice (to
  carry the steer ack). Slice 012 will enrich step_summary cadence/content and
  add the runner-mode badge — watch for overlap there.

## Slice 012 review pass (fable-5, 2026-07-13)

- No fixes needed. Confirmed the step_summary emission was MOVED to stage start
  (not duplicated — a double-emit would have spammed the trace). This is the
  actual fix for the permanent step-0/no-signal: run_state only sees a
  current-stage event once one exists, and slice 5 emitted it only after the
  (long) exec.
- Badge reads runner+cli honestly; the old admin-shell tested runner==='claude'
  which never matched (runner is agent|sim; the CLI is the claude|codex axis).

## Slice 013 review pass (fable-5, 2026-07-13)

- Fixed the notification deep-link default (4201 intake -> 4202 console). Only
  bites when CONSOLE_BASE_URL is unset (dev log-only), but it pointed operators
  at the wrong app.
- Escalation was centralized into lifecycle.escalate; verified the REAL runner's
  _escalate delegates to it (so real-run failures email, not just the simulator).
- The revision poll adds a second lightweight GET (cursor) per 4s tick via
  forkJoin, with catchError so freshness never breaks the ADR-0008 event path.
  Fine at 1-5 concurrent runs / single worker.
- A raw POST /api/requests with app_key does not link app_id (intake assigns the
  app later); a request with app_id=None emails no one. Not a slice-013 bug, but
  note it: pre-app requests don't ping.
