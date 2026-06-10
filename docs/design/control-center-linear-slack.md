# Control Center — Linear-style tracking + Slack-style per-app progress feed

> Design brief from a multi-agent research workflow (Linear UX · Slack feeds · feed architecture ·
> notifications · prior art). All recommendations are **additive to** ADR-0004 (milestone summaries,
> not streaming) and ADR-0007 (polling now, SSE later) — neither is reopened. Not yet adopted; this
> is the researched proposal for the Control center direction.

## The keystone (everything else is a query over this)

**Promote each milestone summary from "a PR comment on one card" to a first-class typed
`progress_event` keyed on BOTH `request_id` (the Work item / Request axis) AND `subject_id`
(the app axis, denormalized from the Request via the App registry).**

That one schema change buys both views with **zero new infrastructure and zero fan-out**:
- **Per-Request Progress timeline** = `WHERE request_id = …` (today's per-card timeline, unchanged in spirit)
- **Slack-like per-app feed** = `WHERE subject_id = …`

It is **fan-out-on-read** (correct: one writer — the Factory Builder bot — and a handful of feeds;
never build fan-out-on-write). Gate events, Escalation, and Recovery actions fold into the same
table via a `kind` enum — the "same rail, one source of truth" CONTEXT.md already mandates.

### Data model (additive — same GitHub-event rail, same DB, same poll)

```
progress_event                       -- append-only log: one row per milestone summary / gate event / recovery
  id                BIGINT PK         -- monotonic; doubles as keyset cursor AND poll cursor
  request_id        FK -> request     -- thread axis  -> per-Request timeline
  subject_id        FK -> subject     -- app axis (denormalized) -> per-app feed (channel)
  kind              ENUM(milestone_summary | gate_event | escalation | recovery_action)
  stage             ENUM(intake|spec|architecture|build|review|deploy|done)
  status_type       ENUM(triage|started|completed|canceled)   -- Linear status-TYPE, from one mapping table
  actor             TEXT              -- factory-builder-bot | Admin login
  broadcast         BOOL              -- true for gate-boundary + needs-human (reply-broadcast to channel top)
  title             TEXT              -- headline, e.g. "Implemented cart totals; 8/8 tests pass"
  body              TEXT NULL         -- full summary markdown
  payload           JSON NULL         -- gate name, PR number, diff link, recovery type, label/priority hints
  source_comment_id TEXT NULL         -- the GitHub comment id, for idempotent upserts
  created_at        TIMESTAMP
  INDEX (subject_id, id DESC); INDEX (request_id, id DESC); UNIQUE (source_comment_id)

feed_read_state                       -- watermark for unread (NOT per-event receipts)
  admin_id FK; scope_kind ENUM(subject|request); scope_id BIGINT; last_seen_event_id BIGINT
  PK (admin_id, scope_kind, scope_id)
```

API (FastAPI), all **keyset** (`?after=<event_id>`) — the same cursor IS the polling cursor, and
the exact seam SSE drops into later unchanged:
- `GET /subjects/{id}/feed?after=` — per-app Slack-style feed
- `GET /requests/{id}/timeline?after=` — per-Request thread
- `GET /activity?after=&filter=waiting-on-me` — cross-app "Needs me"
- `GET /subjects/{id}/feed/unread` · `POST /subjects/{id}/feed/seen {last_event_id}`

**Webhook change:** on a PR comment, insert one `progress_event` (resolve `request_id` from the PR,
denormalize `subject_id`); upsert on the GitHub comment id. **Writer change:** the Builder bot tags each
summary with `kind` + `stage` (it already knows where it is) so the feed renders typed/stage-colored
without parsing free text.

## Three pillars

**1. Linear-style tracking (adopt the subset that maps to our nouns)**
- **Status-TYPE layer** over the 7 stage columns (Intake=Triage, Spec…Deploy=Started, Done=Completed,
  Cancel→Canceled; **Needs-human is a blocked OVERLAY, not a column**). One mapping table drives all
  board/list/filter behavior.
- **Triage = our Intake** literally; Approval queue = single-keystroke Approve/Send-back, comment-inline.
- **List ⇄ board toggle** on one filterable collection (board = group-by stage; group-by Subject = a
  per-app list; group-by owner free). Flat AND-only filters + 3–4 built-in saved views (Waiting on me,
  Needs human, Active builds, Per app).
- **Command palette (Cmd+K) + G-nav + single-key gate approval** over the already-loaded local list.
- **Optimistic UI + signal-based granular re-render + diff-merge polling** = ~80% of Linear's felt speed
  with no sync engine (and without it, polling every 3–5s feels *worse* — whole-board flash).
- **Defer:** local-first IndexedDB sync engine, cycles/estimates, user-authored views, OR-filters, multi-team.

**2. Slack-style per-app progress feed** — `channel = app (Subject)` → `thread = Request/Work item` →
`message = milestone summary`:
- Left rail = app list (channels) with unread dots + per-app follow level (All / Gate+Needs-human / Muted).
- Channel = the app's Requests as thread roots, each with a live **status header** (current stage/gate —
  the **one** allowed edit-in-place; summaries beneath stay immutable per ADR-0004).
