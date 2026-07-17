# PROMPT — End-to-End Factory Gap Review & Improvement Workflow ("Plan C arc")

Paste everything below this line into a fresh Claude Code session opened at the
software-factory repo root. It is self-contained.

---

## Mission

You are running a full end-to-end audit and improvement program for the
Software Factory. The product promise: a non-technical user submits a request,
and the factory plans, architects, builds, reviews, previews, and deploys a
working app — with humans only at the decision points, never at the keyboard.

Your job, in order:

1. **Map** the real journey from "user types a request" to "app live behind
   the ingress" — as it exists today, with evidence.
2. **Walk it live** as a real user and log every friction point.
3. **Audit** every stage against a best-in-class bar (rubric below).
4. **Hunt blindspots** adversarially — what the happy path hides.
5. **Produce a prioritized roadmap** (gap register + Plan C slices).
   **PAUSE for approval here.**
6. **Ship the approved slices** with the standard plan → TDD → adversarial
   review → verify → prove-live loop, until every approved slice is live and
   proven on kind.

The bar for "done": a stranger can submit a request in the intake UI and get a
working, previewed, iterated, approved, deployed app — without anyone touching
kubectl, the DB, or a terminal — and every step is observable, recoverable,
and would survive contact with real production infra.

## Step 0 — Load context (read before anything else)

Read, in this order:

- `CLAUDE.md`, `AGENTS.md`, `CONTEXT.md`
- `docs/adr/` — all of them; the K8s spec ADRs and ADR 0008 (append-only
  progress log) are load-bearing
- `docs/superpowers/plans/` — the 2026-07-15/16 Plan B docs (B3
  build+deploy, B4 GitHub + approve-deploy) describe the current runner
- `docs/reviews/console-gap-analysis-2026-07-16.md` — the house style for a
  gap analysis; follow its format
- `api/app/kube_runner.py`, `transitions.py`, `kube_jobs.py`, `github.py`,
  `deploy_manifests.py`, `workspace.py`, `settings.py` — the pipeline heart
- `docker/sf-agent/entrypoint.sh` + `docker/sf-agent/prompts/*.md` — the
  agent harness (the prompts ARE the harness; read every one)
- `deploy/base/`, `deploy/kind/`, `scripts/*smoke*.sh`, `Taskfile.yml`
- `implementation-notes.md` — deviations log; append to it, never rewrite

### Current proven state (as of 2026-07-16, B-arc complete)

- Pipeline stages: `intake → spec → architecture → red → green → review →
  done`, with `PIPELINE_STAGES = (architecture, build, review)` at the
  request level and `KUBE_STAGES = (architecture, red, green, review)` as
  agent Jobs. Red/green is TDD by construction.
- Runner: `FACTORY_RUNNER=kube` on a local kind cluster. Tick loop
  (reap → observe → spawn), epoch-fenced transitions, append-only progress
  events, intent log for idempotency, capture-before-delete on Jobs.
- Agents: codex CLI inside NetworkPolicy-walled pods
  (`-s danger-full-access` — the pod is the sandbox). Gate feedback is
  injected into retry prompts (`SF_GATE_FEEDBACK`).
- Two human gates, both proven live: approve-merge (after review) and
  approve-deploy (after merge, before anything builds).
- GitHub mode proven live (REQ-2047): factory-created private repo, PR per
  request, SHA-precondition API merge, git-daemon stays the in-cluster
  mirror for gate/build pods. Token rides a Secret, stage pods only.
- Build+deploy proven live (REQ-2045): kaniko build → in-cluster registry →
  digest-pinned Deployment → live pod via ingress (`*.localtest.me:8081`).
- Console: decision queue + pipeline board, fleet view, rollback, roles,
  evidence panels. Intake ("Stream"): describe hero → non-technical
  interview → basics wizard → live plan → HTML prototype step → review.

### Known-deferred list (seed the gap hunt with these; do not re-discover)

Branch protection on factory repos; gitleaks/secret-scanning in gates;
Prometheus/metrics + alerting; steer-note injection into running Jobs;
post-done replay 409 nit; office/OpenShift Phase-2 overlay (BuildConfig,
GitHub App, EgressFirewall); Azure SQL cutover (runbook exists at
`docs/runbooks/azure-sql-dev.md`, parked at Microsoft sign-in); SQLite in
production; single-replica/single-worker constraint (ADR-gated).

## The journey you are auditing (the spine)

Audit these nine stops. For each: what exists, what's missing, what's manual
that should be automatic, what's invisible that should be observable.

1. **Submit** — intake "Stream" app: describe → interview (non-technical,
   never re-asks basics) → basics wizard → live plan panel → prototype
   (chat + HTML mock + point-to-edit) → review & submit.
2. **Spec & plan** — what does the factory persist as the request's contract?
   Is there an acceptance-criteria artifact a gate can grade against later?
3. **Architecture** — the `architecture` stage Job. What does it produce,
   who reviews it, can a human redirect it before build spends money?
