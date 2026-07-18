# Implementation notes — C9 data and disaster recovery (2026-07-17)

- **Unicode model collision warning.** `api/app/models.py` also collides with the
  parallel session. C9 therefore changes only the affected column-definition
  lines (plus the text-type imports/helpers); it makes no relationship, default,
  enum, or data-semantics edits.
- **Profiles stay separate.** The base remains the kind/dev SQLite profile. The
  local overlay adds the SQLite-on-PVC backup CronJob, while the prod overlay
  disables demo seeding and injects the Azure SQL URL from the external
  `factory-db` Secret.
- **Production migration order is explicit.** Record a fresh backup/PITR point,
  run the freshness-gated Alembic Job, then deploy the API. Startup migration is
  retained for dev compatibility but is not the production rollout mechanism.
- **DATA-07 is MSSQL-specific.** The real machine-transition path, `apply()`,
  takes `UPDLOCK, HOLDLOCK` on the leader epoch row before its fenced CAS under
  MSSQL RCSI. SQLite performs the same epoch check as a plain unlocked read.
  The older `cas_status()` primitive retains its MSSQL lock as well.

## Deferred to office / user handoff

- **DATA-04 — progress-event archival/partitioning.** `progress_event` remains
  append-only under ADR 0008. C9 never deletes or mutates historical events.
- **Live Azure SQL online type migration.** This revision's batch/direct alters
  are the dev and fresh-database path. A populated production database needs an
  office-run shadow-copy, validate, and swap runbook for the large text columns;
  that ONLINE procedure cannot be validated on kind or SQLite.
- **Migration Job Azure SQL egress.** The production endpoint/CIDR is not known
  in this checkout, so the pre-deploy Job's endpoint-specific NetworkPolicy is
  deferred to the Azure SQL cutover rather than pretending kind proves it.
- **MSSQL migration and drift CI.** SQLite migration drift remains covered here.
  MSSQL/Azure SQL drift belongs in the office MSSQL CI suite against a real SQL
  Server-compatible environment.
- **Machine-issued backup evidence.** The pre-deploy guard currently validates
  operator-supplied backup reference and freshness inputs. Replacing that trust
  with evidence issued by Azure Backup/PITR is an Azure-cutover handoff.
- **Azure SQL PITR cutover.** Provisioning, retention policy, a live restore
  exercise, and the production connection-string cutover remain office/user
  handoff work. The prod runbook treats the verified PITR point as the backup
  gate for migrations.

# Implementation notes — C6 security hardening [kind] (2026-07-17)

## Deferred to office / Phase 2

- **SEC-03 — authenticated, request-scoped git push.** The in-cluster git daemon
  cannot simply drop `--enable=receive-pack`: architecture, RED, and GREEN agents
  legitimately push their stage commits back to the request work branch. The local
  NetworkPolicy already limits port 9418 to `sf/tier=agent` pods, but it does not
  authenticate or scope one agent pod to one request. The real fix is an authenticated,
  request-scoped push backend, or the Phase-2 GitHub App flow with a short-lived
  per-request token that replaces this seam.
- **Office overlay.** SEC-01 Entra/OIDC API authentication, PodSecurity/Kyverno,
  MERGE-05 branch protection, and GitHub App per-request tokens remain office work.
  None of these controls is simulated in the local kind slice.

# Implementation notes — opencode as default agent runtime

Task: add **opencode** as a third `FACTORY_CLI` (alongside codex/claude), make it the
**default**, and prove it with a real full-pipeline end-to-end run.

# Implementation notes — C3 gate evidence and feedback fidelity (2026-07-16)

#Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations

- **Review retries re-run the read-only reviewer, not the implementer.** The retry
  grades the same SHA again and explicitly tells the reviewer to assess the unchanged
  code honestly. It can recover a missing/borderline verdict; repeated substantive
  objections escalate to a human rather than bouncing automatically to GREEN.
- **The review retry budget is per request, shared across preview rounds.** Attempt
  numbering includes superseded rows. After a C1 preview rewind, round-two review is
  attempt 2, so its first `REQUEST-CHANGES` reaches the existing cap and escalates
  immediately; it does not loop or grant another reviewer retry.
- **The non-kube AgentRunner escalates immediately on a non-APPROVE.** That runner has
  no durable per-attempt gate model; the kube production path owns the retry-once flow.
- **Reviewer output is scrubbed at parse time.** Both reasoning and retry feedback are
  redacted before append-only events, merge evidence, the jobs API, or
  `SF_GATE_FEEDBACK` can receive them. Jobs API envelopes and raw log tails are also
  recursively scrubbed at egress.

## Design decisions

- **One chokepoint, unchanged shape.** opencode joins codex/claude behind `run_agent`
  in `agent_exec.py`. New `_opencode_cmd` / `_run_opencode_cli`, mirroring the existing
  two branches. Nothing outside the seam learns a third vendor exists.
- **Headless invocation:** `opencode run --format json -m <provider/model> <prompt>`.
  `--format json` emits an NDJSON event stream; the agent's final message is the
  concatenation of the `type:"text"` parts (verified empirically — see below).
- **Read-only / write contract** (the crux — must be as hard as codex's OS sandbox):
  enforced by a **factory-owned config** pointed at via the `OPENCODE_CONFIG` env var,
  NOT the user's global opencode agents (their global `plan` agent is set to allow-all,
  so it is useless as a read-only guarantee).
  - read-only → `api/app/opencode/factory-readonly.json`: `edit/bash/webfetch = deny`.
  - write     → `api/app/opencode/factory-write.json`:   `edit/bash = allow`, `webfetch = deny`
    (build needs FS + shell for pytest/git; no network, matching codex `workspace-write`).
  Verified live: with the deny config a write attempt returns `DENIED` and no file is
  created (overriding the global allow-all); with the write config `opencode run` creates
  the file. See the two smoke tests in the task transcript.
- **Model:** `FACTORY_OPENCODE_MODEL` defaults to `openai/gpt-5.5` (authed here; matches
  the cost/intelligence profile in CLAUDE.md). opencode model ids are `provider/model`.
- **Foreign-model guard:** the brain passes claude/codex model ids for the prototype step
  (`_proto_model()`), but that already returns `None` unless the CLI is claude, so opencode
  uses `OPENCODE_MODEL`. Defense-in-depth: `_opencode_cmd` only forwards a `model` that
  looks like an opencode id (contains `/`); anything else falls back to `OPENCODE_MODEL`.

## Result

Full pipeline ran **green end-to-end** with opencode/gpt-5.5 as the live runner (REQ-2045,
feature `top_category`): architecture → RED (2 fail / 2 pass) → GREEN + test-isolation (4 pass)
→ review → human merge → `main` updated, status `done`, `pytest` on merged main = 4 passed.
Reviewer verdict was REQUEST-CHANGES (advisory — the human merge gate governs, as designed).

Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations

- **Simulator merge-gate email is post-commit.** The simulator now carries the
  table-owned gate notification through `Win.notify()` and fires it only after
  the per-request tick commit. Recipients and single-send behavior are unchanged,
  but a failed commit can no longer announce a gate that was rolled back.
- **`--dir` is mandatory, subprocess cwd is not enough.** The first full-pipeline run
  escalated at the architecture gate: the stage agent read the *software-factory repo root*
  (`api/`, `sample/`) instead of the per-request workspace, despite `Popen(cwd=ws)`. Headless
  `opencode run` resolves its project dir from `--dir` (it can attach to a server whose dir
  differs), NOT the process cwd. Fix: `_opencode_cmd` emits `--dir <cwd>` whenever a cwd is
  given. Verified: with `--dir` the agent reads the workspace's `SPEC.md`/`src/` correctly.
  (Codex/claude are unaffected — they honor process cwd, so this stays inside the opencode branch.)
- **Headless-autonomy directive needed.** Second run reached architecture but escalated at the
  RED gate: gpt-5.5 answered the stage prompt with a plan + "reply `OK` and I will proceed" and
  wrote no tests — a single-shot `run` has no one to say OK. Fix: the opencode adapter appends a
  short "you are headless, act in one turn, never ask for confirmation" directive (`_OPENCODE_HEADLESS`),
  the counterpart to claude's `--safe-mode`. Shared stage prompts stay CLI-neutral; only the
  opencode branch appends it.

---

## Lifecycle transitions — final wrap-up (2026-07-15)

- **Branch:** `lifecycle-transitions`
- **Seven-task commit series:** all seven implementation commits are present; the
  coordinator committed Task 7 as `9eeb068`.
  1. `acee7de` — transition table + `apply()`, the legal lifecycle write path
  2. `919ecce` — gate endpoints through `apply()`
  3. `903bb37` — submit/create through `apply()` with flush-first semantics
  4. `1e3703b` — simulator transitions, epoch fencing, commit-per-item
  5. `58c007b` — runner/startup transitions; `lifecycle.py` absorbed and deleted
  6. `8077a95` — shared `classify()` projection for mission, inbox, and detail
  7. `9eeb068` — Task 7 terminology, documentation, architecture assertion,
     characterization test, implementation notes, and final report
- **Verification:** `263 passed, 2 warnings`; `uv run ruff check .` passed. The
  full `task verify` chain passed lint, API tests, all 188 frontend tests, and both
  production builds, but this managed sandbox forbids the smoke server from binding
  `127.0.0.1:8911` (`Errno 1`), so it could not reach `✓ VERIFY PASSED` here.

#Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations

