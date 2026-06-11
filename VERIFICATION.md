# Verification workflow

How to confirm the Software Factory app runs, nothing is regressed, and each
feature does what it claims. Three layers: **automated** (one command),
**guided manual flows** (10 minutes), and **what to look for** per improvement.

## 0. Prerequisites

- `uv` (Python deps auto-install on first run) · Node 20+ / npm
- Nothing else — no Azure, no GitHub App, no API keys. The LLM seam runs a
  deterministic scripted brain; the Stage 2–6 CI agents are stood in for by the
  simulator (see ADR 0009 in `docs/adr/`).

## 1. Automated — one command

```bash
make verify
```

Runs, in order — all must be green (the same chain runs in CI on every push,
see `.github/workflows/ci.yml`):

| Step | What it proves |
|---|---|
| `make test` — 72 pytest tests (at last update) | Behavioral: lifecycle legality, per-step approve ledger + **idempotent replay** (ADR 0006), send-back→respond loop, keyset cursor + subject axis (ADR 0008), simulator stops at the merge gate, retry clears escalation, stage clock + last-event (ADR 0010), registry CRUD, comments. Claude runner (fake executor): full pipeline to merge, **test-isolation gate catches a cheating implementer** (including a pytest-config deselection cheat), RED gate rejects non-failing tests, a pytest-less venv escalates instead of passing RED, **Retry resumes at the stuck stage with a clean workspace**. Agent-CLI seam: codex (default) sandboxes by mode, claude keeps its tool disallow list, missing binaries fail closed. Feed (ADR 0012): comments ride the event log, subject-feed tail + increment cursor. Architecture hardening (ADR 0013): **Retry re-drives the claude pipeline**, restart orphans are escalated and visible, crashed stages escalate instead of dying, a cancel always wins (no merge-gate resurrection), merge failures escalate instead of fake-deploying, approve replay never double-starts a pipeline, migrate() defaults new NOT NULL columns (old rows never 500), submit replay never drafts twice, `/api/events/cursor` is the tail, health touches the DB, PATCH is a real patch. Hardening: input validation, interview hard cap, edit-locked after submission, illegal-transition 409s, cancelled items never tick, 404s |
| `make test-web` — 40 vitest tests (at last update) | The client's pure domain logic: UTC re-tagging of SQLite timestamps, time formatting, the Submitter plain-stage vocabulary (including "never leaks Control-center words"), status-by-shape glyph mapping, gate labels, approve confirm-steps, post-approval/in-flight stage helpers |
| `make build` — Angular production build | All 17 screens compile; template/type errors surface here |
| `make smoke` — `scripts/smoke.sh` | The full lifecycle against a **real server process** on a throwaway DB: create → interview×3 → submit → spec gate → inbox → approve (+replay) → 8 simulator ticks → merge gate → approve merge → Deployed milestone in the log. On failure the server log is printed (never discarded) |

CI additionally runs `docker compose build`, so Dockerfile/nginx/lockfile
drift fails the pipeline instead of a deploy.

## 1b. Agent workflows — research & validation (ADR 0013)

Two named multi-agent workflows live in `.claude/workflows/` (run them from a
Claude Code session in this repo):

- **`research-architecture`** — six parallel auditors (concurrency,
  scalability, backend structure, frontend, agent pipeline, ops), each
  returning structured `file:line`-cited findings; every high/medium finding
  is then adversarially re-verified by a skeptic agent before it counts.
  This is the workflow that produced the ADR 0013 findings.
- **`validate-architecture`** — the validation counterpart: runs `make verify`
  (the deterministic gate), then one adversarial agent per ADR 0013 guarantee
  tries to **refute** it against the live code (stranded requests, cancel
  wins, honest deploy, engine pragmas, O(new) polling, isolation-gate config
  surface, one-owner rules) and reports any gaps. Run it after touching
  `api/app/` or `web/src/app/core/`.

`make verify` stays the token-free gate; the workflows are the deeper,
agent-driven layer on top.

## 2. Run it locally

```bash
make dev          # API :8000 (simulator ticks every 8s) + web :4200, Ctrl-C stops both
```

