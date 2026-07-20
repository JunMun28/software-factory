# Plan 008 — Multi-user scalability + chat-grade latency (intake brain)

**Status:** PROPOSAL v2 — awaiting approval
**Design point:** 10–50 concurrent end users, self-serve app creation
**Latency goal:** chat-app feel — first token < 2 s, question complete < 10 s
**Target platform:** ARO (Azure Red Hat OpenShift) + Azure SQL
**Date:** 2026-07-19 (v2 supersedes the same-day v1 worker-queue draft)

---

## 1. Where we are

The system is honest about being single-user: `CLAUDE.md` mandates one uvicorn
worker, `deploy/base/factory-api.yaml:22` pins `replicas: 1`, and the design
comments in `interview_gen.py:6-9` state the assumption outright. The build
pipeline already scales correctly (Kube Jobs, `KUBE_JOB_CAP=10`, per-app
fair-share, CAS transitions with fencing epochs). **The intake AI path does
not** — and it is also slow in a way no amount of scaling fixes.

### 1a. The scale problem — four uncoordinated ceilings

| Ceiling | Value | Where |
|---|---|---|
| AnyIO threadpool (all sync `def` handlers) | 40 (unconfigured default) | every route in `requests.py` |
| SQLAlchemy pool | 15 (5 + 10 overflow, unconfigured default) | `api/app/db.py:10,15` |
| API pod budget | 1 CPU / 1 GiB | `factory-api.yaml:73` |
| Concurrent agent CLI subprocesses | **unbounded** | `agent_exec.py:135` — no semaphore anywhere in `api/` |

Each intake generation forks a full agent CLI (`opencode` by default) inside
the API container for 30–240 s. N users → N Node processes sharing 1 GiB.
First failure mode under load is OOMKill of the whole API pod.

Specific defects (2026-07-19 audit):

1. **`classify_request`** (`requests.py:250`) runs a 120 s model call inline
   in the request thread. It fires from the composer while users type.
2. **`_sse_worker` fallback** (`requests.py:155-167`) opens a fresh
   `SessionLocal()` once per second per waiting stream — ~12 waiters exhaust
   the pool alone.
3. **Background threads hold a pooled connection across the whole model
   call** (`interview_gen.py:71-82`).
4. **Check-then-act write races:** `answer_interview` (`requests.py:378`,
   `order = len(r.turns)`), `instruct_prototype` (`:482`), `reopen_interview`
   (`:406`), `escalate_interview` (`:423`). The submit path is safe (CAS on
   rowcount, `transitions.py:1027`) — the pattern exists, it just wasn't
   applied here.
5. **In-process dedup registries** (`_inflight` sets in `interview_gen.py:27`,
   `summary_gen.py:20`, `prototype_gen.py:28`) — die on restart, break on
   >1 replica, and dedupe per request id (the wrong axis for N users).
6. **SQLite is the deployed default** (`configmap.yaml:13`); only the prod
   overlay swaps to Azure SQL. One writer; the tick loop takes the write lock
   every 5–8 s.
7. **`sf-data` PVC is ReadWriteOnce** (`factory-api.yaml:5-9`) — hard blocker
   on a second API replica.

### 1b. The latency problem — the CLI transport itself

The user-facing goal is claude.ai feel. The transport makes that impossible
regardless of scale fixes:

- Every call cold-starts a CLI process (seconds) which runs its own agent
  loop; the code's own comments cite **~2x latency, 3x cost** vs a plain call
  (`agent_brain.py` `_scratch_cwd` rationale).
- `_communicate()` is a blocking `subprocess.communicate()` — **nothing
  streams**. The SSE endpoint emits one terminal event
  (`_sse_response`, `requests.py:183`), so time-to-first-visible-character =
  full generation time: 30–90 s per question, up to 240 s for a prototype.
- The prose-first `===META===` prompt format (`_question_prompt`,
  `agent_brain.py:55`) was designed for token streaming that was never built.

Pre-generation (`interview_gen.py`) hides some of this between questions, but
the first question, every classify, and every fast answerer eats the full
wait. A worker queue (v1 of this plan) would add ~0.5–2 s on top and fix none
of it.

### 1c. Assets already in the codebase

- **`LeaderElector`** (`api/app/leader.py`) — real MSSQL `sp_getapplock` with
  fencing epochs. The multi-replica tick-loop problem is solved in code.
- **CAS transition machinery** (`transitions.py:1111`) — the template for
  fixing the interview races.
- **Graceful degradation** — every `AgentBrain` method falls back to
  `ScriptedBrain`: "the interview is enrichment, never a blocker." Kept.
