# AIRES — End-to-End Browser Test Plan

**Date:** 2026-07-13 · **Status:** plan (not yet executed) · **Driver:** agent browser (`mcp__Claude_Browser__*`)

**Purpose:** Exercise every section of both apps through the real UI, following how an actual user moves through the product from first idea to shipped change — with special depth on the new adaptive-Tracks intake flow (ADR 0023). This is a manual/agent-driven acceptance pass on top of the automated gate (`task verify`: unit + component + smoke lifecycle), not a replacement for it.

**What "the app" is:** two independently-deployed Angular apps sharing one FastAPI backend.
- **Intake** (Submitter world) — the front door: describe → classify → basics → interview → (prototype) → review → submit → track.
- **Console** (Admin world) — mission control: approve specs, watch runs, approve the merge and deploy gates, manage the app registry.

---

## 1. Environment setup

### 1.1 Servers (mind the shared server-slot cap)
The harness caps dev servers at **5 per folder**, shared across all chat sessions. A full run needs **3**: `api`, `intake`, `console`. Before starting, run `preview_list` and confirm enough free slots; if other sessions hold them, ask the user to free slots first.

| Server | launch.json name | Port | Notes |
|---|---|---|---|
| Backend | `api` (or a scratch config) | 8000 | For deterministic runs prefer `FACTORY_BRAIN=scripted` + `FACTORY_INTERVIEW_PREGEN=sync` (fast, no model calls, stable questions). Use `FACTORY_BRAIN=agent` only for a realism pass. |
| Submitter UI | `intake` | 4201 | ng serve, proxies `/api` → api port |
| Admin UI | `console` | 4202 | ng serve, proxies `/api` → api port |

Start via `preview_start` (never Bash). If a port is held by another chat, add a scratch config on a free port and repoint that app's `proxy.conf.json` at the matching api port; revert after.

### 1.2 Data & preconditions
- Fresh DB (or a known seed) so counts/empty-states are predictable. Note the seed used.
- App registry has ≥2 registered apps (for the bug/enh "Which app?" picker and the registry tests).
- One Admin identity with a linked GitHub account is assumed for gate approvals; if gates can't be driven live (no GitHub), mark those steps **Verify-at-API** and assert via the endpoints instead.

### 1.3 Browser-agent conventions (apply to every case)
- Prefer `read_page` (accessibility tree, returns refs) over screenshots for asserting text/structure; use `computer{screenshot}` only for visual proof.
- After each navigation: `read_console_messages` (onlyErrors) and `read_network_requests` — **zero console errors and no failed (4xx/5xx) API calls** is a pass gate for every screen.
- Drive by ref (`computer` with `ref_N` from read_page) where possible, not raw pixels.
- Capture evidence at **two viewports** — desktop **1440×900** and mobile **390×844** — and in **both light and dark** (`resize_window` with `colorScheme`, or the in-app theme toggle) for any case marked **[R]** (responsive/theme-sensitive).
- Respect reduced-motion: run one pass with `prefers-reduced-motion` to confirm animations degrade (chip pulse, ring transitions, blur-ins).

### 1.4 Pass/fail & reporting
Each case records: **status** (pass/fail/blocked), the asserted expectation, evidence (screenshot filename / read_page excerpt / network entry), and any console error. A suite passes only if every case passes AND no screen produced a console error or failed request. Final report = a table per suite + the full start-to-finish journey verdict + a screenshot gallery (light/dark × desktop/mobile for the headline screens).

---

## 2. Suite A — Intake submitter journey (the core user path)

The primary user is a non-technical Submitter. Suite A walks their journey and covers every new adaptive-Tracks behavior.

### A1 — Describe / composer (`/submit/new`)  [R]
Precondition: fresh session at `/`.
1. Navigate `/` → assert redirect to `/submit/new`; hero heading "What should we build?" and the animated composer render.
2. `read_page` the composer; assert placeholder, the attach (+) button, and the send/continue arrow.
3. Type a description; assert the textarea auto-grows and the "Press ⌘↵/Ctrl↵ to continue" hint.
4. **Attachments:** click + and attach a file → chip appears; drag-drop a file onto the page → chip appears; paste an image → chip appears; remove a chip → it disappears. (Use small local test files.)
5. **Keyboard submit:** ⌘↵ (or Ctrl↵) with empty text → focus returns, no navigation; with text → proceeds.
6. Evidence: light+dark, desktop+mobile screenshots of the hero.

