# Factory end-to-end gap analysis (2026-07-16)

Frame: the factory's promise is that a **non-technical stranger submits a
request and gets a working, deployed app** — humans gate only the irreversible.
This audit walks the whole line, submit → spec → architecture → build →
review → merge → preview → deploy → operate, and asks of every stop:

1. Is it **correct** under crash/kill/race?
2. Is it **autonomous** (humans decide, never babysit)?
3. Is the **feedback** enough to decide/act in under a minute?
4. Is it **observable** from the append-only log alone?
5. Is it **secure & isolated** against a malicious app or an injected agent?
6. Would it **survive production** (OpenShift/AKS, Azure SQL, real DNS/TLS/load)?

Method: 12 stage + cross-cutting auditors (two independent sets for
cross-check) + a concurrency/scale attacker + a completeness-critic
synthesizer, every claim carrying `file:line` evidence. Three headline
CRITICALs were re-verified by hand against the source and the live cluster.
Full per-lens reports live in `scratchpad/audit/`; the reconciled register is
below.

## Verdict in one paragraph

The **state machine is genuinely strong** — epoch-fenced CAS transitions, an
intent log for idempotency, an append-only progress log, capture-before-delete,
all live-proven across REQ-2045/2046/2047. The weaknesses are not in the
plumbing; they are in **four bands**: (1) the **contract is un-gradable** — no
acceptance criteria, gates check shape not substance, so a dropped requirement
passes every gate; (2) there is **no preview and the two human gates are
near-blind** — the requester's first contact with the app is production; (3)
**security past localhost is absent** — no API auth at all, prompt-injection →
credential exfil, an unauthenticated git-daemon; (4) **production-parity infra
is missing** — the registry has no durable storage or GC, pods are never
reaped, SQLite→Azure SQL silently corrupts non-ASCII text. Realistic
throughput today is ~2–4 requests/hour, collapsing to operator triage under a
burst.

Deduped severity count: **6 CRITICAL · 24 HIGH · 24 MED · 9 LOW = 63**.

## What is genuinely strong (preserve these)

- Epoch-fenced CAS on a transitions table + intent log — the merge-claim race
  fix (a936f8c) and the ancestor guard show the discipline works under real
  races.
- Append-only progress log doubles as replayable history with no second source
  of truth; capture-before-delete snapshots pod logs into `StageJob` before
  every reap.
- TDD-by-construction is real: test-isolation is enforced on the trusted
  orchestrator side (surface_hash recomputed on its own clone), so a lazy agent
  cannot weaken tests to pass — confirmed live on REQ-2047.
- Produced-app runtime isolation is excellent: `egress:[]`, drop-ALL caps, no
  service-account token, digest-pinned deploys.

## Journey scorecard (reconciled, 1–5; ⚠ = the binding constraint at that stop)

| Stop | a·correct | b·auto | c·feedback | d·observe | e·secure | f·parity |
|------|:--:|:--:|:--:|:--:|:--:|:--:|
| 1 Submit | 3 | 4 | 4 | 4 | ⚠2 | 3 |
| 2 Spec / contract | 3 | 4 | 4 | 4 | 2 | ⚠2 |
| 3 Architecture | 4 | 3 | ⚠2 | 3 | 3 | 2 |
| 4 Build (red→green) | 3 | 4 | ⚠2 | 3 | 2 | 2 |
| 5 Code review | 3 | 3 | ⚠2 | 3 | 3 | 2 |
| 6 Merge / GitHub | 4 | 3 | 3 | 4 | ⚠2 | 2 |
| 7 Preview & feedback | ⚠1 | 1 | 1 | 1 | 1 | 1 |
| 8 Deploy | 3 | 4 | 3 | 3 | 4 | ⚠2 |
| 9 Operate & iterate | ⚠2 | 3 | 2 | 3 | 3 | 2 |
| ~ Failure/recovery | 3 | 4 | 3 | 4 | 4 | ⚠2 |
| ~ Data / DB | 3 | 3 | 3 | ⚠2 | 3 | 2 |
| ~ Observability/cost | 4 | 4 | 3 | ⚠2 | 4 | 3 |
| ~ Security (system) | — | — | — | — | ⚠2 | 2 |

