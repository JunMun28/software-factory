# AIRES on Kubernetes — Architecture Design (v2)

**Date:** 2026-07-14
**Status:** approved — brainstormed, adversarially reviewed (Codex + 4 independent
review passes), amended, owner-approved with four architect amendments
**Review synthesis:** `docs/reviews/2026-07-14-openshift-spec-adversarial-review-synthesis.md`
**Relates to:** ADR 0002, 0005, 0006, 0008, 0013, 0014, 0017, 0021, 0024

---

## 1. Goal

Run the whole AIRES on Kubernetes — the factory, the opencode agents that
execute pipeline stages, and every app the factory produces. **Local-first**: the
primary development environment is kind on a personal Mac, built **production-shaped**
(owner's explicit choice: pay the migration cost once, up front) so promotion to the
office OpenShift cluster and later AKS is overlay work, not redesign.

### Fixed decisions

| Question | Decision |
|---|---|
| Dev environment | kind on macOS (OrbStack/Docker Desktop) **with Calico** (kindnet does not enforce NetworkPolicy) |
| Office target | enterprise OpenShift 4.x, shared, **one namespace**, restricted SCC |
| Later target | AKS (overlay + build-seam swap) |
| Database | **Azure SQL from day one** (dev = Basic ~$5/mo with a DTU alert; expect S0 ~$15/mo; CI = `mssql/server` container on amd64 GitHub runners) |
| Concurrency target | 5–20 pipeline runs (eventual; not day one) |
| LLM access | opencode → OpenAI-compatible provider seam (laptop: personal key; office: internal AI gateway) — one `baseURL` swap |
| Git | github.com; factory repo + golden template repo + one repo per produced app, **private until merge gate** |
| Produced-app stack | one golden template: FastAPI + Angular (pressure valve: FastAPI+HTMX second template if agents struggle with Angular) |
| Merge/deploy gates | **two console gates** (approve-merge, then approve-deploy), approver identity recorded in the event log from day one; full ADR 0005 GitHub-native flow at multi-user graduation |
| Orchestration | control plane + one Kubernetes Job per stage (Argo/Tekton rejected — would re-implement the gate crown jewels) |

Design rule (AGENTS.md): **deterministic seams are disposable; the domain model is
not.** This design replaces the execution seams (subprocess → Job, SQLite → Azure SQL)
and keeps gates, escalation, the append-only `progress_event` log, and stage semantics
in the existing Python control plane. AGENTS.md §7 already prescribes the extension
pattern: a new runner behind `FACTORY_RUNNER`, verified by the existing FakeExecutor
gate tests.

---

## 2. Topology — one namespace, label-tiered

```
┌─ ns: software-factory ─────────────────────────────────────┐
│  TIER factory   intake SPA · console SPA                   │
│                 factory-api (Deployment) → Azure SQL       │
│  TIER agent     one Job per stage run (opencode image)     │
│                 one gate Job per gate check (no LLM)       │
│                 one build Job per app image (local: kaniko)│
│  TIER app       per produced app: Deployment · Service ·   │
│                 Ingress/Route · NetworkPolicy              │
└────────────────────────────────────────────────────────────┘
```

Walls inside the single namespace:

- **Labels:** `sf/tier: factory|agent|app`; app objects add `sf/instance: <slug>`.
  Queries, policies, teardown (`delete -l sf/instance=<slug>`) key off these.
- **NetworkPolicies by pod selector** (all policies include UDP/TCP 53 to cluster DNS):
  - agent pods → AI provider endpoint, github.com, package registries; nothing in-cluster;
  - gate pods → github.com + package registries only (no LLM endpoint);
  - build pods → registry + github.com;
  - app pods → no factory, no peers; factory-api → Azure SQL.
  - **FQDN egress mechanism is per-overlay** (vanilla NetworkPolicy cannot express
    "github.com only"): Calico/Cilium FQDN rules locally; **OVN EgressFirewall** on
    OpenShift (platform-team ask); NSG/FQDN policy on AKS.
  - A **NetworkPolicy smoke test** (agent pod → factory-api must FAIL) runs in the
    deploy verify — enforcement is proven, never assumed.
- **Resources:** requests/limits on every pod template; orchestrator caps concurrent
  Jobs (config, start 10); quota model counts agent + gate + build + app pods.
- **ServiceAccounts:** factory-api SA (Jobs + app-manifest apply); agent/gate/build SAs
  with `automountServiceAccountToken: false` and zero RBAC.

Accepted trade-off: label-deep walls, not namespace-deep. First graduation step at
multi-user: split into three namespaces (the tiers make it mechanical).

### Environment profiles (kustomize: `deploy/base` + overlays)

| Concern | local kind (primary) | OpenShift (office) | AKS (later) |
|---|---|---|---|
| CNI / egress | Calico + FQDN rules | cluster CNI + EgressFirewall | Azure CNI + policy |
| HTTP | ingress-nginx | Route | Ingress/Gateway API |
| Produced-app image build | **kaniko build Job** → local registry | BuildConfig → internal registry | GitHub Actions → ACR |
| Database | Azure SQL (same instance as office dev) | Azure SQL | Azure SQL |
| LLM | `FACTORY_CLI=codex` on the Codex subscription (laptop's `~/.codex/auth.json` synced to a Secret via `task sync-codex-auth`; single-developer only) | `FACTORY_CLI=opencode` → internal AI gateway | opencode → internal AI gateway |
| Pod security | pods run with a forced random UID to emulate restricted SCC | restricted-v2 | pod security standards |
| Console auth | none (laptop) | **OAuth proxy — hard entry criterion** | Entra ID |

`overlays/openshift` and `overlays/aks` are written in the week access exists — not
speculatively maintained. Office validation checklist (not blockers): restricted-SCC
behavior under a real admission controller, corporate egress firewall, internal
registry, BuildConfig Docker-strategy permission.

### Azure services by phase

- **Phase 1 (now):** one Azure SQL Database (Basic ~$5/mo → S0 ~$15/mo if the DTU alert
  fires). No app registrations, no ACR. Budget alert (e.g. $20) before creating
  anything.
- **Phase 2 (office):** unchanged Azure footprint; adds platform-team asks (§9).
- **Phase 3 (AKS):** AKS (free control plane + small node ~$30–70/mo, stopped when
  idle) · ACR Basic (~$5/mo) · Entra app registration + **OIDC federated credential**
  for GitHub Actions · **workload identity** for factory-api → Azure SQL · optional Key
  Vault, Log Analytics (cap ingestion).
- Auth principle: plain secrets locally; every shared environment upgrades to
  identity-based auth, shrinking long-lived credentials.

---

## 3. Control plane

Keeps all domain logic. Changes:

1. **SQLite → Azure SQL** (`mssql+pyodbc`, MS ODBC 18 in the api image, Debian-slim
   base). **Alembic migrations from day one** — the schema now outlives deployments;
   `create_all` is replaced by versioned migrations. Gate-test fixtures migrate to
   MSSQL in week one (the knowingly-chosen cost of production parity). Azure SQL
   endpoint joins egress allowlists; credentials are a Secret (file-mounted).
2. **Leader election, hardened from day one:** `sp_getapplock` on a **dedicated,
   non-pooled, heartbeated connection**, plus a **monotonic leader-epoch**; every
   state-mutating statement is a compare-and-swap guarded by expected status **and
   epoch** (`UPDATE … WHERE status=:expected AND epoch=:mine`). A stalled ex-leader
   that resumes cannot advance anything. Normal operation: 1 replica; failover is
   tested by flipping to 2 against real Azure SQL (the environment that actually kills
   connections).
3. **Intent log (moved into Phase 1 — it is leader election's safety net):** for every
   external side effect (create repo, open PR, merge, trigger build, apply deploy) the
   orchestrator writes an intent row (with idempotency key) in the same transaction as
   the state transition + event append, performs the call, records the outcome.
   Recovery replays open intents idempotently. Event append + state transition are
   always one transaction.
4. **Resumable in-flight state:** stage rows carry the deterministic Job name
   (`sf-<ref>-<stage>-<attempt>`); a recovering leader re-attaches. **Job status is
   polled from the existing tick loop** — no watch API in MVP.
5. **Config:** env vars → ConfigMap; secrets file-mounted; probes on `GET /api/health`.
6. **Scheduling fairness:** oldest-runnable-first with a per-request in-flight cap.
7. **Approver identity** is recorded on every gate action event from day one. Console
   authentication: none locally; OAuth proxy is a **hard entry criterion for Phase 2**
   — human gates are only governance if identity is enforced.

SPAs unchanged (nginx + ingress). CI keeps `task verify` on `sim`/`scripted` plus an
MSSQL-container job for DB-touching tests.

---

## 4. Request lifecycle

The factory is a DB state machine driven by the leader's tick loop; the orchestrator
*notices* work, nothing pushes it.

1. **Submit** → state `submitted`, event appended.
2. **Spec gate (human #0)** — approve draft spec in the console → `queued_for_pipeline`.
3. **Pick-up** — tick finds runnable request + free Job slot → first time: creates the
   **private** app repo from the golden template (via intent log) → Job
   `sf-<ref>-architecture-1`.
4. **Architecture stage** — agent Job writes the plan **and the handoff contract**
   (§5), pushes `sf/<ref>`, exits. Factory opens PR (statuses posted per stage).
5. **Gate + advance** — gate Job grades the **pinned SHA**; orchestrator verifies
   frozen-surface hashes, appends milestone event + CAS-advances state; next tick
   spawns build-RED → GREEN → review.
6. **Retry-with-feedback** — a failed stage retries once (N=2) with the gate's output
   injected into the second attempt's prompt (optionally a stronger model); then
   `needs_human`. Every attempt is an event.
7. **Notification** — SPAs poll the event feed / "Your turn" inbox; a Teams/Slack/email
   notifier can watch the same log later, no redesign.
8. **Console gate #1 (approve-merge)** — merge via GitHub API **with graded-SHA
   precondition**; repo flips public here if desired.
9. **Build** — build Job (kaniko locally / BuildConfig on OpenShift / Actions on AKS)
   at the merge SHA, by digest.
10. **Console gate #2 (approve-deploy)** — deterministic deploy (§7): factory-owned
    manifests, rollout wait, health probe through the ingress, final event carries the
    live URL.

Any failure, timeout, or gate failure → `needs_human` with logs and recovery actions
(ADR 0013 unchanged). Cancel wins: cancel CAS-transitions the request and deletes the
running Job.

---

## 5. Agent Jobs

One `sf-agent` image: opencode CLI, git, Python+uv, Node+Angular, factory-owned
opencode configs, golden-template dependencies pre-baked as a warm cache. The image is
built to **arbitrary-UID conventions** (root-group ownership, `chmod g=u`,
`HOME=/workspace`) and local pods run with a forced random UID — restricted-SCC
compatibility is proven locally, not discovered at the office.

Entrypoint (~50 lines): shallow-clone work branch → select `OPENCODE_CONFIG`
(readonly/write split per ADR 0024; provider block = `@ai-sdk/openai-compatible` +
`baseURL` + file-mounted key) → `opencode run --format json --dir /workspace -m
<provider/model>` with the stage prompt + single-turn directive → commit/push (write
stages) → exit.

**Stage outputs:** termination message carries only a small status envelope (4 KB
kernel cap); large payloads (review summaries, test reports) travel as structured
NDJSON in pod logs, which the **orchestrator captures before deleting the Job** (it
owns the full Job lifecycle; no `ttlSecondsAfterFinished`; log-capture failure is its
own escalation reason). The read-only review stage holds no push credential; its
summary reaches the event log + PR comment via the captured output.

**Handoff contract:** the architecture stage writes `docs/plan.md` + a machine-readable
constraints/decisions file; both are injected verbatim into build and review prompts,
and the review stage explicitly grades conformance to them.

**Models:** per-stage pins in ConfigMap; model-per-attempt recorded in events (feeds
the future eval harness).

**Bounds and security:** Job `activeDeadlineSeconds` **plus** an orchestrator-side
wall-clock per (stage, attempt) — a partitioned node cannot strand a request;
completions from non-current attempts are discarded. `backoffLimit: 0`;
`podFailurePolicy` ignores DisruptionTarget so evictions don't consume attempts. No SA
token. Egress per §2. Push credential: Phase 1 = fine-grained PAT behind a
`get_push_credential()` seam; Phase 2 = GitHub App per-Job installation tokens.
Force-push and branch deletion denied on `sf/*`. **Attempt semantics:** attempts
increment only via defined transitions (gate-fail retry, human Retry, orchestrator
timeout); each attempt records its start SHA; a new attempt resets the branch to the
last-graded SHA so half-pushed work from a killed pod is never silently inherited.

**Credential exfiltration:** repos are **private until merge**, closing the
public-scraper window; gitleaks runs pre-merge and a hit triggers **automatic key
revocation** plus stage failure; provider keys are per-environment (per-Job TTL keys
where the gateway supports them); documented upgrade: validating push broker.

---

## 6. GitHub and gates

Repos: `software-factory` · `sf-template-webapp` (golden template: app skeleton,
Dockerfile, tests layout, Taskfile, handoff-contract templates; bootstrap = promote
`sample/`) · `sf-app-<slug>` per app (private until merge).

Branch model: protected `main`; per-request `sf/<ref>`; every stage commits there —
the branch history is the audit trail; PR opened after architecture; stage results as
commit statuses.

**Gate execution is outside the control plane** (LLM-written code never runs in the
factory pod):

- **Gate Job** — deterministic, no LLM access, no push credential; clones the **pinned
  SHA**, runs **fixed factory-owned test commands** (never repo-defined scripts),
  emits a structured verdict. Absent verdict = infra failure → gate re-runs without
  consuming an attempt or escalating.
- **Frozen-surface check** (orchestrator-side, pure git tree-hash, fully trusted)
  covers `tests/`, `conftest.py`, `pyproject.toml`, `pytest.ini`, `setup.cfg`,
  `tox.ini`, `package.json` scripts, vitest/Angular test configs — config-based test
  deselection is caught. Integrity depends on the no-force-push rule (§5).
- **Merge** happens only via the GitHub API SHA precondition: merge iff head ==
  graded SHA. Writer never grades; grader never writes; merger checks the grade.

Residual risk (accepted, documented): hostile generated code could misreport results
*within* the gate pod; it cannot touch the factory, DB, other apps, or the hash check.
Upgrade path: kernel-isolated runtimes (OpenShift Sandboxed Containers / Kata;
Kubernetes agent-sandbox).

---

## 7. Build and deploy of produced apps

Deterministic — no LLM anywhere past the review stage.

1. **Build seam** (three implementations behind one interface): kaniko Job (local) /
   BuildConfig (OpenShift) / GitHub Actions→ACR (AKS). Input: repo + merge SHA;
   output: image **digest** recorded in the DB via the intent log.
2. **Deploy** — manifests are **factory-owned, never agent-written**; the orchestrator
   renders its trusted template with allowlisted parameters only (slug, digest,
   replicas) and applies via the deploy SA (namespace-scoped). App repo `deploy/` is
   documentation, not input. MVP renders a static template; a validating renderer
   arrives only when request-supplied parameters are wired through.
3. **Verify** — rollout wait + health probe through ingress/Route; failure →
   `needs_human` with pod logs; never a silent half-deploy.
4. **Iterate** — follow-up request = new branch → PR → gates → merge → rebuild →
   rolling update; rollback = `rollout undo`.

Template contract: app code + tests layout + Dockerfile + handoff templates versioned
together; template version stamped into each app repo. Existing apps keep their
vendored copy; **template-sync as a factory request type** (reusing the whole
PR-gate-merge machinery) is the Phase 3 answer to drift/CVEs.

---

## 8. Reliability, scalability, observability

State lives in exactly two places — Azure SQL (control state, events, intents) and
git (artifacts). Every pod is disposable.

| Failure | Behavior |
|---|---|
| Agent Job fails/times out | retry-with-feedback (N=2) → `needs_human` with captured logs |
| Gate pod evicted / image-pull error | infra-failure path: gate re-runs, no attempt consumed, no escalation |
| Leader dies or stalls | standby (when 2 replicas) acquires lock + **new epoch**; stale leader's writes fail CAS; open intents replayed idempotently |
| LLM endpoint / GitHub outage | stage fails → escalate with retry action; orchestrator backs off |
| DB blip | reconnect-and-reverify (not restart); lock-churn is a first-class metric |
| Node partition | orchestrator wall-clock fires regardless of Job status → escalate |
| Job reaped before observation | cannot happen: orchestrator owns deletion, captures outcome first |

Scalability knobs in order: concurrent-Job cap (10) → per-Job resources vs quota
(agents + gates + builds + apps all counted) → provider rate limit (the true ceiling).

Observability: (1) domain — `progress_event` + trace events + **tokens/cost and
model per attempt** ("what did this app cost?" answerable day one; the accumulating
per-request record is deliberately shaped as future eval-harness input); (2) `needs_human`
backlog is the factory's single health number; (3) Prometheus `/metrics` + alerts at
Phase 2 (OpenShift monitoring exists there to scrape it).

---

## 9. Phasing

**Phase 1 — production-shaped walking skeleton on kind.** Week-one: Azure SQL
migration + Alembic + fixture migration; hardened leader election + intent log; then:
`KubeJobRunner` behind `FACTORY_RUNNER`, sf-agent image (arbitrary-UID), gate Job,
PAT-behind-seam, kaniko build Job, static-template deploy, template repo from
`sample/`, retry-with-feedback, handoff contract, per-stage model pins, fairness
ordering, kind+Calico + NetworkPolicy smoke test. Milestone: **one request end-to-end
on kind against Azure SQL.**

**Phase 2 — office OpenShift promotion.** Entry criteria: console OAuth, GitHub App
tokens, EgressFirewall + BuildConfig + Route platform asks granted, `overlays/openshift`
written against the real cluster, 2-replica failover exercised, Prometheus wiring,
gitleaks-per-gate, eval-harness v1 (golden-request replay from accumulated event-log
cases).

**Phase 3 — AKS + scale.** ACR + Actions build seam + OIDC + workload identity,
preview environments per PR, template-sync request type, `needs_human`-to-eval-case
learning loop, per-request token budgets enforced at the gateway key.

## 10. Rejected / deferred (with reasons)

- **Argo/Tekton orchestration** — re-implements the gate crown jewels. Revisit only if
  control-plane Job orchestration proves painful.
- **Queue + worker pool** — needless infra at this concurrency; Jobs give fresh-pod
  isolation free.
- **Namespace per app** — blocked by cluster permissions; first multi-user change.
- **Kata/gVisor sandboxes** — documented upgrade, not MVP.
- **k8s watch API** — poll from the tick loop; watch semantics are underestimation bait.
- **Speculative openshift/aks overlays** — written when access exists.
- **Prometheus/commit statuses in Phase 1** — audience of one with a console.
- **SQL Server container locally** — amd64-only, unstable under Rosetta on Apple
  Silicon; real Azure SQL is more production-like anyway.

## 11. Platform-team asks (Phase 2 gate)

Egress: github.com, api.github.com, Azure SQL endpoint, package registries/artifact
proxy · OVN EgressFirewall grant · factory-api SA RBAC (Jobs + namespace-scoped apply)
· BuildConfig Docker-strategy permission + build resource envelope + ImageStream
pruning · Route hostname/wildcard-cert policy · quota sized for agents + gates +
builds + apps · OAuth proxy in front of the console.
