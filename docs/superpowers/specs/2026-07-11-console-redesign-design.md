# Console redesign — "The Floor": a quiet, premium control room

**Date:** 2026-07-11
**Status:** Approved (user "ok", 2026-07-11). Visual direction approved via
mockup lab the same day: **Family** (intake Micron Atlas theme) — see §8,
which supersedes the original "Atelier" proposal.
**Provenance:** Wayfinder map `docs/wayfinder/console-redesign/map.md`.
Grounded in the reference study (`docs/wayfinder/console-redesign/assets/001-references.md`),
the current-state audit (`assets/002-current-state-audit.md`), and the
operator-workflows grilling (ticket 003). Remaining decisions were delegated
to the agent ("you decide everything and write spec").

---

## 1. What this is

A from-zero redesign of `apps/console` as a small engineering team's control
room for the automated AI software delivery platform. Not an admin panel, not
a dashboard, not mission-control cosplay — a **calm, premium instrument** that
a busy engineer opens a few times a day, understands in five seconds, acts in
one click, and closes.

Hard constraints carried forward, unchanged:

- Angular 22 (signals, standalone) + FastAPI. No framework migration.
- `progress_event` is append-only (ADR 0008). Nothing here mutates history.
- Single uvicorn worker. All coordination is in-process or in-DB.
- Two human gates (spec approval, merge approval) keep their semantics.
- Console only. Intake app untouched.

## 2. The decided operating model (from grilling)

| Decision | Value |
| --- | --- |
| Attendance | Notification-driven + check-ins. Nobody watches. |
| Job ranking | Gates → triage → fleet glance → steer → history → numbers |
| Notification channel | Email, deep links; fires **only** when a human is needed |
| Gate decisions | Fully in-console via evidence card; GitHub = escape hatch |
| Recovery verbs | Retry stage · send back to stage · take over · cancel |
| Coordination | **No claims.** First decision wins; loser gets explicit conflict feedback |
| Steering | Real: runner consumes steer notes at stage boundaries + acks |
| Scale | 1–5 concurrent runs — rich cards, not dense tables |
| Metrics | Three honest numbers on the home; no analytics surface |
| History | Per-request only, decided-by (who + when) on every decision |

## 3. Design principles

1. **Attention first.** The first pixel answers "does anything need me?"
   Healthy throughput never outranks an actionable item.
2. **Five-second catch-up.** An operator returning after four hours must
   grasp the whole factory state without scrolling or clicking.
3. **Alarm color budget (ISA-101).** The surface is quiet, near-monochrome.
   Saturated color appears only on actionable state, and color is never the
   only carrier (icon/shape/text redundancy).
4. **Evidence before action.** Every irreversible button sits on a card that
   shows what will happen, to what, proven by what.
5. **Never lie.** No optimistic state another browser can't see; freshness is
   data; real-runner limitations are labeled until fixed, then removed.
6. **One action grammar.** The same verbs (approve, send back, retry, take
   over, cancel, steer) look and behave identically everywhere they appear.
7. **Not a traditional app.** No dashboard grid, no sidebar-of-modules, no
   badge soup. The console reads like a living editorial broadsheet about
   your factory — typography does the hierarchy work chrome usually does.

## 4. Information architecture — from zero

The June IA (Mission / Map / List / Queue / Inbox / Feed / Registry /
Settings — eight surfaces) collapses to **four**. At 1–5 concurrent runs,
splitting attention across eight screens is the problem, not the solution.

| Surface | Route | Job |
| --- | --- | --- |
| **The Floor** (home) | `/` | Catch-up, gates, triage, steer, glance, numbers |
| **Dossier** | `/requests/:id` | One request's full story + all actions |
| **Library** | `/library` | Every request past and present; the only list |
| **Studio** | `/studio` | App registry + operator profile + notification prefs |

Killed surfaces and where their jobs went:

- **Mission control** → becomes The Floor (it was the right idea; it is now
  the *only* home, not one tab among eight).