Nothing scores ≥4 on every axis; every stop has at least one roadmap entry
below.

## The 6 CRITICALs (★ = re-verified by hand this session)

- **★ SEC-01 — the control-plane API has no authentication.** The only FastAPI
  dependency in any router is `get_db`; "roles" trust a caller-supplied
  `operator_id` and default a missing role to `admin`; `POST /api/operators`
  mints an admin. Live: `GET /api/operators` → 200 with no credentials. Anyone
  who reaches the API approves deploys, cancels, and reads everything.
- **★ OPERATE-02 / FM-1 — a failed follow-up deploy deletes the live app.**
  `_drive_one_deploy` calls `_teardown_app` every tick for any
  `stage=deploy` + `needs_human` request, and `_teardown_app`
  (kube_runner.py:851) unconditionally runs `delete_by_label(sf/instance=<slug>)`
  on the *shared* app label. Harmless today only because produced apps are
  unregistered (ephemeral slug) — **the moment OPERATE-01 registers them so
  iteration works, this becomes a standing production kill-switch.** The two are
  coupled and must land together.
- **SEC-02 — prompt injection → credential exfil.** Verbatim request text lands
  in `SPEC.md` (workspace.py:60-69), which every stage agent reads under
  `-s danger-full-access` in a pod that holds both the codex `auth.json` and the
  GitHub PAT, with `0.0.0.0/0` egress (networkpolicies.yaml:104-110). The
  account-scoped PAT means one injected request compromises every `sf-app-*`
  repo.
- **MERGE-05 — no branch protection; the PAT self-merges.** CONTEXT.md's "GitHub
  enforces you can't approve your own work" is unimplemented; the only guard on
  `main` is the API SHA-precondition. A real org's required reviews would block
  the current flow.
- **DATA-01 — Azure SQL silently corrupts non-ASCII text.** Every human string
  column compiles to non-Unicode `VARCHAR`/`TEXT` on MSSQL; emoji/CJK/curly
  quotes → `?`. CI stays green because fixtures are ASCII.
- **PREVIEW-01 — no preview environment or feedback channel exists** (the
  user-mandated gap; Plan C1). The requester's first contact with the real app
  is production, and comments are consumed by nothing.

---

## Deduplicated gap register

IDs are grouped by stage prefix. Evidence is the single best `file:line` from
the merged auditor rows. Effort: S ≤2d · M ≈3–6d · L ≈7–12d.

### CRITICAL

| ID | Stage | One-line | Evidence | Fix | Eff |
|---|---|---|---|---|---|
| SEC-01 | Security | No API auth; roles trust a body `operator_id`; `POST /api/operators` mints admin | main.py:81-87; operators.py:22-28,36-48; live 200 | Auth dep on every mutating route binding identity→operator_id; admin-only operator create. Office: Entra/OIDC on ingress | M |
| SEC-02 | Security | Prompt injection via request text → codex + GitHub credential exfil | workspace.py:60-69,180; kube_jobs.py:74-84; networkpolicies.yaml:104-110 | Data-fence SPEC.md; egress FQDN allowlist; per-request short-TTL GitHub App tokens; keep PAT out of non-push pods | L |
| OPERATE-02 | Operate | Failed follow-up deploy tears down the live registered app (teardown every tick by shared slug) | kube_runner.py:602-620,839-853; transitions.py:408-415 | Teardown once; scope to `sf/ref=<ref>`, never the shared live instance; stop selecting CLOSED/needs_human after teardown | M |
| MERGE-05 | Merge | No branch protection / required checks; PAT merges its own PR | github.py:54-68,97-107; grep protection → none | Protected `main` + required checks on `ensure_repo`; GitHub App or linked-admin merge. Real protection = office overlay | L |
| DATA-01 | Data | User text silently corrupted on Azure SQL (VARCHAR/TEXT non-Unicode) | models.py:122-123,212,236,287; MSSQL DDL | `Unicode`/`UnicodeText` (or NVARCHAR mssql variant); Unicode round-trip test in MSSQL suite | M |
| PREVIEW-01 | Preview | No preview env + no structured feedback channel (the mandated gap) | transitions.py:53-55; kube_runner.py:413-429; zero preview objects live | Plan C1 (roadmap): pre-merge ephemeral preview, requester gate, structured re-plan, TTL/quota/reap | L |