4. **Build (red → green)** — TDD stages. Prompt quality, retry taxonomy
   (infra vs agent failure), attempt caps, gate feedback fidelity.
5. **Code review** — the `review` stage + gate script. Anchored verdicts,
   what evidence reaches the console, what a REQUEST-CHANGES loop looks like.
6. **Merge** — human gate #1 → GitHub PR → API merge (SHA precondition,
   merge-claim grace shield, ancestor guard).
7. **Preview & feedback loop** — ⚠ THE USER-MANDATED GAP, see next section.
8. **Deploy** — human gate #2 → kaniko → digest-pinned deploy → rollout →
   live URL. Rollback, fleet ops, post-deploy health.
9. **Operate & iterate** — what happens after done? Follow-up requests,
   regressions, feedback from the live app, cost/usage visibility.

## The preview & feedback loop (mandatory design item — user requirement)

Today nothing ships a preview before the deploy gate, and there is no
structured channel for a requester to say "this is wrong, fix it." The user
explicitly wants:

- After build/review, a **preview environment** the requester can open in a
  browser (the pieces exist: kaniko can build any SHA, deploy_manifests can
  pin any digest — an ephemeral `sf-app-<slug>-preview` Deployment/Ingress
  at e.g. `<slug>-pr<N>.localtest.me` is within reach).