- `apply()` guards parameter-dependent effect construction so a consumed precondition
  resolves as `Loss`, while an eligible call with missing parameters still raises.
- `apply()` flushes staged sibling writes before its CAS, preserving them across the
  winner refresh while `Loss` still rolls the transaction back.
- Simulator merge-gate notification now fires through `Win.notify()` after commit;
  recipients and exactly-once behavior are unchanged, and rolled-back gates are not announced.
- Task 7 was subsequently committed by the coordinator as `9eeb068`.

Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations — generation-stream branch (2026-07-15)

- **GenerationStream constructor gained an optional 5th `opts` bag** beyond design
  D14's four positional args: the real per-component variance (three distinct
  "should I stream" decision points, two payload validators, onState side effects,
  error handlers) cannot ride four positionals. Documented in the plan; pinned by
  the class spec.
- **Four pre-approved micro-normalizations** (from the plan): prototype's poll gains
  clear-timer-before-re-arm; interview loses scroll-on-invalid-SSE-payload (its
  `busy` clear there was unreachable — verified); review/plan-panel gain
  clear-before-arm; all four share one teardown shape.
- **Final-review fix**: `drive()` now clears any pending poll tick first — a stale
  poll response could transiently overwrite an SSE terminal state (unreachable
  through the current four components; hardened because the class is a public
  surface). Garbled-SSE-payload fallback test ported from the deleted streamState
  spec.

Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations

- **B2 review — reset safety:** `workspace.reset_branch()` now stops immediately
  when the work-branch checkout fails. It never runs hard reset or clean against
  whichever branch happened to be checked out (especially `main`).
- **B2 review — 409 adoption:** same-name Job adoption is now limited to the
  crash-before-record case where no prior `StageJob` UID exists. Once any UID was
  recorded, both a lingering known UID and an unknown stranger UID park as infra;
  neither is adopted or graded.
- **B2 review — SHA input:** git-backed runs accept agent-supplied stage SHAs only
  when they match `^[0-9a-f]{40}$`. A malformed SHA becomes a recorded gate
  failure, while malformed historical graded SHAs are ignored as reset/merge
  targets.
- **B2 review — unset remote fallback:** `approve_merge()` delegates to the B1
  simulator path as soon as `FACTORY_GIT_REMOTE_BASE` is unset, before it computes
  a workspace path or reads graded git state.
- **B2 review — UID-safe deletion:** the small client-seam change was made rather
  than deferred: every runner deletion passes the recorded `StageJob.job_uid`, and
  `RealKubeClient` sends it as a `V1DeleteOptions` UID precondition. Deletes with no
  recorded UID retain the prior unconditioned behavior.
- **B2 review — capture docs:** `kube_jobs.py` now says running-pod output capture
  is attempted before deletion; only transfer failure remains best-effort.
- **Prior task-report deviation — wall-clock assertion:** the B1 wall-clock test's
  envelope assertion changed from the fake termination message to `None`. A pod
  that is still running has no terminated-container message, even though
  `capture=True` can already retrieve and persist its live logs.
- **Prior task-report deviation — retry timing:** `defer_spawn` added a deliberate
  one-tick delay after failed, timed-out, or infra observations so deterministic
  same-name Jobs are not recreated while their predecessors are still terminating.
  Nested gate-spawn failures now propagate the same delay.

## Plan B2 — kind cluster (2026-07-15)