### HIGH

| ID | Stage | One-line | Evidence | Fix | Eff |
|---|---|---|---|---|---|
| INTAKE-01 | Submit | Prototype HTML + point-to-edit iterations discarded before build (scripted path) | interview.py:329-376; entrypoint.sh:56-58; workspace.py:180 | Emit `prototype_html` into repo `design/`; cite in stage prompts | M |
| INTAKE-02 | Submit/Review | No acceptance-criteria artifact; nothing machine-grades built app vs spec | workspace.py:60-69; gate.sh arch `[ -s PLAN.md ]` | Numbered `AcceptanceCriterion` rows; RED tags each test with an AC; review gate adds AC-coverage | L |
| INTAKE-03 | Submit | `submit()` accepts empty/incomplete request; floor is client-nav only | requests.py:518; schemas.py:264 | Server-side interview-floor + field validation before `submit_claim`; 422 otherwise | S |
| ARCH-01 | Architecture | Gate grades shape not substance (`[ -s PLAN.md ]`); hallucinated plans pass | gate.sh:33-35; models.py:99 | Spec-line-coverage / min-structure check or cheap LLM-judge as gate metric | M |
| ARCH-02 | Architecture | No cheap human checkpoint before red/green/review spend; PLAN.md never surfaced | kube_runner.py:1078-1100; transitions.py:395 | Optional config-gated `approve_architecture` gate surfacing PLAN.md | M |
| ARCH-03 | Architecture | Always plans against the fixed Northwind sample; new-app requests mismatch | architecture.md:1; workspace.py:172 | Per-request greenfield scaffold/template, or scope product to "enhance existing repo" | L |
| BUILD-01 | Build | Infra faults misclassified as agent failures, burn the 2-attempt budget (live REQ-2029) | entrypoint.sh:14-18,87; kube_runner.py:311-315 | Exit-code taxonomy splitting retry-neutral infra from agent failure | M |
| BUILD-02 | Build | Gate installs no deps, runs only pytest → TDD is stdlib-Python-only; web/vitest ungraded | Dockerfile:24; gate.sh:25-49 | Gate installs declared deps in a venv; run frozen JS surface when package.json present | M/L |
| REVIEW-01 | Review | Reviewer verdict non-binding; no REQUEST-CHANGES loop (green tests + diff always raise merge gate) | gate.sh:48-63; kube_runner.py:382-393 | REQUEST-CHANGES/no-verdict fails the attempt → retry with reasoning, then escalate | M |
| REVIEW-02 | Review/Obs | Review reasoning + pytest output are write-only (`logs_tail` exposed by no API) | entrypoint.sh:105; kube_jobs.py:251 unused | Parse review NDJSON to a durable summary + `GET /api/requests/{rid}/jobs` | M |
| MERGE-04 | Merge | GitHub seam has no transient retry/backoff; every 5xx/429/timeout escalates | github.py:48,60-107; kube_runner.py:526-530 | Bounded backoff on idempotent calls; classify 5xx/429 infra; `is_merged(sha)` pre-check | S/M |
| DEPLOY-01 | Deploy | In-cluster registry has no PVC; a restart loses every image → all apps ImagePullBackOff | registry.yaml no volume | RWO PVC on `/var/lib/registry`, strategy Recreate | S |
| DEPLOY-02 | Deploy | No registry GC/delete; disk grows unbounded, a full registry breaks all pulls | grep GC → none | `REGISTRY_STORAGE_DELETE_ENABLED` + GC CronJob keyed to live digests + PVC alert | M |
| DEPLOY-03 | Deploy | Pods never reaped (live: 0 Jobs, 31 ownerless pods/15h); DeleteOptions body drops Foreground | kube_client.py:115-125; no ttlSecondsAfterFinished | `V1DeleteOptions(propagation_policy="Foreground")` + ttlSecondsAfterFinished + smoke assertion | S |
| DEPLOY-04 | Deploy | Build/deploy Jobs bypass the concurrency cap (counts stage/gate only) | kube_runner.py:166-173,606-608 | Count build/deploy against a cap + ResourceQuota | M |
| OPERATE-01 | Operate | Produced app never registered (no `App` row) → invisible in fleet, unrollbackable, follow-up = greenfield | events.py:20-22; kube_runner.py:595-596 | On first deploy, atomically create/attach an `App` (stable slug) via transition+intent. C1 prereq | L |
| OPERATE-03 | Operate | No post-deploy health monitoring; notifications log-only; a 2am break is undetected | kube_runner.py:803-804; notifications.py:16-18 | Periodic tick-loop liveness probe of live Ingresses → escalation + fleet status | M |
| SEC-03 | Security | Unauthenticated git-daemon (`--export-all --enable=receive-pack`) → cross-request read+push | factory-api.yaml:84-92; workspace.py:177 | Drop receive-pack (orchestrator sole writer) or authenticated backend; cross-request smoke | M/L |
| SEC-04 | Security | Real creds in every stage pod + `logs_tail` is an unscrubbed leak channel | entrypoint.sh:102-105; kube_runner.py:216,277 | Central secret-scrub before every log/envelope persist; no token on review stage | S/M |
| FAIL-01 | Failure | Unbounded hangs freeze the factory (no timeout on any git subprocess / k8s call) | ws_exec.py:12-13; main.py:72-76 | `timeout=` on `_git`; `_request_timeout` on k8s calls; tick-duration watchdog | M |
| FAIL-02 | Failure | Stage-infra loops uncapped (3-strike rule exists for gate/build, not stage rows) | kube_runner.py:1096-1097,1416-1446 | Apply the 3-consecutive-infra rule to the stage path + 409-park path | M |
| DATA-02 | Data | Demo seed leaks into a fresh prod DB (`FACTORY_SEED_DEMO:"1"` is the only shipped config) | configmap.yaml:16; seed.py:20-35 | `deploy/overlays/prod` with SEED_DEMO=0 + DB_URL secret; runbook mandates both | S |
| DATA-03 | Data | No backup/restore or volume durability; the only backup targets local dev SQLite | factory-api.yaml:1-9; Taskfile.yml:152 | Azure PITR + drilled restore; interim PVC `.backup` CronJob; StorageClass Retain | M |
| DATA-04 | Data/Obs | Unbounded append-only growth vs a 2 GB Azure Basic ceiling | models.py:257,384-385; azure-sql-dev.md:8 | Archive/partition the cold log tail; cap `logs_tail`; storage alert | M |
| OBS-01 | Observability | Durable per-Job evidence captured then exposed by no API → infra failures force kubectl | kube_runner.py:216,248,277 | `GET /api/requests/{rid}/jobs` + dossier pod-logs drawer; surface at escalation | M |
| COST-01 | Cost | Zero cost/token/spend accounting anywhere; runaway bounded by time not money | grep cost/token → none; mission.py:39-87 | Capture codex usage into the envelope; job-minutes from timestamps; cost block in dossier | M |
| SPA-01 | Factory-self | The factory can't ship or roll back **itself** the way it ships apps (`:dev` by hand + kind load) — NEW | Taskfile.yml:179-189; ci.yml never ships images | Release pipeline for the factory's own images, or fold into office GitOps | M |
| BRAIN-01 | Submit | The real-LLM intake the product promises never runs in prod (health=scripted), unproven e2e — partly NEW | interview.py:382-391; agent_exec.py:38-39 | Wire the API-pod credential path; in-cluster agent-brain smoke; LLM failure escalates not degrades | M |