- **`propose_escalation`** (`agent_brain.py:453`) — a team-routing seam wired
  end-to-end (schema, endpoint, UI) but hardcoded to `None`. Phase 5 fills it.
- **`anthropic>=0.116.0`** — already declared in `api/pyproject.toml:7`,
  never imported. The transport this plan needs is one import away.
- **`SpecLine` rows** — structured specs of everything the factory ever
  built. This *is* the "past apps" corpus; it just isn't exposed to the brain.

---

## 2. Target architecture

> **One sentence:** the intake brain becomes async streaming calls to the
> Anthropic API — no subprocesses, tokens relayed live over the existing SSE
> channel, smart models kept because streaming decouples perceived speed from
> model size — and the API pod becomes light enough that the v1 worker fleet
> is unnecessary.

```
users ◄══ SSE token stream ══╗
                             ║
              ┌──────────────╨──────────────┐
              │        factory-api          │  async brain calls (sockets,
              │  AsyncAnthropic + semaphore │  not processes); CLI kept only
              │  fallback: CLI → scripted   │  as a bounded fallback tier
              └──────┬───────────┬──────────┘
                     │           │
              Azure SQL     Anthropic API
         (state, dedup rows,  (streaming, prompt-cached
          usage accounting)    knowledge, tools)

  build pipeline: unchanged (Kube Jobs via kube_runner, already capped)
```

### Decisions

**D1 — Direct Anthropic API replaces the CLI as the intake transport.**
The interview/classify/summary/prototype calls are read-only text-in/
text-out — they never needed an agent CLI's tools or sandbox. A direct call
removes cold-start, enables true token streaming, and shrinks the injection
surface (no filesystem, no bash — nothing to sandbox). This supersedes ADR
0024 *for the intake brain only* and needs its own ADR; the build pipeline
keeps the CLI/Job architecture unchanged. `FACTORY_BRAIN` gains an `api`
mode; the fallback chain is **api → agent CLI → scripted**, so the CLI seam
is retained, not deleted.

**D2 — Model tiering, not model shrinking.**
Streaming makes a 12-second opus generation *feel* faster than a 30-second
blank spinner, so question quality is not sacrificed for speed:

| Call | Model (env-switchable) | Why |
|---|---|---|
| classify | `claude-haiku-4-5` | it's a label, not a thought; < 2 s |
| interview question | `claude-sonnet-5` (dial to `claude-opus-4-8`) | the questions ARE the product |
| summary | `claude-sonnet-5` | structured condensation |
| prototype | `claude-sonnet-5` | streams HTML smoothly (existing settings rationale) |
| draft_spec | `claude-opus-4-8` | one-shot, non-interactive, highest stakes |

**D3 — Real SSE streaming, same frontend contract.**
`_sse_response` changes from one-terminal-event to relaying deltas; the
`api` brain tier is fully async (no thread, no queue — the handler consumes
the SDK stream directly). `generation-stream.ts` gains a delta event type;
its existing 1.5 s poll fallback stays as the degraded path (poll returns the
last full state, so a dropped stream never strands a user).

**D4 — Concurrency control is an `asyncio.Semaphore`, not a worker fleet.**
An async streaming call is a socket. 50 concurrent calls ≈ tens of MB, not
tens of GB. `FACTORY_BRAIN_CAP` (default 20) bounds api-tier calls; a
separate small semaphore (default 2) bounds the CLI fallback tier, which
still forks processes. On saturation: scripted fallback, never a hung
spinner. **The v1 `sf-brain-worker` Deployment is dropped from this plan** —
it returns only if a future brain tier needs sandboxed tool execution.

**D5 — Dedup and usage accounting move to a DB table (no workers needed).**
A slim `brain_calls` table replaces the three `_inflight` sets:
`(id, request_id, kind, dedup_key UNIQUE, status, model, tokens_in,
tokens_out, created_at, finished_at)`. Idempotent enqueue = INSERT on the
unique key; survives restarts and replicas. The same rows are the per-user
usage ledger Phase 0's budget needs — one table, two jobs.

**D6 — Per-token billing is embraced, and therefore budgeted.**
The CLI path rode personal subscription plans; 50 end users cannot. Direct
API means an org API key and per-token cost, which makes Phase 0's per-user
budget **mandatory**: enforced from `brain_calls` token sums, with a clear
"daily budget reached" message in the UI.