- **Cluster:** kind v0.32.0 (node Kubernetes v1.36.1), Calico v3.30.3
  (server-side apply; enforcement PROVEN by `scripts/calico-probe.sh` —
  kindnet's silent NetworkPolicy no-op is the trap this avoids),
  ingress-nginx controller-v1.13.0 on host port 8081.
- **sf-agent image:** built on `ghcr.io/astral-sh/uv:python3.13-bookworm-slim`
  with git 2.39.5, pytest 9.1.1, node 24.18.0, codex-cli 0.144.4,
  opencode 1.18.1, @angular/cli, jq 1.6. All gate paths verified under
  `--user 12345:0` (arbitrary-UID proof) against the sample fixture; each
  printed envelope round-trips through `app.kube_jobs.parse_envelope`.
- **Manifests:** kustomize base + `overlays/local`; backend Service named
  `api` so the SPA images' baked `proxy_pass http://api:8000` stays
  unchanged; git-daemon sidecar exports `/data/workspaces` on 9418;
  SQLite-on-PVC by default (Azure SQL is a one-env swap, see plan
  decision 10).

#Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations (B2 cluster half)

- **codex sandbox inside pods:** the plan's `codex exec -s workspace-write`
  (and `-s read-only` for review) fails inside unprivileged containers —
  bubblewrap/landlock cannot create user namespaces, so EVERY exec/apply_patch
  errors and codex exits 0 having written nothing (found live: REQ-2045
  escalated with "architecture produced no PLAN.md" after 2 honest gate
  fails). Conservative fix: `-s danger-full-access` in-pod — the POD is the
  sandbox (non-root arbitrary UID, NetworkPolicy walls, ephemeral clone); the
  review stage stays read-only by construction (nothing pushed; the gate
  grades the pinned SHA on the orchestrator's own repo). Proven by local
  docker repro before rerunning the smoke.
- **Kind smoke run of record (2026-07-15):** REQ-2046 end-to-end in ~17 min,
  zero gate retries (run 1 failed on the codex-sandbox deviation above;
  run 2 clean). Architecture/red/green/review each ran as one codex agent
  Job + one gate Job; merge gate approved via API; workspace main tip =
  merge commit; all Jobs reaped; all 6 netpol walls re-proven in-run.
- **B2 post-merge review fixes:** stage-pod egress now excepts 169.254.0.0/16
  (link-local/IMDS — the SSRF wall this template must carry to Azure);
  netpol-smoke probes print SF_OPEN/SF_BLOCKED from inside the pod so an
  unschedulable probe fails loudly instead of reading as "blocked";
  calico-probe cleans its namespace on the failure path too; the review
  verdict grep is line-anchored so prose mentions can't count as a verdict.

## Plan B3 — produced-app build + deploy (2026-07-16)

- **Registry:** in-cluster `sf-registry` (registry:2) + containerd NodePort
  mirror — ONE image name (`sf-registry:5000/sf-app-<slug>`) for kaniko push
  (cluster DNS) and kubelet pull (mirror → localhost:30500). Both directions
  probed before the smoke: build-tier pod got HTTP 200 on /v2/, node crictl
  pull resolved through the mirror (404 manifest, not DNS failure).
- **Build:** kaniko (gcr.io/kaniko-project/executor:latest), non-privileged
  (allowPrivilegeEscalation false, drop ALL), clone init-container reuses
  sf-agent (`SF_ROLE=clone`); digest captured via
  `--digest-file=/dev/termination-log` on the existing capture-before-delete
  machinery.
- **Review wave (opus, 1 HIGH + 1 MEDIUM, both fixed + pinned):** a timed-out
  deploy row dead-ended the request after a human Retry (driver now re-applies
  when the last deploy row is dead — apply is create-or-update, the intent key
  is idempotent); an absent build Job (crash between row commit and create)
  escalated instead of re-running (now re-spawns, bounded at 3 consecutive
  infra rounds).
- **Deviations:** none beyond the plan; docker builds must run from a CLEAN
  worktree when the main checkout has another session's uncommitted edits
  (`git worktree add --detach`), and `.dockerignore` now exists because the
  intake build once copied `.claude/worktrees/` and filled the disk.
- **Live findings (first real build+deploy run, each fixed + re-proven):**
  (1) kaniko as UID 10101 dies unpacking rootfs ("chown /") — kaniko container
  now in-container root (no privileged mode, no escalation; the pre-recorded
  plan fallback); (2) `pip install` inside the build needs package indexes —
  FQDN allowlists don't exist in vanilla NetworkPolicy, so build-walls egress
  is internet-except-cluster+IMDS (stage-pod shape; office/AKS profiles put
  Artifactory/EgressFirewall behind the same seam); (3) `rollout_ready` reads
  the deployments/status SUBRESOURCE — its own RBAC rule; (4) app-walls must
  admit the factory-api pod on :8000 — the runner's deploy-verify health probe
  is the one in-cluster caller besides the ingress. The escalate → Retry →
  re-drive loop recovered the same request through all four fixes with no
  rebuild of anything but the failed leg — the review-wave re-drive path,
  exercised live.

---

# Implementation notes — IntakeDraft stale-answer leak fix (2026-07-16)

Task: stop a previous request's in-memory draft answers (reach/impact/app) from
leaking into a newly opened/created request.

## Root cause

`IntakeDraft.hydrateFrom()` stamped `requestId = d.id` and then early-returned
whenever the draft was "live" (`type != null`) — keeping every OTHER field from
the PREVIOUS request. Any later `save()` (ring click, blur, type pick) PATCHed
request A's answers onto request B. Reproduced live: with a live draft on
request 99 (`reach='me'`), SPA-navigating (list → interview) to request 97
produced a draft claiming to be 97 while still holding 99's answers.

## Fix

`hydrateFrom()` now calls `reset()` whenever the incoming `d.id` differs from
the draft's own `requestId`, before hydrating from the server. Same-request
re-hydration keeps in-session edits exactly as before (including
`typeConfidence < 1`, which the basics wizard relies on to never pre-select a
type). Reset-then-hydrate also covers "server value is null" — fields return to
defaults instead of retaining stale values. Two new specs in
`intake-draft.service.spec.ts` (72 intake tests green).

Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations

- The task suggested also resetting the draft in `new-request.ts` on mount.
  NOT done (conservative choice): Review's "Edit details" intentionally lands on
  `/submit/new` with a live draft to keep editing it (see `sub-shell.startNew`
  comment), and `save()` PATCHes the full body — clearing basics on mount would
  wipe the stored answers on the server for that legitimate flow. With the
  `hydrateFrom` guard, the cross-request leak is closed at the single chokepoint;
  deep-linking to `/submit/new` with a live draft now means "resume editing that
  draft" (the old description is visibly prefilled in the composer), which
  matches the Edit-details semantics.
- Noticed, out of scope: `Interview.id` reads the route param from a SNAPSHOT,
  so a hypothetical interview→interview param-only navigation reuses the
  component with a stale id. No in-app link does this today; worth a
  paramMap-subscription if one ever appears.

## Console overview redesign (2026-07-16)

User rejected the narrative Floor home page. Rebuilt `/` as an admin
dashboard with two zones:

1. **Waiting on you** — a dense decision queue derived from `/api/mission`:
   gate rows (spec gate = "approve to build", merge gate = "approve to
   deploy") with inline evidence bits + Approve / Send back; needs-human
   rows with the four recovery verbs; human-owned rows.
2. **Pipeline board** — bird's-eye of every open request across five fixed
   columns: Intake & Spec, Architecture, Build, Review & Preview, Deploy.
   Populated from the Store's `/api/requests` projection, with run overlays
   (step x of y, health) joined from mission runs. Approval boundaries are
   drawn on the Architecture and Deploy column headers (amber diamond,
   "enters by approval") — the two human gates are visible in the geometry.

Mechanics kept, not rebuilt: gate modals, action plumbing (409 outcomes),
j/k + a/s keyboard flow, poll loop. `FloorGateCard` deleted (queue rows
replaced it). Shell nav label Floor → Overview; shell gains a `wide` input
so the board gets 1400px while other pages keep 1060px.

`stage: 'deploy'` added to the shared FactoryRequest type (backend B3
already emits it via begin_deploy).

#Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations
- "Steer next step" dropped from the home page (was on every lane card);
  still available per-request in the dossier, which is the scoped place
  for it. Conservative: no backend change, no feature loss.

## Plan B4a — the approve-deploy human gate (2026-07-16)

- Spec §4.10's second console gate is live: after a real merge (kube + git +
  app-deploy mode) the request WAITS at `approve_deploy`; a second console
  approval (approver identity in `deploy_claimed`/`approved_deploy` audit rows
  and the release milestone) starts the kaniko build + deploy. The one
  behavioral guard is `_drive_deploys`' `gate IS NULL` clause.
- Routing: `stage=="deploy"` is the discriminator that peels the deploy family
  off the merge family in the approve endpoint; a deploy replay landing after
  `done` falls through to the merge family and resolves as a clean 409.
- Console changes are additive only (gate union + one branch per site); the
  merge gate's existing copy is untouched.
- Half B (GitHub) is planned and user-approved but deferred — see the B4 plan.

## Plan B4b — GitHub as the real remote (2026-07-16)

- Agents push to `github.com/<owner>/sf-app-<slug>` (private, created via the
  intent log); the orchestrator fetches pushed SHAs + merged main into its
  local mirror; gate/build pods keep cloning `git://api:9418` — the walls are
  unchanged. Merge = GitHub API with the head==graded-SHA precondition; an
  ancestor guard makes merge replay safe after a "merged on GitHub but mirror
  stale" escalation.
- Token hygiene (review-verified): the PAT rides an optional Secret env into
  STAGE pods only; every git error string passes `sanitize_github_git_error`;
  the entrypoint silences clone/push stderr and the read-only review stage
  drops its credentialed origin right after the clone (review fixes).
- `FACTORY_GITHUB_TOKEN` unset = byte-for-byte git-daemon mode (review
  confirmed at every call site). Deferred/acknowledged: post-done deploy-
  approve replay is a plain 409; the full retry→tick→re-approve mirror-stale
  recovery path is unit-proven only at the approve_merge level.

## Plan C — end-to-end factory improvement program (2026-07-16)

Full e2e audit (15 subagents + concurrency attacker + synthesizer) → gap
register + roadmap in `docs/reviews/factory-e2e-gap-analysis-2026-07-16.md`
(63 gaps: 6 CRITICAL / 24 HIGH / 24 MED / 9 LOW). Roadmap slices C1–C9;
approved build order C2 → C1 → C4 → C3 → C5 → C7 → C6 → C8/C9. C1 = the
mandated preview & feedback loop (pre-merge placement).

#Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations — C2 (correctness & failure-recovery hotfixes)

- **C2 split into C2a + C2b.** The design→adversarial-verify workflow returned
  NEEDS_WORK on all 8 gaps with genuine (not nitpick) findings. OPERATE-02 +
  DEPLOY-03 (the two prod-destroying bugs, both in the teardown/reaping area)
  are well-understood post-review and ship as **C2a** now. FAIL-01/02/03/04 have
  real design subtlety (FAIL-01: a git timeout inside `surface_hash_at` would
  flip a passing green to fail AND the timeout sentinel embeds the authed URL =
  PAT leak; FAIL-04: never-scheduled pods never reach a terminal grade because
  `JOB_ACTIVE_DEADLINE`(1800) < `STAGE_WALL_CLOCK`(2100); FAIL-03 couples to
  C1's merge-gate re-entry) and touch the same `kube_client` methods, so they
  get a v2 design pass as **C2b** after C2a lands. Conservative: ship the
  critical safety fixes first, don't rush the entangled reliability set.
- **FAIL-07 + DEPLOY-05 (rollback rewrite) deferred to C8.** Both came back
  invariant-UNSAFE as designed and are entangled with app-registration
  (OPERATE-01). Rollback is less urgent than the teardown/orphan bugs. The
  coherent rollback rewrite belongs with C8 where the app/rollback lifecycle is
  built. C2a's OPERATE-02 writes the invariant C8 must honor: **a live digest is
  always backed by a durable `succeeded` deploy StageJob under the shared
  `app_id`** (else teardown's `_slug_has_live_app` fails open).
- **OPERATE-02 scoped to DELETION safety only.** The fix guarantees a failed
  follow-up never *deletes* a live sibling's app. It does NOT address apply-time
  *overwrite* (`_apply_deploy` writes the shared `sf/instance=<slug>` Deployment
  before rollout/health passes) — that is blue-green cutover safety, deferred to
  C8. Safe today because apps are unregistered (ephemeral slug = req.ref; no
  shared prod exists yet). **Hard precondition handed to OPERATE-01:** the
  request owning the first succeeded deploy MUST carry the shared `app_id`
  (backfill onto A, not just follow-ups), or teardown fails open into the
  original nuke-prod bug.
- **Ownership by DB, not cluster label.** Shared prod (`sf/instance=<slug>`) is
  deleted only when `_slug_has_live_app` is false (no request sharing the slug
  has a succeeded deploy). Ephemeral/preview resources use `sf/request=<lref>`;
  C1 preview manifests MUST label previews `sf/request` (never `sf/instance`).
- **StageJob.role widened String(8)→String(16)** (migration): "teardown" is
  exactly 8 chars = zero headroom on MSSQL VARCHAR(8), and C1 adds
  preview/replan roles. Stale `# stage | gate` comment updated.
- **31 pre-existing orphaned pods** (no ownerReference, uncollectable by the
  Foreground/ttl fix) cleaned out-of-band via kubectl; the code fix prevents
  future orphans. teardown "once" is once-per-episode (idempotent under crash).

#Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations — C2b (runner reliability: FAIL-01/02/04)

- **Implemented by codex gpt-5.5** from the v2 specs (all 3 came back READY from
  the design→verify workflow); coordinator reviewed + verified.
- **Tick-age WATCHDOG deferred to C7.** The FAIL-01 v2 design added a
  `heartbeat.py` liveness module + a main.py watchdog loop that alerts when a
  git/k8s call ignores its own timeout. Two problems: (1) it overlaps OBS-02
  (C7's livenessProbe) — same concern; (2) BASELINE CONTAMINATION — the design
  workflow read the MAIN checkout, which carries the parallel session's
  UNTRACKED `api/app/heartbeat.py` + modified `main.py`, so the design assumed a
  heartbeat module my clean-HEAD worktree doesn't have. codex reconstructed a
  different heartbeat.py, which would collide with the parallel session's. Fix:
  dropped the watchdog trio (heartbeat.py/main.py/system.py + test_watchdog.py)
  from C2b → C7, keeping FAIL-01's CORE (git+k8s timeouts classified as infra),
  which is fully self-contained. **Lesson: point design workflows at a CLEAN
  worktree, not the main checkout, so parallel WIP never contaminates a spec.**
- FAIL-01 core kept: GIT_TIMEOUT + KUBE_CONNECT/READ_TIMEOUT bound every git
  subprocess + k8s call; a git timeout during surface hashing is classified
  INFRA (retry-neutral), never a test-isolation "violation" that would flip a
  passing green to fail; no authed URL/token in any error string.
- FAIL-02: single shared GATE_INFRA_LIMIT cap now binds the _next_work
  stage-infra + 409-park paths (were uncapped). FAIL-04: OOM/Unschedulable/
  ImagePullBackOff/quota classified as infra with a named reason, reading pod
  conditions for the never-scheduled family (which hits the Job deadline with no
  container); FakeKubeClient models the real no-container terminal shape.
- Stacked on c2-hotfixes (branch c2b-reliability); shares C2a's merge-hold.

## Plan C1 — preview & feedback loop (2026-07-16)

The mandated headline: a non-technical requester SEES the produced app and can
request changes BEFORE prod deploy. Design reconciled from audit-preview-loop.md
+ a6-preview.md via a design→verify workflow (v1 found 4 blockers → v2 resolved
them, verified CAS-race-closed + zero-frontend). Implemented by codex from the
v2 spec; adversarially reviewed SOUND ("ship it", headline race closed).

Shape: PRE-MERGE placement (after review gate, before merge gate), env-gated
FACTORY_PREVIEW (OFF == B4 byte-for-byte). New `preview` stage; requester-held
`accept_preview` gate; `_drive_previews` builds the last-graded SHA off the work
branch into an ephemeral `sf-app-<slug>-preview` at `<slug>-preview.<domain>`
(labeled sf/request — C2a's teardown reclaims it, never touches prod). Accept →
raise_merge_gate → the SHA-preconditioned GitHub merge ships EXACTLY the accepted
SHA. Request-changes → PreviewFeedback row → rewind to architecture with
SF_PREVIEW_FEEDBACK → full red→green→review re-grade → new preview (same env
rolls, stable URL). All-in-gates.py endpoints (requester respond-actor pattern);
ZERO frontend/shared/main.py edits (parallel session owns those).

#Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations / decisions — C1

- **Backend + kind-smoke ONLY; rich Stream/console requester UI deferred to a P4
  phase** — the parallel session is actively rebuilding console+intake; the loop
  is proven end-to-end over HTTP (curl) so no TS is imported / no collision.
- **CAS race (the a936f8c class) closed** by a terminal-audit guard on the WHOLE
  _drive_previews machine: no-op when the newest decisive audit is merge_claimed
  (within MERGE_CLAIM_GRACE) or preview_accepted, so it can't steal
  raise_deploy_gate's CAS during the merge window. raise_accept_gate is atomic
  with the pdeploy→succeeded write (one commit, rolled back on Loss).
- **Round-scoped preview-deploy intent** `deploy_preview:<slug>:<digest>:r<N>`;
  progression gated on round-scoped StageJob absence, never intent novelty (a
  byte-identical rebuild across rounds still mints a fresh accept gate).
- **claim_accept + request_changes clear needs_human** (the v2 surviving blocker)
  — else TTL-escalated accept-on-behalf would tear down the accepted prod app,
  or request-changes-on-behalf would strand the rewound request.
- **PREREQ fixed:** _supersede_rewound_rows now uses KUBE_STAGE_INDEX.get() at
  both call sites (kube_runner.py:218 observe loop + :1373 _next_work) so a
  preview/deploy-stage row can't ValueError-brick the tick.
- **TTL keeps the env** (escalate without teardown) so an operator can
  accept-on-behalf; _reap_dead_requests extended to pbuild/pdeploy roles so a
  cancel mid-build doesn't leak the env.
- Migration f6a8c0e2b4d6 chains from the C2a head d4e6f8a0c2b4 (NOT the parallel
  session's untracked c9d1f3a5b7e2). Stacked on c2b-reliability; shares the
  merge-hold. LIVE kind-smoke (real preview env + feedback round) is the
  remaining validation.

## Plan C4 — acceptance-criteria contract (2026-07-16)

The grading backbone (INTAKE-02/06). At approve_spec the orchestrator derives
numbered stable-id AcceptanceCriterion rows (AC-n, carried forward across
preview rounds by text match) + an IMMUTABLE SpecSnapshot (SPEC.md + AC JSON +
sha256). RED writes tests/acceptance.json (AC->pytest nodes); the ORCHESTRATOR
recomputes coverage on its OWN git copy at the graded SHA (git show, AST
node-check — never trusts the pod, mirrors surface_hash_at), emits an
append-only acceptance_coverage event folded into the merge-gate evidence.
Backend + tests only; codex-built from the vetted design + corrections;
reviewed SOUND. 497 pytest + full verify green.

#Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations / decisions — C4
- **v1 is ADDITIVE-NON-BLOCKING**: coverage is EVIDENCE, never a gate pass/fail
  predicate (tested: a 0%-coverage request still passes RED/review/merge).
  FACTORY_ACCEPTANCE is a default-ON kill-switch (OFF = byte-for-byte pre-C4).
  Tightening the gate on coverage is a PHASED v3 (BUILD-02), and per-AC
  behavioral grading is v2 (REVIEW-04) — structural coverage alone can't tell a
  real test from `def test(): pass`, so it must not gate yet.
- **Anti-gaming (adversarial-caught blocker)**: coverage counts DISTINCT nodes
  and rejects fan-in (an AC mapped only to a node shared by ALL ACs scores 0);
  surfaces distinct_covering_nodes + max_fanin. Class-based node ids parsed via
  AST (ClassDef->FunctionDef), not a regex.
- **Preview-round freshness**: the per-round ACCEPTANCE.md is written by
  workspace.refresh_contract on the rerun refresh path (NOT ensure_repo, which
  early-returns) so a request_changes round's new ACs reach the RED pod.
- **Snapshot**: INSERT-only, UniqueConstraint(request_id,version), fidelity
  tested (snapshot.spec_md == committed SPEC.md blob); relationship cascade=all
  (no delete-orphan).
- Migration a1b2c3d4e5f6 chains from the C1 head f6a8c0e2b4d6. Stacked on
  c1-preview; shares the merge-hold. A merge migration reconciling the parallel
  session's c9d1f3a5b7e2 is expected at integration.

## Plan C5 — production-parity infra (2026-07-16)

DEPLOY-01/02/04/06 + SEC-06[kind] + BUILD-02. codex-implemented (opus review
capped this session; codex adversarial review + coordinator spot-check of the
GC safety invariant). 528 pytest + ruff + kustomize + JS + lifecycle smoke green.

- **Registry GC is FAIL-CLOSED and never deletes a live digest** (registry.py):
  protected set = every non-terminal request's build/pbuild/deploy/pdeploy digest
  + every live sf/tier=app Deployment image + rollback history; RAISES on a
  missing/malformed live digest; double-snapshots protection around the manifest
  listing; on ANY snapshot failure deletes NOTHING. Only unprotected digests past
  REGISTRY_RETENTION are manifest-deleted (online); blob reclaim is a documented
  scale-down maintenance step, never a live-racing op.
- Registry PVC (RWO, /var/lib/registry, strategy Recreate). FACTORY_BUILD_CAP=4
  gates build/pbuild/deploy spawns oldest-first (no tick deadlock — running work
  is still observed and drains via deadlines). ResourceQuota + LimitRange
  (deploy/base/quota.yaml). kaniko pinned to executor:v1.23.2 (digest-pin TODO —
  gcr.io DNS blocked offline). gitleaks committed-diff gate (absent-binary skips;
  exit 1 = block, other exit = inconclusive-skip not false-block). Gate pre-bakes
  fastapi/uvicorn/httpx/pydantic/pytest so dep-importing tests grade; RED now
  requires a genuine 'failed' (not a collection/setup ERROR) before passing.

### Phased / deferred (noted, not built)
- Full Trivy IMAGE scan + registry AUTH -> office overlay.
- Arbitrary per-app requirements.txt install (needs gate-pod egress) -> phased.
- factory-api Guaranteed-QoS + a high PriorityClass so it's never evicted under
  quota pressure -> office hardening (numeric fit confirmed for kind; not a
  correctness bug). kaniko digest-pin -> resolve the digest at image-build time.

## Plan C7 — observability & cost (2026-07-16)

COST-01/02/03 + OBS-03/04. codex-implemented (opus review capped; codex review +
coordinator spot-check). 537 pytest + full verify green. Backend + API only.

- COST-01: per-stage job-minutes (StageJob timestamps) + best-effort codex/opencode
  token usage captured into the envelope; aggregated in a new cost.py; exposed via
  GET /api/requests/{rid}/cost + /api/cost/fleet (events.py router — mission.py
  untouched). No schema change.
- COST-02: per-app in-flight cap (FACTORY_PER_APP_CAP) so one requester can't
  monopolize KUBE_JOB_CAP; queue position surfaced. COST-03: per-request lifetime
  attempt budget (FACTORY_REQUEST_ATTEMPT_BUDGET) — an exhausted budget makes Retry
  ESCALATE instead of re-running. Neither deadlocks the tick (running work still
  observed/drained).
- OBS-03: kube-mode run_state health is now based on time-in-stage vs deadline_at,
  not 30s step-recency (which made every healthy 35-min stage read "slow").
- OBS-04: StageJob.logs_tail byte-capped at capture (FACTORY_LOGS_TAIL_MAX);
  backward trace cursor (before_cursor keyset) for navigating a long append-only
  log without loading it all. progress_event is NEVER mutated (ADR 0008).

### Deferred (parallel-collision / office)
- OBS-02 livenessProbe + tick-age WATCHDOG (main.py + routers/system.py + the
  parallel session's api/app/heartbeat.py) — reconcile after the stack merges;
  C1's watchdog folds here too.
- progress_event ARCHIVAL/partitioning for the Azure 2GB ceiling -> C9 (office);
  never DELETE rows.

## Plan C8 — operate lifecycle (2026-07-16)

OPERATE-01 + OPERATE-03 + FAIL-07/DEPLOY-05 rollback. codex-built + codex-reviewed
(1 CRITICAL + 2 HIGH + 2 MED found and fixed) + coordinator spot-check of the
C2a interaction. 564 pytest + full verify green. Backend only, no schema change.

- OPERATE-01: at first deploy of an app_id-None request, a fenced
  register_produced_app transition creates a stable-key App (hash-suffixed on
  collision) + sets req.app_id BEFORE _apply_deploy, so the app deploys under the
  stable slug AND the succeeding request carries the shared app_id — satisfying
  C2a's teardown precondition (a failed follow-up's teardown preserves the live
  sibling). _teardown_app / _slug_has_live_app bodies UNCHANGED.
- **Apply-time cutover safety (the C2a-deferred CRITICAL, armed by OPERATE-01):**
  the produced-app Deployment is now RollingUpdate maxUnavailable:0 / maxSurge:1,
  so a failed follow-up's new pods can NEVER displace the live old pods — the
  rollout stalls, prod keeps serving, and _observe_deploy escalates. Last-good is
  guaranteed to stay live.
- OPERATE-03: a rate-limited, timeout-bounded tick-loop /health probe of live
  apps; one incident event per state transition (not per tick); bounded SQL (no
  N+1 / no loading the whole append-only log per tick).
- FAIL-07/DEPLOY-05: rollback is HTTP-enqueue-only; the single-threaded tick does
  the fenced apply + the "refuse while a deploy/rollback for the slug is running"
  check (serial => atomic, no SQLite FOR UPDATE reliance); records success + the
  durable succeeded-deploy witness ONLY after rollout_ready + /health 2xx + the
  live image digest matches the rollback target; intent stays pending on failure.

### Deferred (noted): BRAIN-01 (wire+test the FACTORY_BRAIN=agent real-LLM intake),
SPA-01 (factory-self release pipeline — office), CONTRACT-01 (OpenAPI codegen —
TS/parallel), A11Y-01 (SPA — parallel), OPERATE-04 (role in the console UI —
parallel; server role wall already exists).

## Plan C9 — data & DR (2026-07-16) — FINAL Plan C slice

DATA-01/02/03/05/06/07. codex-built + codex-reviewed (1 CRITICAL + 4 HIGH found;
the buildable ones fixed, the MSSQL/Azure-cutover ones documented as office).
617 pytest + full verify + lifecycle smoke green.

- DATA-01 (CRITICAL): human-text columns are Unicode — String(n)/Text ->
  with_variant(NVARCHAR(n)/NVARCHAR(MAX), "mssql") (renders NVARCHAR, NOT the
  legacy NTEXT) so Azure SQL won't corrupt emoji/CJK/curly-quotes. Enum/key/ref/
  digest/role columns untouched. Migration e7f9a1c3d5b7 (down_revision
  a1b2c3d4e5f6, batch-mode for SQLite; drops+recreates the operators.email unique
  index around the alter; downgrade refuses a lossy conversion). Unicode
  round-trip test. **models.py collides with the parallel session — surgical
  column-type edits only; reconcile at merge.**
- DATA-02: deploy/overlays/prod (SEED_DEMO=0 + DB_URL-from-Secret); base stays
  the kind/dev SQLite+seed profile.
- DATA-03: a SQLite-on-PVC backup CronJob + scripts/restore-db.sh (refuses while
  writers are up; move-aside + atomic swap + rollback on failure, preserving the
  live DB/WAL/SHM trio until success) + a drill test (incl. failed-swap/active-WAL).
- DATA-05: a model<->migration drift test (SQLite). DATA-06: scripts/
  pre-deploy-migrate.sh + a migration Job manifest (migrate as a gated pre-deploy
  step, not auto-at-startup on the sole replica).
- DATA-07: the UPDLOCK/HOLDLOCK epoch read is now inside apply() (the real
  fenced-CAS machine path, not just cas_status()), MSSQL-guarded / SQLite no-op —
  closes the RCSI CAS race that the merge-claim race was an instance of.

### Deferred to the Azure SQL cutover (office / user handoff — can't validate without MSSQL):
the full ONLINE MSSQL type migration (shadow-copy/validate/swap on a live Azure DB
— the batch migration here is the fresh-DB path); the migration Job's egress to
the real Azure SQL endpoint; MSSQL migration/drift CI; machine-issued backup
evidence for the pre-deploy guard; Azure PITR; DATA-04 progress_event archival
(never DELETE — ADR 0008).
## Console gap closure — all six (2026-07-16, after the gap analysis)

Implemented every gap from docs/reviews/console-gap-analysis-2026-07-16.md:

1. **Evidence hardening** — `evidenceBits(null)` is now a red bit; the Approve
   modal takes the gate's evidence and, when a merge/deploy gate has none,
   shows a role=alert warning and relabels the button "Approve without
   evidence". Gate rows link to the repo.
2. **Queue triage** — gates sort by intake priority then longest-waiting;
   rows carry "waiting 5w" age chips (amber past 24h); app filter chips
   appear when the queue exceeds 6; the repeated consequence line is gone
   (the modal owns the irreversible steps). Queue derivation + filter hoisted
   to FloorPage so keyboard j/k order always matches the rendered rows.
3. **Factory gauges** — MissionOut gains `stats` (median cycle, median gate
   wait from decision vs. last gate_event, shipped_7d, oldest gate age),
   rendered in the Overview pulse. New `heartbeat` module: the tick loop
   beats per completed leader pass; /api/health reports `tick_age_s` +
   `deploy_enabled`; the shell badge goes red "Tick stalled Xm" past 120s
   (never for runner=agent, which has no tick loop).
4. **Fleet view** — AppOut gains `last_deploy` {digest,url,at,rollback} read
   from the append-only log (deploy gate_events carry digest+url); Library
   gets "The fleet": per-app live URL, deploy age, open counts, expandable
   deploy history.
5. **Rollback** — POST /api/apps/{id}/rollback re-applies digest-pinned
   manifests via the KubeClient seam, only for digests found in that app's
   own history; records a recovery_action event (which then reads back as
   the live deploy). Library history rows offer "Roll back to this" behind
   the RecoveryConfirm modal.
6. **Roles** — Operator.role (admin|viewer, server_default admin; alembic
   c9d1f3a5b7e2 for MSSQL, generic migrate() covers SQLite). All gate
   decisions + rollback go through `require_approver` → 403 for viewers.
   Studio picker shows a "viewer · read-only" chip. Entra auth itself
   remains a user handoff (Azure tenant).

Verified: task verify fully green (387 pytest + 231 vitest + builds +
smoke); live browser check on :4203 (light + dark) — gauges, filters, age
chips, red no-evidence, blind-approve modal, fleet strip all confirmed.

#Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations
- "Preview before approve" (staging deploy at review time) NOT built: with
  the B4 three-gate flow the deploy gate fires before any image exists, so
  an honest preview needs a staging build pipeline — logged as follow-up,
  not faked with a dead link.
- Board cards don't carry live-app links (a card is already an <a>; nested
  anchors are invalid HTML). The live link lives in the fleet card instead.

## Self-harness adapted slice (2026-07-16, after the integration analysis)

Built the four slices recommended by
docs/reviews/self-harness-integration-analysis-2026-07-16.md §4 — the
"record + human-approved improvement" adaptation; the paper's automated
mine→propose→validate loop stays explicitly NOT built.

1. **One prompt store** — `app/harness.py`: docker/sf-agent/prompts/*.md is
   the single source; AgentRunner's four inline f-strings replaced with
   `harness.stage_prompt(stage)` (the in-process review contract — REVIEW.md
   artifact + diff summary — is appended, never baked into the shared base).
   `test_prompt_parity.py` pins the contract.
2. **Lineage** — `HARNESS_VERSION` = 12-hex digest of the prompt pack +
   policy knobs, stamped on every role="stage" StageJob row and passed as
   SF_HARNESS_VERSION to stage pods. Alembic e7a9c1d3b5f0.
3. **Structured human reject** — reject_merge_gate / reject_deploy_gate
   transitions + POST /api/requests/{rid}/reject-gate (typed reason_code +
   reason): audit `rejected_merge|rejected_deploy` + gate_event evidence,
   escalates for normal recovery, and stages Request.pending_feedback so the
   human reason rides into the next attempt exactly like SF_GATE_FEEDBACK.
   send_back_to_stage reasons now also reach the agent (they never did).
   Approve notes are no longer discarded (merge/deploy audit rows keep them).
4. **Pressure report** — GET /api/harness/pressure: read-time projection over
   StageJob + audits (NO new table, per the skeptic adjudication), bucketed
   by (stage, verifier cause) via `harness.classify_reason`, with the
   governing prompt file and per-version counts named per bucket.

#Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations
- **Deploy-reject shield (added, conservative):** a rejected deploy leaves
  (stage=deploy, gate=None) — the exact state begin_deploy produces — so a
  later Retry would have silently deployed, and the escalation branch would
  have run the slug-scoped `_teardown_app` (OPERATE-02: could delete a
  PREVIOUS request's live app). `_deploy_rejected` now short-circuits the
  driver: never build, never tear down; after Retry the deploy gate is
  re-raised so the human decision comes back.
- harness_version lineage is kube-path only — the in-process runner creates
  no StageJob rows, so there is nothing to stamp there.
- pending_feedback is last-writer-wins: a send-back reason replaces an
  earlier staged reject reason (the newest human instruction is the
  actionable one; the older text stays in the audit/event log).
- No console UI for reject-gate / the pressure report — API slices only, as
  recommended; UI is follow-up work.

### Review wave (2026-07-16, opus panel + independent gpt-5.5/codex pass)
Fixed after review (all re-verified green):
- pending_feedback was consumed-and-committed BEFORE the fallible
  workspace-prep/Job-create steps — a prep or create failure silently lost the
  human's reason. Now consumed only after the Job exists (uid recorded); a
  regression test kills the create mid-spawn and proves delivery on re-spawn.
- Gate rows carried no harness_version, so the pressure report could never
  attribute typed gate causes to a version (the tests had masked it). Gate
  rows now inherit the graded stage row's stamp.
- Send-back notes with a "(word) " prefix minted spurious reason_code buckets
  — prefix parsing is now reject-only.
- The API Docker image never shipped the prompt store, so HARNESS_VERSION in
  a container digested "<missing>" files (lineage would never move with prompt
  edits). Dockerfile now bakes /srv/prompts + FACTORY_PROMPTS; harness.py logs
  loudly when files are missing.
- Deploy rejects no longer stage pending_feedback: the work is already merged,
  so no agent attempt can consume it (send-back is pre-merge only) — the
  reason lives in audit + gate_event evidence. Merge rejects still deliver.
- Human note now rides FIRST in the merged SF_GATE_FEEDBACK (the 2000-char cap
  truncates the tail); RejectGateIn.reason capped at 1800 so it survives whole.
- Infra rows now keep a typed reason on the envelope (workspace prep, capture
  miss) so the report's workspace_infra/capture_miss buckets actually fire;
  invalid-stage-SHA maps to clone_infra; spawn step_summary payload records
  the CLI + harness_version durably (Job env dies with the pod).

Accepted (documented, not fixed here):
- Cancel-at-deploy-gate can tear down a PREVIOUS request's live app —
  PRE-EXISTING (OPERATE-02 family), confirmed trace, spun off as its own task
  chip; the new reject path is shielded, cancel is not.
- Retry after a merge reject re-raises the gate from the existing review
  without re-running work (feedback undelivered until a send-back) — retry
  means "bring the gate back"; use send-back-to-stage to redo work.
- Consume-after-create is at-least-once: a crash between Job create and the
  feedback-clear commit can re-deliver the same note on the next attempt —
  chosen over at-most-zero.
- In-process (dev) runner still consumes feedback at prompt-build time; an
  executor failure before the agent runs loses it. Kube (production) path is
  exact.
- Reject replay shares the house ABA property of approve (a very stale replay
  against a RE-RAISED gate acts on the new artifact) — inherent to ADR 0006.
- Human pressure buckets carry no stage/version split (send-backs collapse
  into one bucket) — v1 scope; machine buckets carry full attribution.

## Office hardening (MERGE-05 + SEC-03 in code; SEC-01 + prod SQL = runbook)

Branch `office-hardening` off merged main. The Azure/Entra portal work was
blocked live by Micron Conditional Access (automated browser can't satisfy the
compliant-device policy), so the office half splits: what's expressible in code
ships now, the portal steps become a handoff runbook.

- **MERGE-05 (branch protection, coded):** `GitHub.protect_main(slug)` sets a
  Rulesets policy (block deletion + non_fast_forward + require PR, 0 approvals)
  on each produced repo. Rulesets are FREE on private personal repos (classic
  branch protection is not), so this is the durable `[kind]` control.
  Best-effort by contract: any failure logs and returns False — protection is
  defense-in-depth, never on the request's happy path, so it must not strand
  repo prep. Idempotent (skips if the sf-protect-main ruleset already exists).
  Wired in `kube_runner._prepare_workspace` right AFTER `_push_github_baseline`
  (the `main:main` push creates the branch a ruleset needs to reference).
  Tests: real seam via httpx MockTransport (payload shape, idempotency, 403 →
  False, transport error → False) + FakeGitHub contract + the runner repo-prep
  test asserts protect_main runs once, after the baseline.
  0 required approvals is deliberate — the factory's own SHA-precondition API
  merge (writer == merger token) must still land. A GENUINELY independent
  reviewer needs the office GitHub App issuing per-request identities = Phase-2,
  same 4-method seam, unchanged callers (documented in the runbook).
- **SEC-03 (Pod Security Admission, coded):** namespace enforces `baseline`
  (blocks privileged/hostPath/hostNetwork; ALLOWS root, which kaniko build pods
  need) and WARNS+AUDITS at `restricted` so every manifest that would fail the
  stricter bar is visible now. `restricted` cutover needs rootless build +
  per-pod securityContext = office (runbook §3).
- **Runbook** `docs/runbooks/office-hardening-handoff.md`: click-by-click Entra
  app registration (SEC-01, returns tenant/client IDs + audience for the API
  JWT validator), Azure SQL PROD cutover (online DATA-01 Unicode migration via
  the gated pre-deploy Job, PITR), PSA restricted path, and the GitHub App
  branch-protection Phase-2 — all requiring a Micron-compliant device.

Verify: 674 passed / 3 skipped, ruff clean, `kubectl kustomize deploy/base`
+ `deploy/overlays/prod` both parse (PSA labels render on the namespace).

## SEC-01 Phase 2 backend — Entra auth wall (branch entra-auth)

Portal Phase 1 was completed live 2026-07-18 in the personal dev tenant (three
registrations + scope + app roles + admin consent + Factory.Admin assigned;
IDs in the GITIGNORED api/.env.azure, never in the repo). Backend:

- `app/auth.py`: pure-ASGI middleware (NOT BaseHTTPMiddleware — contextvars
  set there wouldn't reach the endpoint; anyio copies context into the
  threadpool so sync endpoints see it). FACTORY_AUTH=off (default) = no-op
  byte-for-byte; entra = Bearer JWT required on everything except /api/health
  and OPTIONS. Validation: RS256 vs tenant JWKS (1h cache, unknown-kid single
  refresh, thread-safe), iss+aud+exp required. JWKS fetch is a module seam so
  tests inject a locally generated keyset — zero network.
- Identity: email claim -> Operator row (the models.py:75 comment's seam).
  Token `roles` claim is source of truth: synced onto Operator.role per
  request; first-seen admin/viewer AUTO-PROVISIONED (the Entra role
  assignment is the grant — only tenant admins assign; also solves the
  SEED_DEMO=0 fresh-prod bootstrap). Submitter-only tokens: valid caller, no
  operator identity -> operator actions 403, intake reads fine.
- Override: effective_operator_id() in ONE place, consumed by
  resolve_operator (and require_approver through it). Call sites that used
  the RAW client-sent id after resolving now use the resolved row's id
  (gates._operator_actor -> audit rows record who really acted;
  operators.py subscriptions read+write). registry/events/requests already
  used the resolved row's fields.
- Middleware added BEFORE CORSMiddleware in create_app: last-added is
  outermost, so CORS answers preflight before the wall (plus OPTIONS skip).
- Auth mode is a per-call read (FACTORY_BRAIN pattern) so tests flip it with
  monkeypatch mid-process.
- Tests (15): off-default open; 401 matrix (missing/garbage/wrong-aud/
  wrong-iss/expired/wrong-key); health+preflight open; role sync; admin
  auto-provision; submitter limits; the two override proofs (mute lands on
  token identity; require_approver judges the token, ignores body id).
- New dep pyjwt[crypto] (uv add).

Deviations / notes:
- gates.py `body.operator_id is None` still falls to the default actor even
  when authenticated (could use the token identity) — v1 keeps the touch
  small; the wall itself is correct.
- POST /api/operators (create) has NO admin wall (pre-existing); with auth on
  any valid token could create operators. Flagged for a follow-up, not
  expanded here.
- Deploy ConfigMap wiring for the kind flip (AZURE_* + FACTORY_AUTH) deferred
  until we actually turn it on in-cluster.
- test-isolation: suite shares one sqlite; auth tests clean up their
  @example.com operators or test_roles' all-admins assertion trips.

Backend verify: 689 pytest passed / 3 skipped + ruff clean. Frontend (MSAL in
console+intake) NOT started — paused for review per plan.

## 2026-07-18 — Console Overview total redesign ("the line" cockpit)

User rejected the previous Overview (decision queue + 5-column kanban board)
and asked for: (1) one bird's-eye view of ALL progress across the five stages
(Intake & Spec, Architecture, Build, Review & Preview, Deploy), (2) a
user-actions surface with the approvals before Build and Deploy explicit.

New home (worktree admin-console-redesign, floor/* only):
- **The line (left):** one row per request; a 5-segment track with two ◆
  approval joints drawn into the geometry (Build approval between Intake &
  Spec → Architecture, Deploy approval between Review & Preview → Deploy).
  Filled = done, tinted = current (live-run progress fills purple, red =
  needs-human, dashed = interview/draft), amber pulsing ◆ = holding for
  approval. Stage header carries per-stage counts + per-gate waiting counts.
  Rows sort closest-to-shipping first; shipped (last 5) sit faded below.
- **Needs you (right, sticky):** every decision as a card — Build/Deploy
  approval chips + evidence facts + Approve[A]/Send back[S], stalled cards
  with the four recovery verbs, human-owned cards. App filters kept.
  J/K/A/S/Enter keyboard flow unchanged (focus target: article.need).
- floor-view: deriveBoard/deriveCard/BOARD_COLUMNS replaced by
  deriveLine/deriveTrack/STAGES; deriveQueue/deriveTallies kept; queueChip added.

#Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations
- Scope kept to the Overview page (both user requirements live there);
  Library/Studio/Dossier untouched. Shell/nav unchanged.
- The first gate is labelled "Build approval" (user's mental model: approval
  before build) although it technically opens Architecture; the queue already
  said "Approve to build", so vocabulary is consistent.
- Visual review ran on port 4203 (another session held 4202/8000; reused that
  session's API on 8000 — same seeded DB).

Verify: ng test console 71/71 green, ng lint clean, ng build clean; visually
reviewed live at 1440/1280/390 in light + dark. Not committed.

## E2E-0 live auth proof (2026-07-18)

Live sign-in surfaced ONE real bug: Entra issues **v1-format access tokens**
for custom APIs by default (requestedAccessTokenVersion=null) — iss =
https://sts.windows.net/<tenant>/ and the email lives in the `email` claim,
not preferred_username. The wall pinned the v2 issuer → every real token got
401 "Invalid issuer". Fix: validate signature/aud/exp via PyJWT with BOTH
audience shapes (api://<id> v1, bare <id> v2), then check iss against BOTH
tenant issuer formats manually. Proven live: real browser token → 200 on
/api/auth/me → operator auto-provisioned (role admin from the roles claim).

Also observed, deferred:
- loginRedirect race: between msal.loginRedirect() resolving and the actual
  navigation, the app briefly bootstraps and fires 1-2 naked /api calls (one
  401 in the log, self-healing). Hardening option: interceptor holds /api
  requests while mode==='unknown'. → fold into E2E-1.
- Stale pre-auth tabs in the user's Chrome keep naked-polling /api/events
  every 4s (401 noise in dev logs). Cosmetic; close old tabs.

## E2E-1 Stage-1 intake with real identity (2026-07-18)

Built: requester identity is now server-authoritative under the wall —
current_identity() contextvar (name/email/initials from the validated token,
set for EVERY authenticated caller incl. submitter-only) stamps
create_request.reporter and respond's actor; body fields degrade to UI state.
Intake Session derives the user from the Entra account when auth is on
(userFromAccount pure mapper; demo/localStorage path byte-identical when off;
demo users renamed to non-real people). Console Session resolves via NEW
GET /api/auth/me (+email) instead of the operator picker when auth is on.
loginRedirect race fixed: the app initializer never resolves when navigating
to sign-in, so zero naked /api calls pre-redirect.

Live walk (signed in, scripted brain): idea -> 3-question wizard -> interview
(live Plan rewrite) -> prototype (chat + edit ack) -> review -> submit.
REQ-2136 pending_approval@approve_spec, 7 spec lines, reporter Jun Mun Wong
(JMW) from the token — spoofed body values ignored (tested).

Gaps logged for later slices:
- New-app path never asks an APP NAME -> "No app yet" shows in the mock
  heading + review chip. Candidate: derive from title or add to Edit details.
- Scripted-brain prototype edits ack ("Applied: ...") without visual change —
  honest scripted behavior; real edits need FACTORY_BRAIN=agent (E2E-2+).

## E2E-2 golden template

The produced-app template is now the vendored `templates/golden/` profile:
Angular 22 (standalone, zoneless), spartan/ui + Tailwind, and a FastAPI +
SQLModel backend managed by uv. Selection remains factory-wide and env-level:
`FACTORY_SAMPLE=<repo>/templates/golden`. The default remains `./sample`; its
files and behavior were not changed.

Factory integration changes:

- Stage prompts now detect either `src/` + `tests/` or the full-stack
  `frontend/` + `backend/` layout, retain the injection-resistant preamble,
  and name the correct plans, test locations, implementation paths, and review
  evidence for both layers.
- The factory-owned gate runs backend pytest with
  `uv run --directory backend pytest` when `backend/pyproject.toml` exists.
  GREEN and REVIEW also restore frontend dependencies and require an Angular
  production build. Only a recognized npm registry/network outage skips that
  build, with an explicit note; other install failures and build failures block.
- Request workspace creation defensively excludes `node_modules`, `.venv`, and
  `__pycache__` before the baseline commit. Existing ignored artifacts cannot
  leak into the physical workspace or its git tree.
- Added coverage for golden workspace birth, the standalone backend suite,
  Docker/runtime structure, layout-aware prompt parity, genuine RED failures,
  GREEN backend + frontend success, frontend build failure, and the temporary
  npm-registry-unreachable exception.

Verification: golden `gate.sh` reached `GATE GREEN`; backend pytest reported
`2 passed`, startcheck passed, backend Ruff passed, and the Angular production
build emitted `dist/frontend/browser`. The full factory API suite reported
`705 passed, 3 skipped`; API Ruff and `bash -n docker/sf-agent/gate.sh` passed.
Docker was inspected but not built, as required for this environment.
This sandbox did not expose outbound package fetches to uv: a default local
Python 3.12 `uv sync` stopped only because the locked SQLAlchemy 2.0.51
`py3-none-any` wheel was not already cached. `uv lock --check` passed for the
3.12 metadata, and the complete standalone gate was exercised with the same
lock on the cached Python 3.13 interpreter. A normal networked build remains
the outstanding proof of the Python 3.12 image layer.

## E2E-2 template deltas

Every intentional delta from the vendored ng-v0 golden template is listed
here; all other template source and lock content is preserved:

- `backend/app/main.py`: added the factory-compatible bare `GET /health` alias
  while retaining `GET /api/health`; added the final `StaticFiles` mount at
  `/` with `html=True`, after all API and health routes, when built assets exist.
- `Dockerfile`: added a plain multi-stage build. Node 24 runs `npm ci` and the
  Angular production build; Python 3.12 + pinned uv installs the frozen
  production backend, receives `dist/frontend/browser`, exposes port 8000,
  and runs uvicorn as arbitrary-UID-compatible user 10101.
- `backend/.python-version`, `backend/pyproject.toml`, and `backend/uv.lock`:
  aligned the backend floor and Ruff target from Python 3.13 to Python 3.12 so
  the approved runtime image can satisfy the frozen project metadata.
- `backend/tests/test_items.py`: added the regression test for bare `/health`.
- Removed `.impeccable/hook.cache.json`, an ignored local tool cache that could
  not be committed as template source. Added `.pytest_cache/` to the root
  `.gitignore`; it already covered `node_modules`, `.angular`, `dist`, `.venv`,
  `__pycache__`, `app.db`, and the other required generated artifacts.

Deferred by E2E-2:

- Per-request-type template selection; the profile remains the single
  `FACTORY_SAMPLE` env choice for now.
- Enforcing npm registry access in gate pods via NetworkPolicy; E2E-4 owns the
  live network path. Until then, only confirmed registry-unreachable failures
  are skipped and logged.
- No frontend-runner work is needed for this template because `npm test` is
  already Vitest-backed. The prompts explicitly fall back to backend-only RED
  tests and disclose the limitation for any future template without a runner.

## E2E-3 complete — architecture gate + refine loop LIVE-PROVEN (2026-07-18)

Backend (codex build + my review fixes from the independent codex review):
raise/approve/reject transitions (decisive, replay-safe), drive-loop gate with
durable supersede of rejected rounds (scheduler classifies refinement as
architecture work), reason_code preserved, notifications labeled, evidence
kind="architecture" (plan_excerpt/plan_digest/refine_rounds) + EvidenceOut
extended, simulator parity (approve is the only way past; reject resets
sim_step via the transition), newest_decisive promoted to transitions.
FACTORY_ARCH_GATE accepts on/true/yes/1. FACTORY_SPEC_GATE=auto self-approves
the spec gate at submit with an honest raise+approve audit pair.

Console: gateLabel/confirmSteps/track rows/Needs-you rail know
approve_architecture + accept_preview; ApproveModal renders the PLAN excerpt
+ refine rounds; RefineModal ("Ask the agent for changes") posts the
structured reject through Api.rejectGate. Gate/Evidence unions extended;
'send to agent' action verb.

LIVE WALK (dev stack, sim, signed in as the Entra admin): approve spec →
architecture walked → GATE RAISED (t+24s) → "Ask the agent for changes" with
a real note → rejected_architecture audit + pending_feedback staged → stage
re-walked → GATE RE-RAISED (t+16s) → "Approve & continue build" →
approved_architecture by Jun Mun Wong → stage=build. The full refine
conversation is in the timeline.

CORRECTION (same day): the suspected "dossier doesn't live-refresh" finding
was WRONG — the dossier effect already re-queries on Poll version bumps; the
stale header was the long-lived ng serve serving a PRE-MERGE bundle (old code
had no architecture branch in stateSentence). One real lesson stands: restart
dev servers after merging.

## E2E-4 live findings (kind, real agents on the golden template)

The walled gate pod found three REAL infra gaps in one afternoon — exactly
what the live proof is for. All fixed in docker/sf-agent/Dockerfile:
1. uv dialed GitHub for a cpython 3.12 download (template .python-version)
   inside the no-egress gate → bake 3.12; UV_PYTHON_DOWNLOADS=never.
2. The baked interpreter was invisible to arbitrary-UID pods (root-homed
   managed dir) → shared UV_PYTHON_INSTALL_DIR=/opt/uv/python.
3. Gate-time `uv sync` dialed PyPI for wheels (and httptools needs a source
   build on cp312/aarch64) → image-time `uv sync --frozen` of the template
   lock into shared UV_CACHE_DIR (+build-essential; cache world-writable —
   pods are single-use, poisoning is pod-local). Proven: uid 10101 +
   --network none passes the golden backend suite. A silently added dep
   still fails the gate loudly — by design; office answer = internal mirror.
Also: architecture agent on the golden workspace produced a real
"Tea Roster implementation plan" and the gate held with the excerpt — twice.

Findings #4–#7 (same live loop, runs 4–8): green agent deleted [build-system]
from the golden pyproject → lock desync → PyPI dial. Fix: `uv run --locked`
in gate.sh + a DEPENDENCY FREEZE rule in all four stage prompts. Then
hatchling itself (build-system.requires) forced a re-resolve → template
de-packaged ([tool.uv] package=false + pytest pythonpath=["."]) so the gate
is 100% lock-driven. Then npm ci hung 15+ min against the egress wall and
the pod deadline reaped the gate verdict-less → `timeout -k 15 120 npm ci`
with tight fetch flags; rc 124/137 or a network-error regex = "frontend
build skipped" note, not a failure (node ignores SIGTERM — the -k matters).

Finding #8 (runs 9–10): reviewer REQUEST-CHANGES used to re-review the
UNCHANGED SHA, so an honest reviewer repeats the verdict and the request
escalates without the implementer ever seeing the concerns. New
`review_rework` machine transition: rejection sends the request back to the
build stage with the review reasoning as pending_feedback (delivered as
SF_GATE_FEEDBACK to the first rework pod, red-N+1); bounded at 2 reworks,
then escalate. Rejected-round review rows are superseded.

Finding #9 (run 10): rework rounds ran with EMPTY review reasoning — the
reviewer wrote a detailed report but the 20000-char logs-tail cap
decapitated the ndjson review event, so parse_review_report saw nothing.
_bounded_logs_tail now re-appends a bounded (6000-char) copy of the last
review event when the cap cut it off. The four pre-existing tests that
pinned the old "retry review with feedback" contract were moved to the
rework contract.

Finding #10 (run 11 — the TRUE root cause behind #9's symptom): reasoning
was still empty even with the tail-cap fix deployed. Byte-exact analysis of
the persisted tail showed `\xNN` and `\'` sequences, literal `\n`s, zero
real newlines, and a trailing `'` — the persisted log was a Python REPR OF A
BYTES OBJECT. read_namespaced_pod_log returns BYTES when a codex transcript
contains invalid UTF-8, and scrub_secrets' str() repr'd the whole log into
one giant b'...' line — every ndjson event (review reasoning, pytest blocks)
silently vanished, for every stage pod with a non-UTF-8 transcript. Fixed:
decode(errors="replace") at the kube client, a second defense in
_bounded_logs_tail, and the entrypoint's review event bounded to 6000 chars
so it survives the 20000-char persisted cap after JSON escaping. A control
experiment (30k-char single-line JSON through kind's CRI) proved the log
pipeline itself is NOT the mangler — kubectl logs returns it intact.

Finding #10b (run 12): the decode fix never fired — the kubernetes client's
OWN deserializer does the str(bytes) repr before returning. Fixed for real
with _preload_content=False + manual decode; _bounded_logs_tail additionally
un-reprs any persisted "b'...'" string via ast.literal_eval.

Finding #11 (run 13): reasoning finally survived (4000 chars vs 0 in twelve
runs) but carried the WRONG 6000 chars — a raw tail of the codex transcript
ships file dumps and exec noise, not the reviewer's final message. The
entrypoint now extracts the final agent message (after the last bare "codex"
marker, up to "tokens used"), bounded tail as fallback for other CLIs.
Verified against a real transcript. Review-3 of run 13 produced clean
functional bullets.

Finding #12 (run 13): parse_review_report baked "the code SHA is unchanged,
so repeat REQUEST-CHANGES" into every rejection's feedback — true under the
old retry contract, FALSE after a rework (the implementer pushed a new SHA),
and it biased reviewers + misled escalation readers. Reworded to a neutral
"the independent review requested changes" preamble.

Parallel console lanes (codex gpt-5.5, worktrees, while the smokes ran):
- console-rollback-async (5063a14): honest 202 typing + poll
  GET /api/apps/{id}/rollbacks (endpoint added on main, 376ebfb — the async
  contract had NO read half; found by the codex lane) until the row settles.
- console-heartbeat-ui (ad81bc6): C1-UI — Health model + 10s poller, one
  shell indicator (live/buffered/unknown/stalled/fetch-fail + tooltip),
  Overview stale banner. Both branches lint+vitest+build green; merge to
  main pending full verify + visual check after E2E-4 settles.

Finding #13 (run 14, two coupled cap bugs): (a) rework rounds consume
attempt numbers even for stages that PASSED an earlier round — green-1
succeeded, the review sent the work back, and green-2's FIRST failure
escalated with zero retries; the cap now grants each rework its extra
attempt for red/green/review, and a review that still rejects after the
rework budget escalates directly (never re-reviews the same SHA). (b) every
spawn fired advance_stage, whose unconditional stage_entered_at bump made
_supersede_rewound_rows read a same-stage retry as a stage REWIND and
supersede the sibling stages' graded rows — a green retry erased red's
succeeded gate and the frozen-surface check failed closed (latent bug,
exposed by the new regression test before it could bite live). Same-stage
spawns now use the new respawn_stage transition.

Finding #14 (run 15 — the machinery itself finally ran clean): reasoning
survived every round, three full rework rounds executed, crisp escalation —
but the reviewer rejected all three rounds for a test that loads axe-core
from a CDN, impossible inside the egress wall; the implementer could never
satisfy the review. All four stage prompts now carry an OFFLINE ENVIRONMENT
rule (no CDN/remote fetches at build/test time), and the reviewer is told to
note network-only failures without REQUEST-CHANGES.

Finding #15 (run 16): the loop converged on substance each round (round-1
and round-2 concerns were fixed) but the reviewer rejected all three rounds
on freshly discovered issues — including a non-compiling frontend spec
(toHaveSize) that the implementer's own gate called GREEN, because frontend
TESTS were never gated (the walled pod cannot npm ci). Two fixes: (a) the
agent image bakes the golden template's node_modules (lock is frozen);
lock-match → the gate copies the tree in and runs npm test + build offline —
rehearsed green as uid 10101 with --network none; (b) the review prompt got
an explicit shippable-v1 verdict bar (REQUEST-CHANGES only for AC
violations, broken/dishonest tests, correctness/security; polish in notes;
rework rounds verify prior concerns first).

Finding #16 (run 17 — the loop CONVERGED): the round-3 reviewer wrote
APPROVE ("Implementation satisfies the Tea Roster specification and plan")
but the verdict grep scanned the WHOLE transcript and matched the prior
round's line-start REQUEST-CHANGES inside the echoed rework feedback —
recording the approval as a rejection and escalating a finished request.
The verdict now comes from the same extracted final message as the
reasoning.

Run 18 — FULL PIPELINE CLEARED: architecture gate (real plan) → red/green →
review APPROVE after ONE rework round (clean reasoning both rounds) → kaniko
multi-stage golden preview build → preview served Angular + FastAPI /health →
accept → merge → prod image build → deploy → DONE. The only failure was the
smoke probing prod /health at pod age 27s (finding #17, smoke-script race —
"done" means the deploy is applied, not that the pod is up); the app answered
{"status":"ok"} + the Angular index 30s later. 60s retry window added.

Finding #17 (runs 18-20, one cause misdiagnosed twice): the prod /health
probe kept failing while the app was demonstrably live (run 20: pod ready in
6s, nginx reloaded before the window, 90 probes missed, the identical curl
succeeded minutes later). Not a slow rollout — each run mints a brand-new
*.localtest.me subdomain, and one transient upstream DNS failure gets
NEGATIVELY CACHED by macOS for minutes. The smoke now pins every per-run
subdomain with curl --resolve; the earlier 60s→180s window widenings were
treating the wrong cause.

Finding #18 (run 21): the newly gated frontend tests correctly failed a
broken spec, but the gate feedback was the ANSI-colored summary footer
("2 failed | 3 passed") — no test names, no assertions; green fixed blind
and escalated. The gate now strips ANSI and excerpts the failing-test
blocks (FAIL + file:line + expected/received diff); rehearsed in-image.

Campaign close (2026-07-18 evening): runs 22-25 outcomes — 22 cleared the
full pipeline again (review approved, preview, merge, deploy, done; app
hand-verified live; only the host probe missed). 23 and 24 escalated
honestly (reviewer held a real date-lifecycle defect twice; green exhausted
its cap on a red identity test) — agent nondeterminism, walls working. 25
died on codex's WEEKLY USAGE CAP (resets Jul 25 11:24); the factory
classified it as quota infra and escalated cleanly. #17b: the prod check now
passes via host ingress OR an in-cluster service probe (pass records which);
the host-side anomaly never reproduced outside a live run (clean isolation:
fresh subdomain + background context + immediate probe = instant success)
and stays instrumented. Full-pipeline proof stands on runs 18/20/22 + four
hand-verified live prod apps. E2E-4/5/6 closed; E2E-7 blocked on the Red
Hat pull secret + agent quota.

## Deviations

- test_second_request_changes_escalates_without_merge_gate now asserts
  "review failed" (generic) instead of the exact attempt count in the
  escalation message: with reworks the terminal message is "after 3
  attempts" and the precise count is asserted via the two review_rework
  audit rows instead — more honest, less brittle.