### MED (24) and LOW (9)

The full MED/LOW rows — INTAKE-04..08, BUILD-03..07, REVIEW-03..06, MERGE-02/03/06,
DEPLOY-05..09, OPERATE-04/06, FAIL-03..08, DATA-05..08, OBS-02/03, COST-02/03,
SEC-05/06/07, CONTRACT-01, A11Y-01, SECRET-LIFECYCLE-01, LICENSE-01 — are in
`scratchpad/audit/synthesis.md` Part 1 with the same evidence/fix/effort
columns. Highlights worth pulling forward:

- **DEPLOY-08 (MED)** — deploy gate is blind (reuses the merge modal, shows no
  digest/SHA/preview); closed by C1 + C3.
- **OPERATE-04 (MED)** — console hardcodes `role:'admin'`, so viewers see enabled
  Approve/Rollback and learn via a 403.
- **FAIL-06 (MED)** — the single-worker guard doesn't guard: `uvicorn --workers 2`
  slips the env check and the SQLite leader lock always succeeds → two leaders,
  doubled spend.
- **DATA-07 (MED)** — a self-documented unclosed RCSI race in `cas_status`
  (transitions.py:604) — the exact class the merge-claim race already surfaced.
- **SEC-06 (MED)** — no gitleaks/SAST/image-scan in gates; unpinned kaniko + bases.