### A2 — Classification + Track chip (`/submit/:id/interview` intro)  [R]
Covers ADR 0023 classify-on-Continue + chip states. Run four sub-flows (fresh request each):
1. **Confident bug** — describe "the export button is broken and throws an error", Continue. Assert: lands on the interview intro; the Track chip reads **Fix a problem · quick path**; the type cards are **collapsed** behind the chip (`.typegrid` absent).
2. **Confident new app** — "build a brand-new scheduling tool from scratch". Assert chip **Build a new app · full session**, cards collapsed.
3. **Unsure** — "not sure yet, need to think about it". Assert chip in **unsure** state ("What kind of request is this?") and the type cards **open** (`.typegrid` present).
4. **Correction** — from a confident bug, click the chip → cards expand; pick "Improve an app" → chip updates to the enhancement label, cards collapse, and the basics sections re-shape (app picker + who-benefits + winning).
5. Assert the chip shows **qualitative weight only** — never minutes or step counts.
6. Evidence: chip confident vs unsure, light+dark.

### A3 — Basics per-track + lossless correction (`/submit/:id/interview` intro)  [R]
For each type, assert the correct sections render and can be answered:
1. **Bug:** Which app? (registry combobox + "add new") · Show us where (paste a link; add a screenshot; paste a screenshot) · How often (frequency cards). Later sections stay locked/blurred until earlier ones are answered.
2. **Enhancement:** Which app? · Who benefits? (concentric-rings blast-radius picker — click each ring, assert the live people count + scope readout; free-text "describe the group") · What would winning look like? (impact cards → estimate input appears only after a card is picked).
3. **New app:** Who feels it if this works? (rings) · What would winning look like? (impact).
4. **Something else:** Who is this for? · Good outcome.
5. **Lossless correction (live):** on an enhancement, set app + reach + impact; switch type to bug via the chip, set frequency; switch back to enhancement → assert reach + impact are still populated (no data loss), matching the ADR 0023 invariant. Cross-check the request via `read_network_requests` PATCH bodies.
6. **Gating:** "Start the interview" with incomplete basics → assert the nudge ("Add the missing details"); complete → proceeds.
7. Evidence: rings picker + impact cards, light+dark, desktop+mobile (rings/impact restack on mobile).

### A4 — Adaptive interview (`/submit/:id/interview` full)  [R]
1. Start the interview → assert the two-beat reveal (basics settle, then chat + live plan animate in) and the "thinking"/streaming indicator, then Q1 appears in the thread.
2. **Docked options panel:** a question with options renders choice chips; ↑↓ moves the highlight, Enter selects; hovering highlights; clicking answers. Assert the answer renders as the user bubble and the next question arrives.
3. **Free text:** the "Something else…" inline row and the composer both accept typed answers; Enter submits, Shift+Enter newlines.
4. **Skip:** skip a question → assert a "Skipped" bubble and progression.
5. **Attachments mid-interview:** attach/drag/paste a file into the composer → chip appears (image thumbnail for images).
6. **Live plan panel:** assert the right-hand plan/facts strip updates as answers land (the collected basics facts show; the plan refreshes after each answer).
7. **Per-track depth:** bug reaches "done" within its short ceiling; a new app keeps asking (uncapped).
8. **Conversational stop (new-app):** on a new-app interview, type "that's enough" → assert the interview ends ("Thanks — that's everything…") and advances. Then confirm a **legitimate** answer that merely contains stop words ("no more than 5 users") does **not** end it (the false-positive fix).
9. **Escalation (contract):** the auto-proposal generator is a deliberate seam (returns none today), so a proposal won't surface in normal runs. Verify the contract instead: if a proposal can be injected (test hook / seeded state), assert the chip pulses, the in-chat "switch to …" bubble shows Switch/Keep-as-is, Switch changes the type and re-shapes the flow, Keep-as-is leaves it. If not injectable via UI, mark **Verify-at-API** (accept/decline endpoint) and note the UI path is component-tested.
10. **Done → next step:** interview completion auto-advances — to **prototype** for a new app, else **review**.
11. Evidence: interview thread + docked panel + live plan, light+dark, desktop+mobile (panel stacks under the thread on mobile).

### A5 — Prototype step (`/submit/:id/prototype`, new-app only)  [R]
1. Reach it via a new-app request. Assert the first mock generates (thinking → renders) and displays in an iframe/sandbox.
2. **Chat edits:** type an instruction ("make the header green") → assert a revision applies and a chat turn records.
3. **Point-to-edit:** open the inspector, click an element in the mock, issue a scoped edit → assert only that element changes.
4. **Undo/restore:** restore an earlier revision → assert the document reverts as a new latest revision.
5. **Skip (soft gate):** skip the prototype → advance to review with none attached.
6. **Full-screen view** opens and closes.
7. Confirm a non-new request never exposes prototype (route guard / redirect).
8. Evidence: prototype + inspector, light+dark.

