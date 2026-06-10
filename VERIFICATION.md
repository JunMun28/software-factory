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

Runs, in order — all must be green:

| Step | What it proves |
|---|---|
| `make test` — 13 pytest behavioral tests | Request lifecycle legality (draft→submitted→pending→approved/sent_back/cancelled), per-step approve ledger + **idempotent replay** (ADR 0006), send-back→respond loop appends a grounded spec line, keyset event cursor + subject-axis filter (ADR 0008), simulator stops at the merge gate, retry clears escalation, stage clock + last-event payload (ADR 0010), registry CRUD, comments |
| `make build` — Angular production build | All 16 screens compile; template/type errors surface here |
| `make smoke` — `scripts/smoke.sh` | The full lifecycle against a **real server process** on a throwaway DB: create → interview×3 → submit → spec gate → inbox → approve (+replay) → 8 simulator ticks → merge gate → approve merge → Deployed milestone in the log |

## 2. Run it locally

```bash
make dev          # API :8000 (simulator ticks every 8s) + web :4200, Ctrl-C stops both
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

- **⌘K** palette: jump to apps, "Run factory tick", New issue. **?** opens the shortcut
  cheat-sheet. **G then B/L/I/T/R/S** navigates. **C** opens **New issue** (Linear-style
  modal; creating one runs intake server-side and opens the full issue).
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

## 5. Known limits (by design, for the prototype)

- GitHub/Entra/OpenAI are **not** wired: SSO is a role picker, the Builder bot's
  writes are simulated records, the intake brain is scripted (`api/app/interview.py`
  is the swap seam per ADR 0007).
- Attachments, labels editing, reactions, and "Accept all" triage are visual
  affordances, not persisted features.
- Desktop-only (per the design decision in the handoff chats).