---

## Contradictions resolved (better-evidenced score chosen)

1. **Review verdict — CRITICAL vs HIGH → HIGH.** The human merge gate + green
   tests are a backstop, so a bad-but-green build cannot merge without a human
   click. A quality/autonomy failure, not an unattended-safety hole.
2. **Acceptance criteria — CRITICAL vs HIGH → HIGH.** Foundational and
   cross-cutting (drives C1/C3/C4 grading) but degrades quality, not
   correctness/security. The single highest-leverage HIGH.
3. **Empty-submit floor — HIGH vs LOW → HIGH.** The floor is client-navigation
   only; a direct `POST /submit` burns real codex spend. A server-authority gap
   on a money path is HIGH.
4. **Build security axis — 5 vs 4 vs 2 → 2 (system).** The 5/5 scored the stage
   in isolation; the authoritative system score counts the token-bearing pods +
   open egress + injectable SPEC.md.
5. **Architecture parity — 2 vs 4 → both, different sub-axes.** Product parity
   (new-app→expenses mismatch) is 2 and is the one that blocks "build my app";
   infra parity (runs on OpenShift) is 4.

## Coverage gaps no stage auditor caught (codebase-verified)

- **SPA-01 (HIGH)** — the factory's own release pipeline; it holds itself to a
  lower bar than the apps it produces.
- **BRAIN-01 (HIGH)** — the `FACTORY_BRAIN=agent` real-LLM intake is unproven
  end-to-end and silently masks failure to the scripted floor.
- **CONTRACT-01 (MED)** — intake↔API wire contract is hand-synced, no codegen /
  contract test / API versioning.
- **A11Y-01 (MED)** — the two SPAs were never a11y/i18n/mobile-audited;
  `lang="en"` hardcoded, English-only intake; and friction **F0** (browser
  harness down) meant no one verified they render in either theme this audit.
- **SECRET-LIFECYCLE-01 (MED)** — token sync/expiry/rotation drill uncovered.
- **LICENSE-01 (LOW)** — produced-app licensing / PII / output-safety unexamined.

## Friction log (Phase-1 walkthrough)

The interactive walkthrough was **blocked** — the in-app browser/CDP harness hit
the 300s timeout on both `preview_start` and `navigate` though intake+console
return HTTP 200 (friction **F0**, a real operability gap: no non-browser way to
confirm the UI renders). Evidence was gathered from curl + the Angular source +
the live cluster instead. Confirmed live: `brain:scripted` (canned intake, real
build stages only); prototype data discarded before build; new-apps mutate the
fixed Expenses sample; merge/deploy gates near-blind; 31 orphaned pods after
15h; API open with no auth. Full table in `scratchpad/friction-log.md`.

---

## Plan C roadmap

Legend: **[kind]** provable on local kind · **[office]** office/OpenShift
Phase-2 overlay.

- **C1 — Preview & feedback loop [kind]** (the mandated headline). Closes
  PREVIEW-01; advances DEPLOY-08 + REVIEW-03; retires the "Review & Preview"
  false copy. **Pre-merge placement** (both designs agree): feedback rounds
  re-run agent stages on the work branch at zero human gates per round, and the
  SHA-preconditioned merge of the graded SHA ships byte-for-byte what the
  requester accepted (the Vercel model). Build a6's simpler fully-graded backbone
  (rewind to architecture + `SF_PREVIEW_FEEDBACK`); adopt the PreviewFeedback
  disposition model + gate copy; defer the dedicated `replan` stage to v2.
  Prereqs: OPERATE-01 (stable slug) + the `_supersede_rewound_rows`
  `KUBE_STAGES.index` crash fix. Effort **L (~10–12d)**.