The dev server proxies `/api` to the backend (`web/proxy.conf.json`), matching the
production topology. For the production-shaped stack (nginx serving the built SPA,
proxying `/api`, SQLite on a named volume):

```bash
make up           # docker compose up --build → http://localhost:8080
```

Open **http://localhost:4200**. The DB seeds itself on first boot with the
design's demo world (5 apps, ~12 requests in every state). `make reset`
wipes it back to the seed.

Two identities stand in for the SSO role fork — switch any time with the
**pill at bottom-right** (Jordan D. = Submitter, Kim P. = Admin), or use the
two sign-in buttons on `/login`.

## 3. Guided manual flows

### Flow A — Submitter files a request (the front door)

1. `/login` → **Sign in with Microsoft** → lands on **New request** (S1).
2. Pick **Enhancement** → fields reveal. Pick an app, write a sentence, **Continue to questions**.
   - *Expect:* URL becomes `/submit/<id>/interview` — the request is already persisted (persist-first).
3. Answer the open question in the composer (Enter sends). The next question offers
   **lettered options A–D** — pick one, **Continue**. **Skip** the last question.
   - *Expect:* progress bar advances 38 → 62 → 90 → 100%; label flips to "Last question".
4. **That's everything** → **Review** step shows Type/App/description/every answer with **Edit** links.
   - *Expect:* Edit→Describe really edits (server PATCH), state survives stepper navigation.
5. **Submit request** → confirmation: green check, **REQ-20xx** receipt stub, tracker lit at **Spec drafted**.
6. **Track this request** → S5 timeline shows Submitted ✓ → Spec drafted ✓ → In review (ring).
7. **My requests** → the new row shows pill **Spec drafted**; ages are sane ("2m").

### Flow B — Admin clears the gate (Approval queue)

1. Switch to **Admin** (pill) → sidebar shows **Needs me** with an **amber count**.
2. **Approval queue** → your new request is listed. Select it.
   - *Expect:* collapsible Original request + Interview answers; **Suggested triage**
     (App/Owner/Priority each with a one-line reason); possible **duplicate hint**;
     **Draft spec** lines each tagged `(from: Qn)` or `(ASSUMPTION — not stated)`;
     amber **Open questions** block.
3. **Approve spec [A]** → confirm modal lists the three irreversible steps → **Approve & start build**.
   - *Expect:* item leaves the queue; inbox count drops; on the **Board** the card now
     sits in **Architecture** with a purple ring.
4. Within ~8s (simulator tick) the **feed** for that app posts milestones:
   "Architecture plan drafted — PLAN.md committed", RED/GREEN test gates, etc.

### Flow C — Send back ⇄ respond (the round-trip)

1. Queue → select another gate item → **Send back [S]** → type a question → Send back.
2. Switch to **Submitter** → **My requests** shows the amber **Needs your input** band → **Respond**.
3. S5 hero shows the reviewer's question verbatim → answer → **Send back for review**.
   - *Expect:* green "back with the reviewer" confirmation; switching to Admin, the item
     is back in the queue and its draft spec gained a line tagged `(from: reply 1)`.

### Flow D — Escalation & recovery (Needs human)

1. Board → the red-flag **Offline sync mode** card → click → side panel leads with
   **Escalated — why** (the red reason box).
2. **Retry stage** → the flag clears, a `recovery_action` lands in the feed, the item
   returns to the queue.

### Flow E — Watch a build & take the merge gate

1. With `make dev` running, approve any spec and watch the **Board**: the card moves
   Architecture → Build → Review on its own (simulator = the Stage 2–6 CI agents).
2. At **Review** it stops and raises **Approve merge** — board badge, inbox row, and a
   broadcast feed card with **Review & approve**.
   - *Expect:* it never advances past Review on its own — humans gate the irreversible.
3. Approve the merge (queue or side panel) → confirm modal now lists merge/promote/deploy →
   card lands in **Done**, feed posts **"Deployed — production promotion merged"**, and the
   submitter's S5 timeline shows **Deployed ✓**.

### Flow G — Pipeline view (the default landing, ADR 0010)

