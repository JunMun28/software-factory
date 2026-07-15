# Adversarial review synthesis — OpenShift/K8s architecture spec

**Date:** 2026-07-14
**Spec reviewed:** `docs/superpowers/specs/2026-07-14-openshift-kubernetes-architecture-design.md` (amended version)
**Reviewers:** 5 independent passes — Codex (gpt-5.5) adversarial review + four fable subagents
(platform reality, distributed-systems correctness, scope/YAGNI, best-in-class benchmark).

## Verdict

The core shape survived all five reviews: **Job-per-stage, writer-never-grades,
factory-owned deploy manifests, git-as-workspace, state-machine-in-DB**. Nobody attacked
the fundamental architecture. What got shredded was (1) the **sequencing** — the spec
front-loads ~4–6 weeks of migration work before anything runs, (2) the **concurrency
story** — it inherits ADR 0013's single-process guarantees while removing the single
process, and (3) several **platform facts** the spec asserted wrong.

## The big convergence: three reviewers independently point to the same re-phasing

- Scope: Azure SQL migration is a buried megaproject that churns the crown-jewel gate
  tests; defer it. Leader election (2 replicas + `sp_getapplock`) is "distributed-systems
  cosplay" for one operator; defer it.
- Platform: the local SQL Server container is amd64-only (unstable under Rosetta on
  Apple Silicon), and Azure SQL free-tier auto-pause fights the tick loop (either the
  loop burns the free quota or pauses kill the leader's connections). The local DB story
  as written **does not run on the target laptop**.
- Distsys: `sp_getapplock` as specced has a silent split-brain mode (connection-bound
  lock, no fencing); fixing it properly needs lease epochs on every write — a real
  subsystem.

**All three resolve the same way: single replica + SQLite for the entire local kind
phase.** The existing test suite survives untouched; DB migration and leader election
move to office-promotion time — and when they come, they come with fencing (F-D1) and
CAS transitions (F-D2) designed in, not bolted on.

## P0 — design corrections (apply to the spec now; wrong regardless of phase)

| # | Finding | Source | Fix |
|---|---|---|---|
| P0-1 | kind's default CNI (kindnet) does not enforce NetworkPolicy — local walls are silently fiction | platform F1 | install Calico/Cilium in kind; add a NetworkPolicy smoke test (agent pod → factory-api must FAIL) to verify |
| P0-2 | "egress to github.com only" is not expressible in vanilla NetworkPolicy (FQDN); DNS egress also missing | platform F2 | name the mechanism per overlay: OVN `EgressFirewall` on OpenShift (new §9 platform ask), Cilium FQDN or egress proxy locally; allow port 53 everywhere |
| P0-3 | Gate grades a branch head, not a pinned SHA (TOCTOU gate→merge); force-push unconstrained on `sf/*` | distsys F3, Codex | gate records graded SHA; merge via GitHub API `sha` precondition; branch rules deny force-push/delete on `sf/*` |
| P0-4 | gitleaks-after-push scans **after** the secret is public; public-repo scrapers win in <1 min | platform F6 | produced-app repos **private until the merge gate** (or GA); scan hit triggers automatic key revocation, not just stage failure |
| P0-5 | `result.json` via termination message hits the 4 KB kernel cap — review summaries/test reports truncate | platform F7 | termination message = small status envelope only; large payloads via structured pod-log tail fetched by orchestrator |
| P0-6 | No Job cleanup lifecycle: object-count quota exhaustion at scale; TTL races log capture; evicted pods lose logs | platform F8, distsys F6 | orchestrator owns deletion: capture logs + verdict first, then delete Job; no TTL (or long backstop TTL); log-capture failure = its own escalation |
| P0-7 | Gate Job can't distinguish "tests failed" from "infra failed" (eviction/image-pull = false gate failure) | distsys F9 | `podFailurePolicy` ignores DisruptionTarget; structured verdict: absent verdict = infra error → re-run gate without consuming an attempt |
| P0-8 | Orchestrator-side wall clock missing: a partitioned node leaves a Job "active" forever → silently stranded request (violates ADR 0013) | distsys F8 | per-(stage, attempt) orchestrator timeout independent of Job status; completions from non-current attempts discarded |
| P0-9 | `sf-agent` image not designed for restricted-v2 (random UID breaks git/opencode/npm/uv caches incl. the baked dep cache) | platform F3 | build image to arbitrary-UID conventions (`g=u` perms, `HOME=/workspace`) NOW; test locally with `runAsUser: 1000710000` |
| P0-10 | Attempt semantics undefined (what increments attempt; half-pushed branch inherited silently by next attempt) | distsys F4 | define attempt transitions in the state machine; record per-attempt start SHA; new attempt resets branch to last-graded SHA |

## P1 — re-phasing (changes the spec's phasing sections)

**Phase 1 = walking skeleton on kind ("one request, end to end, this week"):**
existing factory-api deployed as-is (single replica, SQLite on PVC, scripted brain OK) +
one new `KubeJobRunner` behind the existing `FACTORY_RUNNER` seam (per AGENTS.md §7 —
the repo already prescribes exactly this extension pattern) + fine-grained PAT behind a
`get_push_credential()` seam + poll Job status from the existing tick loop (no watch
API) + gate Job running fixed factory-owned commands + static factory-owned deploy
manifest with digest substitution + template repo bootstrapped from `sample/`.

**Deferred to office promotion (Phase 2):** Azure SQL migration (with fencing epochs +
CAS transitions + intent log designed in — distsys F1/F2/F5 are the entry criteria, not
afterthoughts), 2 replicas + leader election, GitHub App + per-Job installation tokens,
gitleaks per-gate, EgressFirewall ask, BuildConfig asks (Docker-strategy permission,
build resource envelope, ImageStream pruning — platform F9), Route admission asks,
openshift overlay written in the week cluster access exists.

**Deferred to scale (Phase 3):** Prometheus metrics, commit statuses, warm-dep-cache
automation, aks overlay, preview environments per PR, HPA.

**Cut from MVP entirely:** manifest validator beyond static-template substitution
(rebuild when request-supplied parameters actually flow into deploy), kustomize overlays
for clusters that don't exist yet.

## P2 — best-in-class additions (benchmark review; agree scope before adding)

The benchmark reviewer's cross-cutting insight: the spec is a solid *execution*
substrate with no answer to **"is the factory getting better or worse?"**

| # | Gap | Best-in-class practice | Suggested phase |
|---|---|---|---|
| P2-1 | No eval/regression harness for prompt/model/CLI changes | golden-request replay suite gating any change to the agent surface; the event log already contains the eval cases | Phase 2 (design the event-log capture NOW so cases accumulate from day one) |
| P2-2 | Single-shot → `needs_human` on every failure | bounded retry-with-feedback (gate output injected into attempt 2's prompt), optional model escalation | Phase 1-lite (N=2 retry), full loop Phase 2 |
| P2-3 | Cost recorded but not enforced | token budget on the per-Job gateway key + cumulative per-request cap → `needs_human` on breach | Phase 2 (pairs with P2-2 — retries without budgets is dangerous) |
| P2-4 | No structured context handoff between stages | versioned in-repo plan/constraints contract written by architecture, injected into build/review prompts, conformance graded at review | Phase 1 (it's a prompt+file convention — cheap) |
| P2-5 | Merge gate approves code never seen running | per-PR preview instance via the trusted deploy path; URL in the merge-gate packet | Phase 3 |
| P2-6 | Merge-gate review packet undefined | curated evidence bundle: diff stats, review summary, gate evidence, cost, preview URL | Phase 2 |
| P2-7 | One model pin for all stages | per-stage model pins in ConfigMap; model-per-attempt recorded in events | Phase 1 (trivial config change) |
| P2-8 | Template drift: vendored copies never upgraded | template version stamped per app; "template sync" as a factory request type reusing the whole PR machinery | Phase 3 |
| P2-9 | `needs_human` resolutions are forgotten | each resolution yields an eval case / prompt fix / template issue | Phase 2 |
| P2-10 | No pick-up ordering across requests | oldest-runnable-first + per-request in-flight cap in the tick loop | Phase 1 (one line in the tick design) |

## Open decisions for the owner

1. **Merge-gate mechanics** (unchanged from spec §6): console-merge (a) vs full ADR 0005
   two-gate (b) vs two-console-gates (c). Note distsys F3: the graded-SHA merge
   precondition is required under ALL three.
2. **Accept the P1 re-phasing?** (single replica + SQLite locally; Azure SQL + leader
   election at office promotion.) This contradicts the earlier "Azure SQL now" decision,
   but three independent reviews converged against it — and the local SQL Server
   container physically doesn't run well on the Apple Silicon laptop.
3. **Repo visibility:** produced-app repos private-until-merge (P0-4) — cheap and
   closes the worst exfiltration window. Any reason they must be public from birth?
4. **Which P2 items to pull into the spec now** — recommendation: P2-2-lite, P2-4,
   P2-7, P2-10 (all cheap in Phase 1) + the event-log capture shape for P2-1.

## Appendix — full reviewer outputs

Full texts preserved in the session transcript; findings condensed above are traceable
by reviewer + finding number (platform F1–F10, distsys F1–F10, scope 1–10, benchmark
F1–F10, Codex 4 findings). Adequacy re-checks confirmed: factory-owned manifests,
extended frozen-hash surface, and package-registry egress hold as written; credential
hardening (timing) and warm dep cache (UID ownership) required the P0-4/P0-9 revisions.