### A6 — Review (`/submit/:id/review`)  [R]
1. **Compact (short tracks):** for a bug/enh/other, assert the `.review--compact` layout — a concise "what the factory understood" card + the shared "what happens next" footer + submit.
2. **Full (new app):** assert the two-column spec + prototype aside; NOT compact.
3. **Summary generation:** the AI-written spec (overview + sections) renders (thinking → content) via the summary endpoint.
4. **Add more detail:** click Add more → reopens the interview for a follow-up, then returns to review.
5. **Edit details:** the "Edit details" path returns to the composer/basics without losing data.
6. **Submit:** click Submit request → assert navigation to `/submit/:id/done` and the POST /submit succeeded (network).
7. Evidence: compact vs full review side by side, light+dark, desktop+mobile.

### A7 — Confirm / done (`/submit/:id/done`)
1. Assert the confirmation screen, the request ref, and the two actions: **Track this request** (→ request detail) and **File another** (→ `/submit/new`, draft reset).
2. Click each and assert navigation + that a new compose starts clean.

### A8 — My Requests + submitter detail (`/requests`, `/requests/:id`)  [R]
1. `/requests` → assert the list shows the just-filed request with status/stage and last event; empty state renders correctly on a fresh account.
2. Open a request → `/requests/:id` submitter detail: assert title, type chip, status, the spec/summary, attachments (open one), and the progress timeline/events.
3. Assert the top-nav "New request" / "My requests" toggle and the brand click both route correctly.
4. Evidence: list + detail, light+dark, desktop+mobile.

---

## 3. Suite B — Console admin journey

Primary user: an Admin running the factory. Cover every admin section.

### B1 — Mission control (`/admin/mission`, default)  [R]
Navigate `/` on the console → assert redirect to `/admin/mission`. Assert the mission overview renders (in-flight work, gates needing attention, counts) with no console errors. Evidence light+dark.

### B2 — Approval queue (`/admin/queue`)  [R]
1. Assert the queue lists requests parked at a gate. Select one at `approve_spec`.
2. **Read the draft spec** + the assumptions ledger; toggle "show original".
3. **Triage assumptions:** mark assumptions ok/no; "accept all"; assert the triage state.
4. **Duplicate hint:** if a duplicate is flagged, "Compare" opens the other; dismiss it.
5. **Approve spec:** click Approve spec → confirm modal → approve → assert status advances (→ architecture) and the item leaves the spec-gate queue.
6. **Send-back:** on another spec-gate item, Send back with a note → assert it moves to sent-back and the submitter is notified (network/event).
7. Evidence: queue + approve modal, light+dark.

### B3 — Admin request detail (`/admin/requests/:id`)  [R]
1. Open a request. Assert header (ref/title/type/status/stage) and the run state.
2. **Views:** toggle **trace** and **map** views of the run; assert each renders.
3. **Recovery/steer:** for a stalled/running item, add a steer note; **Retry stage** with a note.
4. **Cancel:** cancel a non-terminal request (confirm) → assert cancelled state.
5. **Timeline:** assert the two-axis progress/event rail renders, including steer notes and milestone summaries; comments post.
6. Evidence: detail trace + map, light+dark.

### B4 — Merge gate + deploy gate
1. Drive a request through to `approve_merge`. In the queue/detail, **Approve merge** (confirm modal) → assert it deploys/advances.
2. Drive to the deploy/production gate → **Approve** → assert deployment milestone in the log.
3. If GitHub-backed approvals can't run live, mark **Verify-at-API** (the `/approve` endpoints) and assert via network + the smoke test's coverage.

### B5 — Factory map (`/admin/map`)  [R]
Assert the spatial map lens renders work items across stages; hovering/clicking a node opens its detail; the cockpit/exception affordances work. Evidence light+dark, desktop+mobile.

### B6 — Needs-me inbox (`/admin/inbox`)  [R]
Assert the inbox lists items needing the Admin (gates, sent-backs, stalls); clicking one deep-links to its detail/gate. Empty state renders when nothing needs attention.

### B7 — App registry (`/admin/registry`, `/admin/apps/:key`)  [R]
1. Assert the registry lists apps (name → repo/owner). Add a new app; edit one; mute/unmute one.
2. Open an app dossier (`/admin/apps/:key`) → assert its requests/history render.
3. Assert a newly-registered app then appears in the intake "Which app?" picker (cross-app check).