1. Sign in as a reviewer (or press **G P**) → you land on **Pipeline**.
   - *Expect:* rows grouped **Needs me → In flight → In triage → With submitter →
     Done & closed (collapsed)**; a stage legend (Intake · Spec ◇ Arch · Build ·
     Review ◇ Done) aligned over every row's strip.
2. Read any "Needs me" row: amber diamond at the waiting gate + "Nm at the spec/merge
   gate"; the escalated row is red-bordered with "stalled Nm — Retry · Take over · Cancel".
3. With `make dev` running, approve a spec and watch its row migrate from *Needs me*
   to *In flight*: the active segment animates (striped) and the clock resets
   ("1m in Arch"), advancing every ~8s tick until it returns to *Needs me* at the
   merge gate.
4. Click a row → the full-screen issue. Click its gate badge → the Approval queue.
   The List ⇄ Board ⇄ Pipeline toggle swaps lenses over the same data.

### Flow F — Control-center chrome

- **Role fork is enforced**: while signed in as Jordan D. (Submitter), any `/admin/*`
  URL redirects to `/login`. Identities switch via the avatar row at the bottom of the
  admin sidebar / the identity chip in the submitter top bar — no floating overlay.
- **⌘K** palette: jump to apps, "Run factory tick", New issue. **?** opens the shortcut
  cheat-sheet. **G then P/B/L/I/T/R/S** navigates. **C** opens **New issue** (except on
  the queue, where C = Cancel the focused request).
- **Single-key verbs are real**: in the Approval queue, `J/K` move the selection,
  `↵` opens the full issue, `A` opens the approve confirm, `S` the send-back modal,
  `C` the cancel confirm. In the inbox and pipeline, `J/K` + `↵` traverse and open;
  `A` jumps to the queue pre-selected on that item. All rows are Tab-reachable with
  a visible focus ring; `Esc` closes side panels and modals.
- Board: **Assigned to me** pill filters to Kim P.'s cards; **Group by** App/Assignee/Type
  renders collapsible **swimlanes** under fixed stage columns.
- List rows open the **full-screen issue** (labels, attachments, spec, checklist,
  activity tabs + comment composer, details rail).
- **App registry**: edit shows the blast-radius note; **New** registers an app that
  immediately appears in the submitter dropdown and sidebar.
- Polling: header shows "Updated Ns ago"; two browser windows (one per role) reconcile
  within ~4s of any action — no whole-board flash.

## 4. Regression baseline

The repo state before implementation is the `Baseline:` commit — design docs only.
Everything since is additive (`api/`, `web/`, `scripts/`, this file); no doc was
rewritten, so "migrated cleanly" = `git diff <baseline> -- docs CONTEXT.md` is empty
except ADR 0009.

## 4b. Flow H — the real factory (Claude Code runtime, ADR 0011)

Requires the `claude` CLI and spends real tokens; everything else stays offline.

1. Start the API in Claude mode (see README) — the admin header chip flips to
   **Agents: Claude Code**.
2. File a request as a Submitter: the interview questions are now **generated by
   Claude** (watch the "Thinking about a follow-up…" state), and the draft spec's
   provenance tags reference your actual answers.
3. Approve the spec as Kim: a git workspace appears under `workspaces/<ref>/` and
   the stages run for real. *Expect, in order, in the feed/timeline:*
   `Architecture plan committed` → `RED: failing tests authored — fail for the right
   reason (N failed, M passed)` → `GREEN: ... implementer touched no test files` →
   `Review report committed — APPROVE` → the **merge gate** rises in the inbox.
4. Approve the merge → `git log main` in the workspace shows the merge commit; the
   item lands in Done and `python -m pytest` in the workspace is green — that's the
   verification step, on real artifacts.
5. Gate failures escalate with the reason (red panel on the card) — Retry re-runs
   the stage fresh. The test-isolation gate is live: an implementer edit under
   `tests/` is reverted and escalated.

## 5. Known limits (by design, for the prototype)

- GitHub/Entra/OpenAI are **not** wired: SSO is a role picker, the Builder bot's
  writes are simulated records, the intake brain is scripted (`api/app/interview.py`
  is the swap seam per ADR 0007).
- Attachments, labels editing, reactions, and "Accept all" triage are visual
  affordances, not persisted features.
- Desktop-only (per the design decision in the handoff chats).