- Thread = the Work item's milestone summaries as Block-Kit-style structured cards (headline + context
  line + PR/diff links).
- **Reply-broadcast:** most summaries stay in-thread; **gate-boundary events + Needs-human broadcast** to
  channel top. Quiet by default, loud when it matters. Collapse repeated Retry-loop noise.

**3. Notifications — Linear restraint, not Slack volume** (two surfaces, three coarse settings, zero push infra):
- **"Needs me" inbox** (clear-to-zero) = only Tier-1 items: Approve spec / Sign ADRs / Approve merge /
  Approve deploy / red Needs-human. It's the existing "waiting on me" filter promoted to a badge-counted,
  clearable surface, + mark-read + snooze.
- **Ambient per-Subject feed** (Tier-2) = unread dot only, no push.
- **Tier by consequence:** Tier-1 interrupts; Tier-2 ambient; Tier-3 (a card merely moving column) =
  nothing. Email = a separate *delivery* of the same event, **digest-gated on still-unread inbox items**
  (perfect for polling, no push infra). Auto-subscribe on involvement; @mention another Admin on a card =
  the human-to-human handoff the Factory otherwise lacks ("@dana take the deploy gate").

## Hold the line (guardrail)

Persist **only** milestone summaries / gate events / escalation / recovery actions. **No** streaming
heartbeats ("editing file X"), **no** chat.update on historical summaries (only the status header
mutates), **no** presence/typing, **no** per-milestone push. The Slack-channel framing is exactly the
temptation that would smuggle back the firehose ADR-0004 rejected — name the boundary so it can't drift.

## Prioritized enhancements

| # | Title | Area | Impact | Effort |
|---|-------|------|--------|--------|
| 1 | **Two-axis `progress_event` log** (request_id + subject_id, typed) — the keystone | data-model | high | M |
| 2 | **Per-Subject progress feed** (channel→thread→message) — query over the log | slack-feed | high | M |
| 3 | **Transport-agnostic store + optimistic gate actions + granular re-render** | architecture | high | M |
| 4 | **"Needs me" inbox + ambient feed, tier-by-consequence settings** | notifications | high | M |
| 5 | **Hold the ADR-0004 line** (no streaming / edit-in-place / presence) | architecture | high | S |
| 6 | **Status-TYPE layer** over the 7 stage columns | linear | high | S |
| 7 | **Keyset cursor + unread watermark that doubles as the poll cursor** | data-model | med | S |
| 8 | Typed feed entries + collapse noise + no-LLM "status so far" line | slack-feed | med | S |
| 9 | List⇄board toggle + 3–4 built-in saved views | linear | med | M |
| 10 | Triage-style approval queue (1-click, summarized context, reuse Intake brain) | linear | med | M |
| 11 | Command palette + G-nav + single-key gate approval | linear | med | S |

**Top picks (in order):** 1 → 2 → 3 → 4 → 5 → 6 → 7.

**Rejected by critic:** a separate "cross-app Activity inbox with Dense/Detailed layouts" — its useful
core (cross-app "waiting on me") is already the "Needs me" inbox; the rest is Slack feature-copying with
no payoff for a handful of admins.

## Key sources
getstream.io (activity-feed architecture, fan-out) · Linear Docs (status types, Triage, filters, Inbox) ·
"How is Linear so fast" (performance.dev) · Slack Block Kit + thread_ts/reply-broadcast · Slack Engineering
(rebuilt notifications) · keyset-vs-offset pagination · Permit.io HITL best practices.