- **Factory map** → cut. The 1,200-line cockpit component and its visual
  exception (ADR 0016) don't survive at this scale. Its one good idea —
  seeing runs move through stages — reappears as the **Assembly Line** strip
  on The Floor (§5.2).
- **Gates queue + Needs me (inbox)** → redundant with a truthful Floor; both
  cut. Deep links from email land on the Dossier's gate card directly.
- **Per-app Activity feed** → cut as a surface. Comments live on the Dossier
  timeline; per-app filtering lives in the Library.
- **Settings + Registry** → merged into Studio; settings become real
  (persisted per operator) instead of a non-persistent preview.

**Navigation:** no sidebar. A slim top hairline bar: wordmark (→ Floor),
Library, Studio, the operator's mark, and a search/command affordance.
`⌘K` command palette and the existing `G` chords carry power users; every
surface is one keystroke away. Wildcard and legacy `/admin/*` routes redirect
permanently to the new routes.

## 5. The Floor — the home surface

One vertical, editorial page. Not a grid of widgets — a **narrative in three
acts** with a masthead. Typography scales with consequence: the more the
factory needs you, the larger the page speaks.

### 5.1 Masthead

A thin strip: factory wordmark, date, runner mode (real/simulated — fixed to
read the actual health value), data freshness ("live · synced 4s ago"), and
the three honest numbers as quiet tabular figures: *shipped this week ·
median cycle time · median wait-on-human*. No cards, no borders — set like a
newspaper's folio line.

### 5.2 Act I — "Needs you"

The attention block. When empty, it collapses to a single serene line
("Nothing needs you — 3 requests in motion") and Act II rises up the page.
When occupied, each item is a full-width **evidence card**:

- **Gate card** (spec or merge): requester, request title, app; the evidence
  — grounded spec lines for spec gates, diff summary + verification results
  (tests run, pass/fail, checks) for merge gates; the side-effect sentence in
  plain words ("Approving merges PR #42 into main and deploys"); actions:
  Approve / Send back (with note). Keyboard: J/K/Enter/A/S preserved.
- **Triage card** (failure or stall): what stopped, at which stage, the last
  meaningful event, seconds-stalled as text; the four recovery verbs — Retry
  stage / Send back to stage… / Take over / Cancel — each stating its blast
  radius before confirming.

Conflict feedback (no claims): if another operator acts first, the card
resolves in place to a quiet outcome line — "Approved by Kim P. · 14:02,
while you were reading" — never a silent disappearance, never a raw 409.

### 5.3 Act II — "The line"

The Assembly Line: in-flight runs rendered as horizontal **lanes**, one per
request — the creative centerpiece. Each lane is a thin luminous track
spanning the six stages; a subtly animated bead travels it, positioned by
the run's current stage and step. Under each lane: request title, app, stage
label, step m/of n, health as a shape+word (never color alone), and time
since last signal. Inline steer: a single restrained input on the focused
lane; a sent note shows "queued" until the runner's ack event flips it to
"heard ✓ at step 4" — server truth, not local optimism. A lane whose run
goes quiet (no signal) dims and states it plainly. Clicking a lane opens the
Dossier. With zero runs, the line becomes a flat resting track with a
one-line invitation to the intake app — an empty state with dignity.

### 5.4 Act III — "Recently"

The last ~10 outcomes as one-line entries: outcome word (Shipped / Sent back
/ Cancelled), title, decided-by, relative time. Set small. Links to Dossiers.

## 6. Dossier — one request's story

Replaces Request detail. Three-layer drill-down made literal:

1. **Header:** title, app, requester, state as a sentence ("Waiting on merge
   approval since 13:40"), and the same action verbs as The Floor.
2. **Timeline (semantic layer):** the request's life as chapters — stages,
   gates, human decisions, escalations, comments — every consequential entry
   carrying **decided-by + timestamp** (rendered from the existing
   `gate_event`/audit actor data the UI currently ignores). Steer notes
   appear with their ack state. Comments compose inline on an explicit
   target — no implicit active-request selection.
3. **Evidence drawer (raw layer):** any timeline chapter expands to its raw
   events, verification payloads, and attachments, deep-linkable. Raw is
   never the navigation; it is always one layer beneath meaning.

## 7. Library and Studio

**Library:** every request, newest first, as compact rows (this is the one
place density wins): state word, title, app, decided-by/updated, cycle time.
Filter by app and state via query params (fixing the broken Map→List
handoff pattern properly this time). No grouping ceremony at this scale.

**Studio:** app registry cards (create/update, honest about what
"verification" means); operator profile (pick or create your named profile —
see §9); notification preferences (persisted server-side per operator: which
apps email you, defaulting to all).

## 8. Visual identity — APPROVED: "Family" (intake theme)

**Decision (2026-07-11, mockup lab):** after reviewing four labs the user
chose **Family** — the console adopts the intake app's Micron Atlas design
language verbatim, so both apps read as one product. Reference lab:
`mockups/console-floor-family.html` (The Floor, light + dark, verified at
1440/390). Concretely:

- Tokens from `apps/intake/src/styles.css`: light `#faf9fb` canvas +
  graphite dark, white cards, hairline borders, small radii (4/6/10 px),
  shadows for overlays only.
- **Micron purple** is the one accent (interactive/identity); status stays
  amber = gate, red = needs-human, green = success — at most one amber and
  one red block per surface.
- Type: Micron Basis (display + body), JetBrains Mono for data, tabular
  numerals.
- Voice: friendly plain language — greeting headline ("Good afternoon, Jun.
  Two things need you."), consequence sentences ("Approving will merge PR
  #87 into main and deploy Payroll."), no uppercase shouting.
- Lanes: soft rounded rails with one purple traveling bead; health by
  shape + word, never color alone.
- Dossier/Library/Studio inherit this direction directly — no further
  mini-labs.

The original proposal below is kept for the record; it was **not** chosen.

<details><summary>Superseded: "Atelier" (original proposal)</summary>

- **Typography as chrome.** An expressive editorial display face for state
  headlines ("Nothing needs you.") set very large; a precise grotesque for
  UI; tabular numerals everywhere data breathes. Hierarchy comes from scale
  and weight, not boxes.
- **Surfaces.** Warm paper white / deep ink dark (both first-class). Cards
  are near-flat: hairline borders, one soft ambient shadow level, generous
  radius. No glassmorphism, no neon, no CRT.
- **Color budget.** Near-monochrome base. Exactly one signal hue —
  **factory amber** — reserved for needs-you states, plus a quiet green-ink
  for shipped and a dry red for failure, all duplicated by icon/word. Healthy
  running state earns *no* color: motion carries "alive".
- **The wow, earned:** the Assembly Line's traveling beads and breathing
  tracks; the headline that types itself on state change; number transitions
  that roll like a flip clock; the light/dark themes as "day shift / night
  shift" with a sunrise-tinted transition. All animation ≤ 300 ms,
  interruptible, honoring `prefers-reduced-motion`.
- **Anti-goals** (from the reference study): mission-control cosplay, badge
  soup, dashboard grids, wall-of-logs, decorative sparkle that outshines the
  one thing that needs attention.

</details>

## 9. Multi-operator model (decides ticket 006)

Small team, equal roles, trusted network. Proportionate mechanism:

- **Named operator profiles, server-side.** An `operator` table (id, name,
  initials, hue, email, created_at). First visit: pick your profile or
  create one; choice persists in a cookie/localStorage *pointing at the
  server row*. No passwords now; the seam is shaped so Entra can replace
  profile-picking later without touching call sites. The hard-coded shared
  "Kim P." mock dies.
- **Actor on every mutation** comes from the selected profile and is stored
  (as today in `gate_event`/audit) and now **rendered** everywhere as
  decided-by.
- **Conflicts, not claims.** All state-changing endpoints become
  conditional: they compare-and-set against current status (extending the
  spec-approval CAS to merge approval, send-back, retry, take-over, cancel)
  and on losing return a structured conflict — `{acted_by, acted_at,
  resulting_state}` — which the UI renders as the in-place outcome line.
  No leases, no presence, no claim endpoints.
- **Per-operator notification prefs** keyed to the operator row.

## 10. Backend additive work

All additive; no `progress_event` mutation; single worker preserved.

1. **Operator identity** — `operator` table + CRUD (`GET/POST /api/operators`);
   mutations take `operator_id`, server resolves actor.
2. **Conditional mutations** — CAS on all gate/recovery endpoints; structured
   409 conflict payload.
3. **Gate-decision projection** — expose `decided_by`, `decided_at`, outcome
   per gate on the request detail payload (data already persisted; audit §5).
4. **Take-over endpoint** — marks the request human-owned, stops runner work,
   emits an audit + timeline event.
5. **Send-back-to-stage endpoint** — returns an escalated run to a chosen
   earlier stage with reason; distinct from submitter send-back.
6. **Real-runner `step_summary`** — the runner emits step summaries per stage
   so real runs get honest lane position/health (kills permanent "step 0,
   no signal").
7. **Real-runner steer consumption** — reads pending steer notes at stage
   boundaries, includes them in the stage prompt, writes `acked_steer_ids`
   in its next step summary. Notes are never mutated.
8. **Email notifications** — on gate-raised / escalation / stall detection,
   send email (SMTP config via env) to operators subscribed to that app,
   with a deep link to the Dossier. Only needs-human events email; a dead
   SMTP config degrades to log-only, visibly noted in Studio.
9. **Projection freshness** — keep the 4 s cursor poll; additionally bump the
   version on mutations that emit no progress event (registry, operator,
   preference writes) via a lightweight revision counter, so no browser
   shows stale state silently.
10. **Runner-mode health fix** — shell reads the real `runner_mode()` values.

Explicitly **not** built: claim/lease API (decision §9), cross-request audit
surface, analytics store, RBAC, WebSockets (polling is sufficient at this
scale and respects the single-worker invariant).

## 11. Verification plan

- `make verify` green (lint, pytest, vitest, Angular build, smoke) — gate for
  every merge, output shown before merging (user rule).
- New API behaviors covered by pytest: CAS conflicts (both winners and
  losers), take-over, send-back-to-stage, steer ack round-trip via simulator
  and via a faked runner, email trigger selection, operator CRUD.
- Visual proof matrix per surface: 1440 px and 390 px, light and dark —
  screenshots in the PR/notes (user rule).
- Keyboard pass: palette, chords, gate J/K/Enter/A/S, focus visible, escape
  routes; `prefers-reduced-motion` verified.
- Honesty checks: pull the network mid-session → freshness indicator degrades
  truthfully; act from a stale browser → conflict line renders.

## 12. Build & cutover strategy

1. **Mockup lab first** (wayfinder ticket 005): 2–3 static HTML labs of The
   Floor in the Atelier direction (light + dark, 1440/390). **User approval
   gates everything downstream.**
2. Work on a worktree branch (`console-redesign`), small green commits.
3. Backend additive slices land first (identity, CAS, projections, runner
   events) — they are invisible to the old UI and independently testable.
4. New surfaces are built **in place of** the old routes at the end of the
   branch (parallel-build-then-cutover inside one branch; no long-lived dual
   console). Old components and dead routes/tokens are deleted in the same
   branch — disposable by audit §9.
5. ADR: one new ADR ("Console IA: The Floor") superseding the relevant parts
   of ADR 0015/0016; ADR 0008 untouched.
6. `make verify` + visual matrix before merge; merge only after user reviews
   output. No commit/push without an explicit ask.

## 13. Out of scope

Intake app changes · framework migration · RBAC/auth beyond named profiles ·
multi-worker scaling · cross-request analytics · claim/lease coordination ·
Slack/chat integrations (email only, this round).