- A **feedback affordance** on/next to the preview (intake app or console):
  the requester reports an issue in plain language, optionally pointing at
  a screen/element (the prototype step's point-to-edit pattern is prior art).
- Feedback flows back as a **structured re-plan**, not a blind retry: the
  factory revises the plan/spec, runs the affected stages again, and posts a
  new preview. Every round is auditable (progress events + decisive audits).
- The loop repeats until the requester is satisfied; only then does the
  deploy gate release to production. Deploy gate copy should show what the
  requester approved (preview URL + round count).
- Guardrails: max feedback rounds before escalation to an operator; preview
  envs are labeled, quota'd, and reaped (capture-before-delete applies).

Design this properly in Phase 4 (it is Plan C1 unless the audit finds
something more urgent), respecting the transitions TABLE / epoch-fence /
intent-log architecture — no side-channel state.

## The rubric — what "best in class" means

Score every stage 1–5 on each axis, with evidence (file:line, screenshot,
or live-run observation) for every score:

- **a. Correctness & robustness** — crash/kill/race behavior; does the
  epoch-fence + intent-log discipline hold here?
- **b. Autonomy** — how often does a human have to babysit vs decide?
- **c. Feedback quality** — when it needs a human, does the console show
  enough evidence to decide in under a minute?
- **d. Observability** — can you reconstruct what happened and why from the
  progress log + audits alone?
- **e. Security & isolation** — walls, tokens, least privilege, what a
  malicious produced-app or prompt-injected agent could do.
- **f. Production parity** — would this exact mechanism survive on real
  infra (OpenShift/AKS, Azure SQL, real DNS/TLS, real load)?

Reference points for the bar: gate feedback should be as good as a great
human PR review; the preview loop should feel like Vercel preview deploys +
comments; deploy should feel like a gitops CD tool (digest-pinned, instant
rollback); observability should let you answer "why is REQ-X stuck?" without
kubectl.

## Phase 1 — Live walkthrough (as the user)

- Bring the cluster up if needed (`task kind-up`, `task kind-deploy`; the
  smokes in `scripts/` show the working invocations; codex auth via
  `task sync-codex-auth`). Check what's already running first.
- Submit a **real, new request through the intake UI** (browser tools) — do
  NOT use the seeded northwind request or curl the API. A small but
  non-trivial app spec is right (e.g. a bookmarks manager with tags).
- Drive it all the way to a live deployed app, using the console for both
  gates, exactly as an operator would.
- Keep a **friction log**: timestamps, waits with no visible progress,
  states you couldn't explain from the UI, anything that forced you to a
  terminal, every error and how you recovered. This is the "smoothness"
  evidence and it feeds the gap register.
- Codex spend is real: one full run is expected; don't loop it.

## Phase 2 — Stage-by-stage audit (parallel subagents)

Fan out one auditor subagent per spine stop (2–9; stop 1 you just lived
through), plus these cross-cutting auditors:

- security & secrets (token paths, netpol walls, RBAC, produced-app threat
  model, prompt injection via request text)
- failure & recovery (kill the API pod mid-X; strand repair; replay)
- data & DB (SQLite limits, migration discipline, backup/restore, Azure SQL
  readiness)
- observability & operability (what Prometheus/alerts would watch; log
  retention; "why is REQ-X stuck?" drill)
- cost & limits (LLM spend per request, attempt caps, concurrency fairness,
  runaway protection)

Subagent rules: audits that need the highest intelligence (security threat
model, failure/race analysis, the Phase 3 blindspot hunt) run on **fable**
(user direction 2026-07-16 — overrides the earlier spend-cap ban; if a
fable agent dies on the monthly cap, rerun that one agent on opus). All
other auditors run on **opus**. **Never Haiku.** Bulk mechanical checks
can go to codex gpt-5.5 via
`codex exec -s read-only` with self-contained prompts. Each auditor returns:
scorecard (rubric above), gaps with severity (CRITICAL/HIGH/MED/LOW),
opportunities, and blindspot candidates — with evidence for every claim.

## Phase 3 — Blindspot hunt (adversarial)

Run a second, smaller wave that attacks the audit itself:

- "What breaks with 20 concurrent requests?" (tick loop, git-daemon, kaniko
  queue, registry disk, codex rate limits)
- "Codex hits its usage cap mid-stage — what does the user see?"
- "The produced app's Dockerfile is malicious — enumerate the blast radius."
- "GitHub is down / slow — which transitions strand?" (the merge-claim race
  was found exactly this way; assume more exist)
- "The requester submits a request that asks the agent to exfiltrate the
  GitHub token." (prompt injection through request text into stage prompts)
- "Two operators approve the same gate simultaneously."
- A completeness critic: what did Phase 2 not cover — modality, stage,
  claim without evidence?

## Phase 4 — Gap register & roadmap → PAUSE

Merge everything into `docs/reviews/factory-e2e-gap-analysis-2026-07-XX.md`
(follow the console gap analysis format):

- Journey map with per-stage scorecards (the rubric, with evidence links)
- Friction log from Phase 1
- Gap register: ID, stage, severity, evidence, proposed fix, effort S/M/L
- Blindspot findings
- Proposed **Plan C slices** (C1, C2, …), each with scope, rough design,
  and what "proven live" means for it. C1 = the preview & feedback loop
  unless something CRITICAL outranks it. Include a production-parity slice
  (DB, TLS/domains, image scanning, quotas, backups, metrics) and say which
  parts belong to the office/OpenShift overlay instead of local kind.

Then STOP and present the roadmap as plain numbered options (1, 2, 3 …),
with a recommendation only where genuinely warranted. Wait for approval.
Approval of a slice is the authorization for its commits, merges, and pushes.

## Phase 5 — Execute approved slices

Per slice, the established B-arc loop, no shortcuts:

1. Plan doc in `docs/superpowers/plans/` (opus Plan agent; commit it).
2. TDD implementation by codex gpt-5.5 (`codex exec`, background with
   `</dev/null`, self-contained prompts) on a clean worktree; the
   coordinator (you) commits — codex's sandbox can't.
3. Adversarial review wave (opus): findings → fixes → regression pins.
4. Clean-worktree `task verify` / `make verify` green — lint + pytest +
   vitest + Angular build + smoke. Fix failures including silent semantic
   conflicts; show the output.
5. `--no-ff` merge to main, push, CI green.
6. **Prove it live on kind** — extend `scripts/kind-smoke.sh` (or add a
   sibling smoke) so the new behavior is asserted forever, then run it.
7. For UI changes: verify in the running app, light AND dark mode,
   screenshots at 1440px and 390px, before calling it done.
8. Update `implementation-notes.md` (## Deviations for any plan departure)
   and memory.

## Hard rules (repo + user invariants — violating these is failure)

- `progress_event` is append-only (ADR 0008). Never UPDATE/DELETE rows.
- ONE uvicorn worker / one API replica. No scaling without an ADR.
- All request-state changes go through the transitions TABLE with the
  epoch fence; side effects go through the intent log. No new side channels.
- Never print, echo, or log the GitHub token or codex auth. Token flows
  are Secret → env → in-memory only; stderr of authed git commands stays
  silenced (see entrypoint.sh — keep it that way).
- Never use the pale purple tint (`--a50`) as a selected/active/hover
  background. Neutral surfaces only; purple is for the brand dot, primary
  buttons, and small semantic tags.
- Simple English to the user; numbered options for choices; if output is
  very long, write it to a file and give the path + summary.
- If an edge case forces a deviation: pick the conservative option, log it
  under `## Deviations`, keep going — don't stop to ask.

## Deliverables

1. `docs/reviews/factory-e2e-gap-analysis-2026-07-XX.md` — the audit
   (scorecards, friction log, gap register, blindspots, roadmap).
2. The Phase 4 pause with numbered slice options.
3. Per approved slice: plan doc, green verify output, CI green, live kind
   proof, smoke coverage, updated notes/memory.
4. Final report: before/after rubric scores per stage, what's proven live,
   what remains on the roadmap and why.

## Definition of done

- The Phase 1 journey re-run end-to-end is smooth: no terminal touches, no
  unexplained waits, both gates decided from the console with sufficient
  evidence, preview iterated at least one feedback round, app live.
- Every stage scores ≥4 on every rubric axis, OR has an explicit roadmap
  entry the user has seen and deferred.
- Every shipped slice is asserted by a smoke that will catch regressions.
