export const meta = {
  name: 'research-architecture',
  description: 'Audit the Software Factory across six architectural dimensions for stability, scalability, maintainability; adversarially verify every finding',
  whenToUse: 'Periodic architecture review, or before planning a major change — produces confirmed, file:line-cited findings per dimension.',
  phases: [
    { title: 'Audit', detail: 'six parallel auditors, one per dimension' },
    { title: 'Verify', detail: 'one skeptic per high/medium finding' },
  ],
}

const ROOT = 'the repo root (your current working directory)'

const FINDINGS = {
  type: 'object',
  required: ['findings', 'summary'],
  properties: {
    summary: { type: 'string', description: 'Two-sentence overall health assessment of this dimension' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'area', 'severity', 'file', 'evidence', 'impact', 'fix'],
        properties: {
          title: { type: 'string', description: 'Short specific title, e.g. "Pipeline thread dies on server restart, request stuck forever"' },
          area: { type: 'string', enum: ['stability', 'scalability', 'maintainability'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: 'string', description: 'Primary file:line citation, e.g. api/app/claude_runner.py:120' },
          evidence: { type: 'string', description: 'What the code actually does, quoting the relevant lines' },
          impact: { type: 'string', description: 'Concrete failure or cost scenario' },
          fix: { type: 'string', description: 'Proportionate fix, one or two sentences' },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['real', 'severity_fair', 'why'],
  properties: {
    real: { type: 'boolean', description: 'true only if you confirmed the issue exists in the actual code' },
    severity_fair: { type: 'boolean', description: 'false if the severity is inflated for this codebase\'s scale' },
    why: { type: 'string', description: 'One or two sentences: what you checked and what you found' },
  },
}

const COMMON = `You are auditing the Software Factory, rooted at ${ROOT} — an autonomous agentic software factory: a FastAPI + SQLAlchemy + SQLite backend (api/app/), an Angular 22 signals-based SPA (web/src/app/), and a Claude Code headless runtime that actually builds software in git workspaces (api/app/claude_runner.py, claude_exec.py, claude_brain.py). Design docs: CONTEXT.md and docs/adr/0001..0012 (0006 resumability, 0007 stack+seams, 0008 event log, 0011 Claude runtime, 0012 feed). It has 38 pytest + 14 vitest tests, Docker compose, CI.

Judge it as a PRODUCTION-BOUND INTERNAL TOOL for a small team (tens of users, hundreds of requests, a handful of concurrent agent pipelines) — not hyperscale. SQLite and polling are deliberate ADR choices with documented swap seams; do not flag the choice itself, but DO flag where the current code would break, corrupt, stall, or become unmaintainable even at that modest scale.

Rules: READ the actual files before claiming anything — every finding must cite file:line you verified. No speculation, no style nitpicks, no "consider adding types" filler. Prefer fewer, real findings over many weak ones. Your final structured output is consumed by a program, not a human.`

const AUDITORS = [
  {
    key: 'concurrency',
    prompt: `Dimension: BACKEND CONCURRENCY & DATA INTEGRITY (stability).
Read api/app/main.py (lifespan auto-tick loop, route handlers, get_db dependency), api/app/db.py (engine/session config), api/app/claude_runner.py (run_pipeline background thread and its DB session usage), api/app/simulator.py.
Hunt for: SQLite single-writer contention between the request thread pool, the auto-tick loop, and pipeline threads (WAL mode? busy_timeout? check_same_thread?); sessions shared across threads or left open; race conditions between approve/retry/cancel routes and a running pipeline thread (e.g. cancel while Stage 3 runs — what happens?); transaction boundaries (partial writes on exception); idempotency of approve under double-click/replay; in-process state that desyncs from the DB.`,
  },
  {
    key: 'scalability',
    prompt: `Dimension: API & POLLING SCALABILITY.
Read api/app/main.py (especially list_requests with its last_event subquery, /api/events, /api/subjects/{key}/feed, /api/inbox), api/app/events.py, api/app/models.py (indexes), and web/src/app/core/poll.service.ts to understand the client's polling cadence and which endpoints every connected client hits per tick.
Hunt for: full-table or unpaginated responses that grow unboundedly (requests list, events with no after, audit/comments accumulation); missing indexes for the actual query shapes; per-tick cost per client (N clients x M requests math); payload bloat (RequestOut serializing turns/spec_lines everywhere?); the events table growing forever with no retention story; anything that makes the poll loop O(history) instead of O(new).`,
  },
  {
    key: 'backend-structure',
    prompt: `Dimension: BACKEND MAINTAINABILITY & STRUCTURE.
Read api/app/main.py end to end (469 lines — all routes, lifespan, migrations in one file), schemas.py, interview.py (get_brain seam), claude_exec.py (env reads), seed.py.
Hunt for: main.py doing routing + business logic + schema migration + backfill + auto-tick in one module (what's the proportionate split for this size — routers? service layer? where exactly?); ad-hoc column-add migrations in lifespan vs a real migration story (what breaks when models change next?); env-var config reads scattered across modules with no single settings object; duplicated business rules between simulator.py and claude_runner.py and routes; error handling consistency (HTTPException vs bare exceptions in threads); anything a new contributor would misread.`,
  },
  {
    key: 'frontend',
    prompt: `Dimension: FRONTEND ARCHITECTURE & MAINTAINABILITY.
Read web/src/app/core/poll.service.ts, api.service.ts, then the consumers: admin/pipeline.ts, board.ts, list.ts, queue.ts, inbox.ts, feed.ts, issue.ts, registry.ts, submitter/my-requests.ts, request-detail.ts.
Hunt for: the repeated per-component pattern effect(() => { poll.version(); api.requests().subscribe(...) }) — count the duplications and judge whether a shared store/resource keyed on poll.version is warranted now; subscriptions created inside effects without teardown (leak on effect re-run? Angular http completes, but verify the pattern); every view refetching the FULL requests list each tick while only feed.ts uses the delta signal (ADR 0012 says future surfaces should consume delta — who violates it); duplicated stage/status/glyph mapping logic across components vs core/util.ts; component files mixing template+styles+logic at 300-400 lines and where the seams should be; localStorage usage without schema/versioning.`,
  },
  {
    key: 'agent-pipeline',
    prompt: `Dimension: CLAUDE AGENT PIPELINE ROBUSTNESS (stability).
Read api/app/claude_runner.py end to end, claude_exec.py (subprocess handling), claude_brain.py, and how main.py starts run_pipeline on spec approve and approve_merge on merge approve. Cross-check against docs/adr/0006-stages-are-resumable.md and 0011-claude-code-runtime.md.
Hunt for: what happens when the server restarts mid-pipeline — the thread dies; is the request stuck in 'architecture/build' forever with no resume path (ADR 0006 violation)? Retry route — does it actually restart the Claude pipeline or only the simulator? Subprocess edge cases in claude_exec (timeout kills the process? orphaned children? stdout flooding? malformed JSON from the CLI?); workspaces/ disk growth with no cleanup; concurrent pipelines for two requests on the same app (workspace collision? git conflicts?); escalation paths that swallow the original exception; the tests-hash gate's blind spots (new test files? conftest edits?).`,
  },
  {
    key: 'ops',
    prompt: `Dimension: OPS, DEPLOYMENT & OBSERVABILITY.
Read Makefile, docker-compose.yml, api/Dockerfile, web/Dockerfile, web/nginx.conf, .github/workflows/ci.yml, scripts/smoke.sh, the /api/health route in api/app/main.py, and api/app/db.py for where the SQLite file lives.
Hunt for: SQLite backup/durability story on the Docker volume (none?); health endpoint depth (does it touch the DB? would it catch a locked/corrupt DB?); zero structured logging — when a pipeline fails in prod, what can an operator actually see beyond progress_events?; uvicorn worker count vs the in-process auto-tick loop and pipeline threads (what breaks with workers=2?); secrets/keys handling for the claude CLI in containers; CI gaps (no docker build check? no claude-mode test path?); graceful shutdown (lifespan cancels the tick task? pipeline threads on SIGTERM?).`,
  },
]

function verifyPrompt(f) {
  return `${COMMON}

You are an adversarial verifier. A prior auditor claims the following finding. Your job is to REFUTE it if you can. Read the cited file(s) yourself — do not trust the quoted evidence.

Title: ${f.title}
Area: ${f.area} | Claimed severity: ${f.severity}
Citation: ${f.file}
Evidence claimed: ${f.evidence}
Impact claimed: ${f.impact}
Proposed fix: ${f.fix}

Checks: (1) Does the cited code actually behave as claimed — open it and verify, including any guards/mitigations elsewhere the auditor may have missed (e.g. a lock, a unique constraint, an idempotency ledger, WAL pragma, an existing index, test coverage that pins the behavior). (2) Is the impact plausible at small-team internal-tool scale, or theoretical? (3) Is the severity fair? If you cannot confirm the issue in the real code, real=false. Default to real=false when uncertain.`
}

const results = await pipeline(
  AUDITORS,
  a => agent(`${COMMON}\n\n${a.prompt}`, { label: `audit:${a.key}`, phase: 'Audit', schema: FINDINGS }),
  (res, a) => {
    if (!res) return null
    const toVerify = res.findings.filter(f => f.severity !== 'low')
    const lows = res.findings.filter(f => f.severity === 'low')
    return parallel(toVerify.map(f => () =>
      agent(verifyPrompt(f), { label: `verify:${f.title.slice(0, 48)}`, phase: 'Verify', schema: VERDICT })
        .then(v => ({ ...f, dimension: a.key, verdict: v }))
    )).then(verified => ({
      dimension: a.key,
      summary: res.summary,
      confirmed: verified.filter(Boolean).filter(x => x.verdict.real),
      refuted: verified.filter(Boolean).filter(x => !x.verdict.real).map(x => ({ title: x.title, why: x.verdict.why })),
      low: lows,
    }))
  }
)

const out = results.filter(Boolean)
log(`Confirmed findings: ${out.reduce((n, d) => n + d.confirmed.length, 0)} across ${out.length} dimensions (${out.reduce((n, d) => n + d.refuted.length, 0)} refuted, ${out.reduce((n, d) => n + d.low.length, 0)} low unverified)`)
return out