**D7 — Knowledge is prompt-cached context + read-only tools; no vector DB.**
Micron glossary, team registry, and data-source catalog live as versioned
files (`knowledge/`) loaded into the system prompt with `cache_control` —
after the first call the cached prefix costs ~10% and adds no latency. "Past
apps" is a SQL tool over existing tables. Retrieval infra (Azure AI Search /
embeddings) is **deferred behind a written trigger** (§ Phase 5.4), not built
speculatively.

**D8 — SQLite remains for dev/tests only.** All deployed environments run
Azure SQL. The `db.py` SQLite branch stays for `make verify` speed.

### Latency targets (acceptance criteria for Phase 3)

| Metric | Today | Target |
|---|---|---|
| First token visible (question) | 30–90 s | **< 2 s p50, < 5 s p95** |
| Question complete | 30–90 s | < 10 s (sonnet), < 15 s (opus) |
| Classify chip | up to 120 s | < 2 s |
| Prototype first paint | up to 240 s | < 5 s, streams to completion |
| With tools (Phase 5) | n/a | < 10 s to first token, status line while tools run |

---

## 3. Phased delivery

### Phase 0 — Prerequisites for real end users *(mostly exists, needs merging)*
- **Auth:** merge the Entra ID work (branch `entra-auth`; backend wall done,
  SPA MSAL pending). Anonymous end users cannot exist in this product.
- **Ownership:** enforce row-level visibility on requests (reporter identity
  and console roles already exist).
- **Per-user budget:** daily token/call caps read from `brain_calls` (D5/D6).
  Blocking for launch, not for Phases 1–3 development.

### Phase 1 — Stop the bleeding, in-pod *(~1–2 days; ships alone)*
Keeps the current transport alive for a pilot while Phase 3 lands.
1. Global semaphore around `run_agent` — `FACTORY_CLI_CAP` (default 3);
   acquisition timeout > 5 s → scripted fallback. (Survives into Phase 3 as
   the CLI-fallback-tier bound, per D4.)
2. `classify` off the request thread — same background + poll treatment
   `interview_gen` already uses.
3. Fix `_sse_worker` — one session per wait loop, backoff 1 s → 2 s → 4 s.
4. Explicit engine sizing — `pool_size=20, max_overflow=20, pool_timeout=10`
   on the mssql branch; stop holding sessions across model calls in
   `*_gen.py` (open → snapshot → close → call → open → write).
5. Bump API pod to 2 CPU / 2 GiB while subprocesses still live there
   (reverted in Phase 3).

### Phase 2 — Correctness under concurrency *(~1–2 days)*
1. CAS the interview writes: `answer_interview` claims the question via
   `UPDATE ... SET pending_question=NULL WHERE id=? AND pending_question IS
   NOT NULL` + rowcount (else 409); turn `order` becomes transaction-derived
   with a unique `(request_id, order)` index. Same treatment for
   `instruct_prototype`, `reopen_interview`, `escalate_interview`.
2. Azure SQL in every deployed environment (D8).
3. Concurrency integration test: two simultaneous answers → one 409, zero
   duplicate orders.

### Phase 3 — Direct API streaming brain *(the unlock; ~1 week)*
1. **New ADR**: intake brain transport = Anthropic API; supersedes ADR 0024
   for intake only; fallback chain api → CLI → scripted; billing implications
   (D6).
2. `app/brain_api.py`: `AsyncAnthropic` client; per-kind model config (D2:
   `FACTORY_CLASSIFY_MODEL` / `FACTORY_QUESTION_MODEL` /
   `FACTORY_SUMMARY_MODEL` / `FACTORY_PROTOTYPE_MODEL` /
   `FACTORY_SPEC_MODEL`); reuses the existing prompts in `agent_brain.py`
   verbatim (they are transport-agnostic f-strings); `asyncio.Semaphore`
   (D4); existing guardrails carry over (`<request_data>` wrapping,
   `_strip_leaked_options`, `_scrub_html`).
3. `brain_calls` table + idempotent-enqueue helper (D5); delete the three
   `_inflight` sets; migration for mssql.
4. **Streaming SSE**: `_sse_response` relays deltas from the SDK stream for
   api-tier calls (async end-to-end, no thread); terminal event carries the
   parsed `===META===` result. `generation-stream.ts` + `interview.ts` /
   `prototype.ts` render progressive text; poll fallback unchanged.
5. Rewire `classify` / `interview_gen` / `summary_gen` / `prototype_gen` /
   `draft_spec` through the api tier with CLI fallback. Pre-generation stays
   (it makes a 5 s call feel like 0 s); becomes an asyncio task, not a
   thread. Attachments: images pass natively as API content blocks (today's
   `--image` flag juggling disappears).
