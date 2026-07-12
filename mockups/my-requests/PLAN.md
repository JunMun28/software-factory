# PROTOTYPE — My Requests revamp (5 directions)

> **Throwaway.** Answers one question: *what should the submitter's "My requests"
> page look like so they instantly know where each request is, what happens next,
> and whether anything needs them?* When a direction wins, fold it into
> `apps/intake/src/app/submitter/my-requests.ts` and delete this folder.

**Live target:** `/requests` (`sf-my-requests`) — currently: h1 + "New request"
button, Active/All segmented filter, an amber "Needs your input" band for
sent-back requests, then a flat list of rows (title, type chip, app · age,
plain-stage pill at right).

**View at:** `http://localhost:4456/my-requests/` (`mockup` launch config).
`index.html` = iframe switcher (`?v=1..5`, ← → keys, floating bar, cache-busted
loads) — copy the harness pattern from `mockups/basics-form/index.html`.

---

## Critique of the current page

1. **Flat and mute** — every request is an identical row; the only state signal
   is one pill on the right. Nothing answers "how far along is it?".
2. **No journey** — submitters think in package-tracking terms ("where is my
   thing?"), but there's no visual progress from Submitted → Live.
3. **No grouping or priority** — building, waiting, and shipped requests
   interleave; the needs-input band helps but everything else is one bucket.
4. **No payoff** — nothing celebrates shipped requests or shows accumulated
   value (hours saved). The factory feels like a black box.

## Submitter plain-stage vocabulary (MUST use; never Control-center words)

Submitted → Spec drafted → Building → In review → Deployed;
plus **Needs your input** (amber, sent-back; reviewer has a question) and
Cancelled (neutral, struck). Types: Bug fix / Enhancement / New app / Other.

## Sample data (all variants use this same set)

| # | Title | Type | App | Stage | Age |
|---|-------|------|-----|-------|-----|
| 1 | Quality-line issue tracker | New app | — | **Needs your input** — reviewer asks: "Should supervisors see each other's lines, or only their own?" | 2h |
| 2 | Maintenance window scheduler | New app | — | Building | 1d |
| 3 | Shift handover notes in Atlas | Enhancement | Atlas | In review | 3d |
| 4 | Label printer alignment fix | Bug fix | PrintFlow | Spec drafted | 5h |
| 5 | Vendor onboarding checklist | New app | — | Submitted | 20m |
| 6 | Downtime dashboard | New app | Downtime dashboard | Deployed | 2w |
| 7 | Rework photo capture | Enhancement | QC Capture | Deployed | 1mo |
| 8 | Old exports cleanup | Other | — | Cancelled | 3w |

Impact garnish where a variant wants it: #2 "~340 h/yr", #3 "~120 h/yr",
#6 "~500 h/yr, in use by 2 teams".

## Shared scaffolding (every variant)

Identical to `mockups/basics-form/PLAN.md` "Shared scaffolding", in short:
- Standalone HTML, no build, vanilla JS, inline CSS. Space Grotesk + JetBrains
  Mono (Google Fonts).
- Tokens copied from `mockups/intake-submission-redesign.html` (`:root` light /
  `.dark` dark, default **dark**, working ☀/☾ toggle).
- Identical shell top bar (3×3 dots mark + "Software Factory", nav pills — here
  **"My requests" is the active one**, theme toggle, JD avatar). Page content
  below is fully yours per variant. Max width can go wider than 760px where the
  design needs it (board/table variants).
- Responsive at 1440 and 390. `prefers-reduced-motion` respected.
- Collapsed mono JSON **state pill** bottom-left showing `{variant, filter,
  openRequest}` — updates on every interaction.
- Row/card click just flashes the state pill (no detail page in the mockup).
  "New request" button + a Respond affordance on #1 must exist in every variant.

## The 5 variants (structurally different — layout/hierarchy, not colour)

### v1 — `v1-pipeline-board.html` — Kanban by plain stage
Three to four columns in submitter language: **Your turn** (amber, #1 with the
reviewer's question + Respond button) · **With the factory** (#2–#5, each card
showing its stage pill and a thin stage progress bar) · **Live** (#6–#7, green,
with "in use" garnish) · collapsed **Archive** rail (#8). Cards are compact
(title, type chip, app, age). Column counts in headers. At 390px the columns
become stacked accordion sections.

### v2 — `v2-journey-tracker.html` — Package-tracking rows
Each request is a card with a horizontal **milestone track**: Submitted →
Spec → Building → Review → Live; nodes lit up to the current one, the active
node pulsing, Needs-input renders as an amber interrupt node with the question
underneath. The mental model is parcel tracking. Deployed rows show a
celebratory filled track. Filter: All / Moving / Done chips. 390px: track
compresses to dots + current-stage label.

### v3 — `v3-inbox-split.html` — "Your turn" inbox + grouped feed
Two zones. Top: **Your turn** — big amber card(s) with the reviewer's actual
question quoted, inline reply textarea + "Send answer" (fake), Respond button.
Below: **In the works** — compact rows under sticky group headers "Building
now" / "In review" / "Waiting to start" / "Recently shipped" (collapsed
Cancelled group at the bottom). Inbox-zero feel: when nothing needs you, the
top zone is a quiet green "Nothing needs you" strip.

### v4 — `v4-status-wall.html` — Dense dashboard + table
Top: four stat tiles — **In flight 4 · Needs you 1 · Shipped 2 · ~960 h/yr
back** (computed from sample data). Below: a dense, scannable table: Request /
App / Stage (mini progress bar + label) / Updated / Next step ("Reviewer
approval", "Agents coding", "—"). Search input + type filter chips (All ·
Bug fix · Enhancement · New app). The power-user direction for someone with
dozens of requests. 390px: table rows collapse to two-line cards.

### v5 — `v5-living-cards.html` — Ambient status grid
Two-column masonry-ish grid of rich cards where **state is ambient, not a
pill**: Building cards carry an animated working shimmer + "Agents are writing
code right now"; In-review a slow pulsing purple ring; Submitted/Spec a quiet
dotted border; Deployed a green glow + "Open it →" affordance + impact line;
Needs-input glows amber with the reviewer's question and a Respond button;
Cancelled is dimmed/struck. The factory feels alive. All motion respects
reduced-motion (falls back to static badges).

## Switcher harness — `index.html`

Same as basics-form: full-viewport iframe, `?v=1..5`, floating high-contrast
pill bottom-center (← `3 / 5 — Inbox split` →), arrow keys in parent AND
forwarded from inside the iframe (capture + stopPropagation, skip when an
input/textarea/contenteditable has focus), `history.replaceState`, iframe src
cache-busted with `?t=Date.now()`.

## Execution protocol

Claude subagents are dead this month (spend cap — confirmed 2026-07-11), so:
- **Builders: codex gpt-5.5** (`codex exec`), one background run per variant
  file, each given this PLAN plus its variant spec. The taste lives in the
  specs; codex executes them.
- Fable (main agent) builds nothing but verifies everything in the browser
  (1440/390, dark/light, interactions), fixes small breakage directly, and
  screenshots for the user.

## Deviations

- 2026-07-11: The first batch of 5 background `codex exec` runs hung at startup
  (0.06s CPU after 30+ min, zero usage consumed — user caught it). Root cause:
  background runs block without a stdin redirect. Fix: relaunch with
  `</dev/null`; all 5 then completed normally. **Rule for future runs: always
  `codex exec ... </dev/null` when backgrounded.**
- The harness's iframe 404 (variants not yet written) looked like a broken
  page; index.html now HEAD-probes and shows a "still building, auto-retries"
  placeholder instead.
- Verified by Fable in-browser: all 5 render dark 1440; interactions confirmed
  (v1 board, v2 Done filter, v3 send-answer collapse, v4 search+type filter,
  v5 ambient states); 390px spot-checked on v1/v4/v5 (no overflow); light mode
  spot-checked on v2; consoles clean. The variant-switcher sometimes advances
  by itself ONLY under the agent browser pane (tool-injected arrow keys) — not
  reproducible for a human user.

### Fold-in deviations (2026-07-12, v3 → my-requests.ts)

- The prototype's inline "Send answer" faked the send; the real fold-in wires it
  to `api.respond(id, note, name)` (confirmed end-to-end: sent_back →
  pending_approval, send_back_response persisted). `send_back_question` lives on
  the list item `FactoryRequest`, so no extra fetch is needed.
- Added an "answered this session" set so a just-answered card stays pinned in
  the "Your turn" zone as the green strip — otherwise the fast poll drops it out
  of sent_back before the confirmation shows. Answered ids are also excluded from
  the feed groups (no duplicate row).
- Dropped the old Active/All segmented filter — the group structure
  (Building now / In review / Waiting to start / Recently shipped + collapsed
  Cancelled) replaces it. "Building now" is hidden when empty (empty groups drop).
- Added a my-requests.spec.ts (none existed) covering grouping, turn-zone,
  respond wiring, and answered-pinning; matchMedia stubbed for the SubShell/Theme
  construction in the test DOM.
- Testing mutated the local dev DB: requests 4 and 8 were answered (moved
  sent_back → pending_approval).

## Verdict

**Winner: v3 — Inbox split** (user, 2026-07-11: "use v3"). Fold into
`apps/intake/src/app/submitter/my-requests.ts`: "Your turn" zone on top
(amber card, reviewer's question, Respond affordance; quiet green
"nothing needs you" strip at inbox-zero), grouped feed below under
"Building now / In review / Waiting to start / Recently shipped" +
collapsed Cancelled. Keep the own-fetch + plainStage + reporter-scoping.
Open question resolved during fold-in: whether the reviewer's question
text exists on the request, and whether the inline answer box wires to a
real respond flow or just navigates to /requests/:id. Delete this folder
once the live page is approved.
