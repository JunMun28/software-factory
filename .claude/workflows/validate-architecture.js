export const meta = {
  name: 'validate-architecture',
  description: 'Validate the ADR 0013 architecture guarantees: deterministic gate + adversarial code verification',
  whenToUse: 'After any change to api/app (runner, lifecycle, polling) or web/src/app/core — proves the hardening guarantees still hold.',
  phases: [
    { title: 'Gate', detail: 'make verify (pytest + vitest + build + smoke)' },
    { title: 'Refute', detail: 'one skeptic per guarantee, reading the live code' },
    { title: 'Synthesize', detail: 'verdict + anything a guarantee no longer covers' },
  ],
}

const ROOT = '/Users/wongjunmun/development/ai-development/software-factory'

const VERDICT = {
  type: 'object',
  required: ['holds', 'evidence', 'gaps'],
  properties: {
    holds: { type: 'boolean', description: 'true only if the guarantee is still mechanically enforced in the current code' },
    evidence: { type: 'string', description: 'file:line citations you verified' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'specific ways the guarantee can still be violated (empty if none found)' },
  },
}

// The ADR 0013 guarantees. Each verifier is adversarial: it tries to REFUTE
// the guarantee against the code as it exists NOW, not as the ADR describes it.
const GUARANTEES = [
  {
    key: 'no-stranded-requests',
    claim: 'A request can never be silently stranded: the stage loop in api/app/claude_runner.py catches all exceptions and escalates; _pytest treats timeouts as gate failures; the retry route in api/app/main.py calls claude_pipeline.start() in claude mode; the lifespan escalates approved mid-stage requests on boot. Tests: api/tests/test_architecture.py.',
  },
  {
    key: 'cancel-wins-honest-deploy',
    claim: 'A cancel always wins and the deploy is honest: _escalate and _review re-check status after long stages; the inbox query and approve route filter cancelled/done; approve_merge escalates on a failed or impossible merge instead of marking done; the approve transition is an atomic UPDATE WHERE status=pending_approval.',
  },
  {
    key: 'engine-config',
    claim: 'The SQLite engine sets WAL, busy_timeout and foreign_keys pragmas on connect (api/app/db.py); the auto-tick loop survives exceptions and runs via asyncio.to_thread (api/app/main.py); /api/health executes SELECT 1 and 503s on DB failure.',
  },
  {
    key: 'poll-o-new',
    claim: 'Polling is O(new): clients start from GET /api/events/cursor (web/src/app/core/poll.service.ts has no no-cursor events call on start and has an in-flight guard); list_requests filters in SQL with a limit and scopes the last-event lookup to returned ids; list_apps uses one grouped COUNT; the web views consume the shared Store (web/src/app/core/store.service.ts) instead of per-component poll.version() refetch effects (grep for "poll.version()" under web/src/app — only poll/store internals may reference it for list data; per-id detail effects are allowed).',
  },
  {
    key: 'isolation-gate-config-surface',
    claim: 'The test-isolation gate hashes every file under tests/ plus root conftest.py, pytest.ini, pyproject.toml, setup.cfg, tox.ini (CONFIG_SURFACE in api/app/claude_runner.py), and a violation reverts the test surface. A config-based deselection cheat is caught (test_isolation_gate_catches_config_cheat).',
  },
  {
    key: 'one-owner',
    claim: 'One owner per rule: env knobs only in api/app/settings.py (no os.environ reads for those knobs elsewhere except FACTORY_BRAIN/FACTORY_RUNNER in claude_exec.py); merge-gate/done transitions only in api/app/lifecycle.py (simulator and runner call it); schema migration is the generic diff in db.py migrate() with no hand-coded per-column branches in main.py; the demo seed is gated by FACTORY_SEED_DEMO and off in docker-compose.yml.',
  },
]

phase('Gate')
// the deterministic gate first — if this fails there is nothing to refute
const gate = await agent(
  `Run \`make verify\` from ${ROOT} (NOT from a subdirectory, and do not pipe it through tail — the exit code is the result). ` +
  'Report PASS or FAIL plus the final summary lines, and on failure the failing test names verbatim.',
  { label: 'make verify', phase: 'Gate' },
)

const verdicts = await parallel(GUARANTEES.map((g) => () =>
  agent(
    `You are an adversarial verifier for the Software Factory repo at ${ROOT}. ` +
    'Try to REFUTE the following architecture guarantee by reading the actual current code (do not trust the claim text — open the files). ' +
    'If you can construct a concrete sequence (request lifecycle, thread interleaving, restart, malicious agent output) that violates it, the guarantee does not hold.\n\n' +
    `GUARANTEE: ${g.claim}\n\n` +
    'Cite file:line for everything. holds=true only if you failed to refute it.',
    { label: `refute:${g.key}`, phase: 'Refute', schema: VERDICT },
  ).then((v) => ({ key: g.key, ...v }))
))

phase('Synthesize')
const checked = verdicts.filter(Boolean)
const broken = checked.filter((v) => !v.holds)
const gaps = checked.flatMap((v) => (v.gaps || []).map((s) => `${v.key}: ${s}`))
log(`gate: ${gate && gate.includes('PASS') ? 'PASS' : 'CHECK OUTPUT'} · guarantees: ${checked.length - broken.length}/${checked.length} hold · ${gaps.length} gaps noted`)

return {
  gate,
  guarantees: checked,
  broken: broken.map((v) => v.key),
  gaps,
}
