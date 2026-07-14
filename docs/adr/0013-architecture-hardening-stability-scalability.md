# Architecture hardening: no stranded requests, O(new) polling, one config/lifecycle owner

**Status:** accepted
**Refines:** ADR 0006 (resumability) · ADR 0008 (event log) · ADR 0011 (Claude runtime) · ADR 0012 (delta-fed views)

A six-dimension architecture audit (concurrency, scalability, backend
structure, frontend structure, agent-pipeline robustness, ops) found the same
root failure from four directions: **in claude mode, a request could be
silently stranded forever** — Retry never restarted the pipeline, a server
restart killed the daemon worker threads with no rescue, an unhandled stage
exception (hanging generated test, empty REVIEW.md) killed the thread without
escalating, and none of these states were visible in the needs-me inbox.
Secondary findings: an unconfigured SQLite engine under three writer classes,
polling costs that grew with lifetime history instead of new work, and three
copies of the lifecycle transitions that had already drifted.

## Decisions

1. **A request can never be silently stranded.** The stage loop catches every
   exception and routes it through the existing escalation path; `_pytest`
   treats a hung suite (rc 124) as a gate failure; Retry calls
   `claude_pipeline.start()` when the runner is claude; on startup, requests
   left `approved` mid-stage are escalated as *"orphaned by a server restart"*
   — stop + flag, never auto-rerun, so the operator decides (CONTEXT.md
   escalation semantics; this is how ADR 0006's resumability is honored: the
   workspace re-enters idempotently when Retry fires).

2. **A cancel always wins; the deploy is honest.** Escalations and the merge
   gate re-check `status` after long stages (a cancelled request can never
   resurrect at the merge gate; the inbox and the approve route filter dead
   statuses), and `approve_merge` escalates on a failed/impossible git merge
   instead of reporting "Deployed" over work that never landed. The approve
   transition is one atomic `UPDATE … WHERE status='pending_approval'`, so a
   double-click can never start two pipelines in one git workspace.

3. **The engine is configured for its actual shape** (one writer class per
   thread, many pollers): WAL + busy_timeout + foreign_keys pragmas on every
   sqlite connection; the tick loop survives exceptions and runs off the event
   loop; `/api/health` runs `SELECT 1` (Docker HEALTHCHECK now detects a dead
   DB); stdlib logging everywhere a pipeline acts, with full stage transcripts
   persisted to `<workspace>/.factory/` (excluded from git history).

4. **Polling is O(new), not O(history).** New clients start from
   `GET /api/events/cursor` (the tail) instead of replaying the log from id 0;
   the requests list filters/paginates in SQL and scopes its last-event lookup
   to the returned page; app open-counts are one grouped COUNT. On the client,
   a single `Store` service owns the version-keyed fetch of
   requests/apps/inbox — views consume computed slices (the 13 copy-pasted
   refetch effects are gone), and the poll loop has an in-flight guard so a
   stalled backend cannot queue a refetch burst.

5. **One owner per rule.** All env knobs live in `settings.py` with absolute
   path defaults (wrong-CWD launches can no longer create a second DB);
   shared transitions live in `lifecycle.py` (the simulator and ClaudeRunner
   had drifted).
   (Superseded 2026-07-15: transitions live in `api/app/transitions.py` — table + `apply()`; `lifecycle.py` absorbed and deleted.)
   Schema migration is a generic models-vs-PRAGMA diff in `db.py` (a new
   column never again 500s an existing DB); the demo seed is
   gated by `FACTORY_SEED_DEMO` (off in the compose stack — production DBs
   start empty).

6. **The test-isolation gate covers the config surface.** The frozen hash
   includes every file under `tests/` plus root `conftest.py`, `pytest.ini`,
   `pyproject.toml`, `setup.cfg`, `tox.ini` — an implementer deselecting the
   RED tests via `collect_ignore`/`addopts` is rejected and reverted exactly
   like a test edit.

## Consequences

- The compose stack starts an EMPTY database and keeps workspaces on the
  `/data` volume; the api service must stay single-process (the app refuses
  the tick loop when `WEB_CONCURRENCY > 1`, and the compose file documents the
  no-scale rule). `make backup` is an online sqlite backup, safe on a live DB.
- Old clients of `/api/requests` see at most 1000 rows per call (default 500);
  anything needing deep history must paginate via `limit`.
- Boot-time orphan escalation fires for any approved mid-stage request in
  claude mode — including demo-seeded ones, which is correct: nothing else
  will ever drive them.
- The validation workflow (`.claude/workflows/validate-architecture.js`) and
  `api/tests/test_architecture.py` pin every decision above; `make verify`
  remains the one deterministic gate.