- **C2 — Correctness & failure-recovery hotfixes [kind].** OPERATE-02
  (teardown-nukes-prod), DEPLOY-03 (orphan pods, one-line), FAIL-01 (git/k8s
  timeouts), FAIL-02 (stage-infra cap), FAIL-03/04/07, DEPLOY-05. Effort **M
  (~5–7d)**.
- **C3 — Gate evidence & feedback fidelity [kind].** OBS-01/REVIEW-02 (expose
  StageJob logs), ARCH-02 (PLAN.md visibility), REVIEW-01 (bind the verdict +
  REQUEST-CHANGES loop), REVIEW-03 (PR link + diffstat), BUILD-03/04,
  DEPLOY-08. Effort **M/L (~7–9d)**.
- **C4 — Acceptance-criteria contract [kind].** INTAKE-02 backbone → unlocks
  REVIEW-04 + BUILD-02 grading + gives C1 something to grade against; INTAKE-06
  immutable spec snapshot. Effort **L (~8d)**.
- **C5 — Production-parity infra [kind].** DEPLOY-01 (registry PVC), DEPLOY-02
  (GC), DEPLOY-04 (build cap), DEPLOY-06 (ResourceQuota), SEC-05 (registry
  auth), SEC-06 (kaniko pin + Trivy/gitleaks), BUILD-02 (dep-installing gate).
  Effort **M/L (~8d)**.
- **C6 — Security hardening [kind]+[office].** [kind]: SEC-02 (SPEC.md
  data-fence + logs scrub), SEC-04, SEC-03 (git-daemon), INTAKE-03. [office]:
  SEC-01 (Entra API auth), SEC-02 (GitHub App per-request tokens), SEC-07
  (PodSecurity/Kyverno), MERGE-05 (branch protection). Effort **L (~10d)**.
- **C7 — Observability & cost [kind].** COST-01 (token/job-minute accounting),
  COST-02 (fairness quota + queue position), COST-03 (retry budget), FAIL-04
  (codex-cap classification), OBS-02 (livenessProbe), OBS-03, DATA-04. Effort
  **M (~6d)**.
- **C8 — Operate, iterate & factory-self [kind]+[office].** OPERATE-01
  (auto-register — pulled into C1 as prereq), OPERATE-03 (post-deploy liveness),
  OPERATE-04 (role in UI), BRAIN-01 (wire+test the agent brain), SPA-01
  (factory-self release pipeline [office]), CONTRACT-01, A11Y-01. Effort **M/L**.
- **C9 — Data & DR [office]** (Unicode fix is [kind]-testable). DATA-01
  (Unicode), DATA-02 (prod overlay), DATA-03 (backup + drilled restore),
  DATA-05/06/07/08. Azure SQL cutover stays office/handoff.

### Recommended build order

1. **C2 first** — OPERATE-02 *destroys production*, and C1's extra ephemeral
   deploy/teardown activity makes the teardown-nukes-prod + orphan-pod bugs more
   likely to fire. De-risk the deploy path before building on it.
2. **C1** — the mandated headline and the single largest product gap.
3. **C4** — the grading backbone C1/C3/BUILD/REVIEW all lean on; cheapest to
   thread before those slices harden around prose.
4. **C3** — makes both human gates real once there's something worth surfacing.
5. **C5** — registry durability/GC/quota; needed before sustained multi-request
   load or an office pilot.
6. **C7** — spend visibility + liveness restart; cheap, self-contained.
7. **C6** — [kind] half rides alongside C5/C7; the [office] half gates the
   office pilot, not local kind.
8. **C8 / C9** — operate-loop + Azure parity that matures with the office
   overlay.

Each slice ships by the proven B-arc loop: plan → codex TDD → adversarial opus
review → clean-worktree `make verify` → `--no-ff` merge → CI green → **a kind
smoke that asserts the new behavior forever**.