### B8 — Settings (`/admin/settings`)  [R]
Assert settings render and a benign toggle persists across reload. Theme toggle here flips light/dark app-wide.

---

## 4. Suite C — Full lifecycle (start to finish, one request)

The headline journey — one request from idea to production, crossing both apps. Run with `FACTORY_BRAIN=scripted` for determinism.

1. **Submitter (intake):** `/submit/new` → describe an enhancement to a registered app → Continue → chip confirms **Improve an app** → basics (app + who-benefits rings + winning impact) → Start interview → answer 2 + skip 1 → **compact Review** → Submit → **done** screen with a ref.
2. **Submitter → tracks it:** "Track this request" → `/requests/:id` shows it at Triage/spec gate.
3. **Admin (console):** `/admin/inbox` shows the new spec gate → open the queue → read the draft spec + assumption → **Approve spec** → status advances to architecture; the factory runs stages 2–5 (scripted/sim) and parks at the **merge gate**.
4. **Admin:** **Approve merge** → merges; then the **deploy gate** → **Approve** → deployed; the two-axis log shows the deploy milestone.
5. **Submitter:** `/requests/:id` now reflects the shipped/closed state and the milestone history.
6. **Assert end-to-end:** every hop produced no console error and no failed request; the request's status transitions match the lifecycle; the append-only event log is intact (`?after=` cursor holds). Capture a screenshot at each hop.

A second lite pass: a **bug quick path** start-to-finish (describe broken feature → confident chip → evidence + frequency → short interview → compact review → submit → admin approve) to prove the shortest Track end to end.

---

## 5. Suite D — Cross-cutting

- **D1 Theme [R]:** toggle light/dark on every headline screen; assert tokens flip and nothing hard-codes a color (no unreadable text). Both apps.
- **D2 Responsive [R]:** 1440 and 390 on every headline screen; assert no horizontal body scroll, pills wrap, panes stack (interview plan, rings/impact, review columns).
- **D3 Accessibility:** keyboard-only pass through the submitter journey (Tab/Enter/↑↓, the interview's aria-live question region announces); focus-visible rings present; images have alt/aria. Run an axe-style check via `read_page` for missing labels.
- **D4 Reduced-motion:** with `prefers-reduced-motion`, assert the chip pulse, ring transitions, blur-ins, and Lenis smooth-scroll degrade to static.
- **D5 Error/empty states:** empty My Requests, empty inbox, a failed classify (stop the api briefly) → assert the composer still lets you continue (graceful degradation to type 'new'); a failed summary shows a retry/thinking, not a crash.
- **D6 Deep-link/reload:** reload mid-interview and mid-review (deep link to `/submit/:id/interview`) → assert the draft rehydrates and the correct phase shows.

---

## 6. Coverage matrix (sections → suite)

| Section / route | Covered by |
|---|---|
| `/submit/new` composer | A1 |
| classify + Track chip | A2 |
| `/submit/:id/interview` basics | A3 |
| interview chat / escalation | A4 |
| `/submit/:id/prototype` | A5 |
| `/submit/:id/review` | A6 |
| `/submit/:id/done` | A7 |
| `/requests`, `/requests/:id` | A8 |
| `/admin/mission` | B1 |
| `/admin/queue` | B2 |
| `/admin/requests/:id` | B3 |
| merge/deploy gates | B4, C |
| `/admin/map` | B5 |
| `/admin/inbox` | B6 |
| `/admin/registry`, `/admin/apps/:key` | B7 |
| `/admin/settings` | B8 |
| full lifecycle | C |
| theme/responsive/a11y/motion/errors | D |

---

## 7. Execution order & effort

1. Environment up (§1), smoke a health check on all three servers.
2. Suite A (submitter) — the deepest; the recent feature work lives here.
3. Suite C (full lifecycle) — proves the two apps connect.
4. Suite B (admin sections).
5. Suite D (cross-cutting) folded into A/B/C screens where possible (capture light/dark/responsive as you go rather than a separate pass).

**Known constraint:** the 5-dev-server cap is shared across chats. If it blocks running api+intake+console together, fall back to running api + one UI at a time, and use the **Verify-at-API** markers (classify, interview, escalate, approve, summary endpoints) for any gate that can't be driven in the browser — the automated `task verify` smoke test already covers the full backend lifecycle.

## 8. Deliverable of an execution run
A results doc: the coverage matrix with pass/fail per case, a screenshot gallery (headline screens × light/dark × desktop/mobile), the list of any console errors / failed requests found, and a one-line go/no-go verdict.