6. `draft_spec` at submit: async api call under the existing atomic claim
   (`requests.py:590` commits the claim before the brain runs — contract
   holds; no queue needed at 5–15 s opus latency).
7. Revert Phase 1.5: API pod back to 1 CPU / 1 GiB. LLM key stays on the API
   pod for now (it is the only brain host); moves out only if a worker tier
   ever returns.
8. **Measure against the latency table** (§2) with telemetry on TTFT, total
   gen time, tokens; flip `FACTORY_BRAIN` default to `api` once green.

### Phase 4 — API HA / 2 replicas *(optional at this scale; ~2–3 days)*
For zero-downtime deploys and node failure, not throughput.
1. Wire `LeaderElector.try_acquire()` into startup for the tick loop
   (replacing the `WEB_CONCURRENCY` refusal, `main.py:61-66`); non-leaders
   serve traffic and retry.
2. Uploads → Azure Files (RWX) or Blob; removes the RWO PVC blocker.
3. `replicas: 2`, `RollingUpdate`. (D5's DB dedup already makes generation
   state replica-safe.)

### Phase 5 — Knowledge & routing: the brain gets context *(~1 week, after 3)*
Question quality comes from context more than model size. Each step ships
alone and improves questions immediately.
1. **Cached system context** (D7): `knowledge/glossary.md` (Micron terms),
   `knowledge/teams.yaml` (team → scope → queue/contact),
   `knowledge/data-sources.yaml` (name → what it contains → owner). Loaded
   into the system prompt as `cache_control` blocks. Content ownership:
   editable files in-repo first; console-editable later if teams need it.
2. **Read-only tools** via the SDK agent loop (tool runner), capped at 3
   calls/question, streaming the final text:
   - `search_past_apps(query)` — SQL over `Request` + `SpecLine` rows (the
     corpus already exists, D-assets §1c)
   - `get_data_source(name)` — catalog detail
   - `check_team_ownership(description)` — team-registry lookup
   While tools run, SSE streams a status line ("checking past apps…") so the
   user never watches a dead spinner.
3. **Wire `propose_escalation`**: with the team registry in context, the
   brain fills the existing dormant seam — schema, endpoint, and UI are
   already built; the console shows "this looks like Team Y's scope — route
   it?".
4. **Retrieval trigger (deferred, written down):** adopt embeddings/Azure AI
   Search only when knowledge files exceed ~100k tokens, cache-miss cost
   becomes material, or `search_past_apps` SQL relevance visibly fails.
   Until any trigger fires, retrieval infra is out of scope.

**Sequencing:** 0 ∥ 1 → 2 → 3 → 5, with 4 whenever HA is wanted.
Each phase is independently shippable and `make verify`-gated.

---

## 4. What this explicitly does NOT do

- **No worker fleet, no broker, no Redis** (D4, D1-v1-reversal). An async
  socket per call needs none of it at this scale. The v1 worker design is
  preserved in git history if a sandboxed-tool tier ever justifies it.
- **No vector DB / embeddings yet** (D7) — behind the Phase 5.4 trigger.
- **No change to the build pipeline** — Kube Jobs, caps, gates stay as-is.
- **No CLI deletion** — it drops to fallback tier, bounded by Phase 1's
  semaphore.
- **No API autoscaling** — Phase 4 reaches 2 replicas for HA; more waits for
  evidence.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Anthropic API outage takes the interview down | Fallback chain api → CLI → scripted is the existing degradation philosophy, now three-deep; interview is enrichment, never a blocker |
| Per-token spend surprises with 50 self-serve users | D5 ledger + D6 mandatory per-user budgets before launch; `brain_calls` gives per-user/per-day token telemetry from day one |
| Streaming SSE through ARO ingress/HAProxy buffers or drops | Poll fallback already built and battle-tested (`generation-stream.ts`); verify ingress `proxy-buffering off` for the SSE routes during Phase 3.8 |
| Opus question latency (8–15 s) still feels slow for impatient users | Pre-gen hides inter-question latency entirely; default is sonnet with an env dial; streaming makes even opus feel live |
| Tool loop (Phase 5) reintroduces latency | Hard cap 3 tool calls; status-line streaming; tools are single-row SQL/file lookups, ~ms each — the cost is the model round-trips only |
| Prompt-cache misses on low traffic (cache TTL) | Cache prefix is identical across all users/requests, so any traffic keeps it warm; cost impact at 50 users is minor either way |
| CAS retrofit breaks interview UX edge cases | Phase 2.3 concurrency test + existing intake specs in `make verify` |
| Entra merge slips → "end users" blocked regardless | Phase 0 flagged as launch-blocking; Phases 1–3 don't depend on it |
