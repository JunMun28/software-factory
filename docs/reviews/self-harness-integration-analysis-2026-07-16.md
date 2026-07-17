# Self-Harness (arXiv 2606.09498) — integration analysis

**Date:** 2026-07-16
**Question:** Should the Software Factory adopt the Self-Harness paradigm, so that every
piece of feedback is recorded and the factory's agent harness (prompts, runtime policies)
improves over time?
**Method:** 14-agent workflow — 3 codebase mappers, 3 independent integration designs
(each attacked by 2 adversarial skeptics with repo verification), a related-work web
sweep, and an independent gpt-5.5 (codex) architect opinion. All findings below were
verified against the repo at file:line level unless marked otherwise.

---

## TL;DR

**Skip the paper's automated loop. Adopt a thin, adapted slice (~1–2 weeks):**

1. Unify the two duplicated prompt stores + parity test (~1–2 days, standalone hygiene win).
2. Stamp a `harness_version` digest on every StageJob (lineage; enables before/after attribution).
3. Add a structured human reject at merge/deploy gates (typed reason + keep the note +
   inject it into the retry prompt like gate reasons already are).
4. Add a read-only "harness pressure report" over data the factory **already records**.

Improvement stays human: a person reads the report and edits a ~1.5 KB prompt surface
through an ordinary reviewed PR. Do **not** build the paper's mining → K-proposal →
held-out regression loop here — its one load-bearing component (the regression gate)
cannot be honored by this factory today, and without it the loop is an expensive random
walk with a fleet-wide blast radius.

---

## 1. What the paper actually does

Self-Harness (Shanghai AI Lab, Jun 2026) lets a **fixed** model improve its own harness
(prompts, tools, runtime policies — declared editable surfaces) via a loop:

- **Weakness Mining** — run a fixed task suite, cluster failed execution traces by a
  deterministic failure signature φ(r) = (verifier cause, causal status, agent mechanism).
- **Harness Proposal** — the same model proposes K minimal, distinct edits, each tied to
  one failure mechanism, each with an audit record.
- **Proposal Validation** — re-run held-in AND held-out splits; accept only if neither
  regresses and one improves. Most proposals get rejected (3–4 accepted per 11–20 rounds).

Results: Terminal-Bench-2.0, 3 models, held-out pass +33–60 % relative. The gains are
real but **produced by the acceptance gate filtering a mostly-bad proposal stream**. The
paper's own limits: benchmark-bound, depends on verifier quality, higher-stakes edits
need stronger gates.

Context from the research sweep: no production deployment of Self-Harness or any sibling
is known; shipping products (Claude Code, Codex, OpenHands) all use human-engineered
harnesses. Two independent 2026 critiques attack the whole category:
arXiv 2607.12227 (harness evolution "does not consistently outperform simple test-time
scaling" and generalizes poorly) and arXiv 2605.30621 (reported gains may be artifacts of
extra search compute). Both IDs verified real.

## 2. Why the full loop does not fit this factory

Four hard blockers, each verified in the tree:

**(a) The verifier is degenerate — the loop would Goodhart it.**
Gates check shape, not substance: architecture gate = `[ -s PLAN.md ]`
(docker/sf-agent/gate.sh:33-35), green = `pytest rc==0`, review verdict is advisory
(REVIEW-01), and the agent authors its own tests in red/green. A dropped requirement
passes every gate (INTAKE-02). Under the paper's accept-if-pass-rate-improves rule,
edits that make the agent do **less** score **higher** — the loop would optimize the
product downward while the metric climbs. Un-mitigable without acceptance-criteria
grading (C4/INTAKE-02, ~8 days).

**(b) The task distribution has size 1.**
Every run mutates the single golden subject `sample/` (workspace.py:172, ARCH-03). A
held-in/held-out split over one subject guards nothing; the paper's generalization
guarantee is unhonorable here. Even the fix (3–4 subjects) gives |D_ho| ≈ 1–2.

**(c) One validation round is unaffordable and unmeasurable.**
K=3 proposals × 12 tasks × 3 repeats ≈ 144 full pipeline runs ≈ 40–70 h serialized
(one kind node, single uvicorn worker, ~17–25 min/run per REQ-2046 and kind-smoke.sh:9),
~700–900 agent invocations. There is zero token/cost accounting (COST-01), no registry
GC and no pod reaping (DEPLOY-01/02/03; 31 orphan pods after 15 h), and the sf-agent
image is rebuilt by hand (SPA-01) — no A/B plumbing exists.

**(d) Production evidence is tiny-N and non-stationary.**
Roughly a dozen real end-to-end requests exist EVER (REQ-2043/45/46/47 + seeds); the
paper's signal came from thousands of graded runs on a fixed suite. Worse, the pipeline
itself churned Plans A→B4 inside one week — failure signatures collected under last
week's harness are not valid evidence about this week's. The clustering statistics the
paper relies on have no power at this volume.

**Safety (independent of economics):** an automated proposer converts today's bounded
prompt-injection surface (gate feedback → one retry of one request, 2000-char cap,
kube_jobs.py:203) into a persistent fleet-wide one: hostile/careless feedback text →
miner → proposer → a prompt diff governing **all** future `danger-full-access` pods
(entrypoint.sh:84, SEC-02). `make verify` proves the machinery still runs, not that a
subtly weakened instruction is safe; human review of prose diffs is a weak control.
The judge must stay outside the loop (ADR 0001/0011/0024 boundary): **no learner may
ever touch gate.sh, the deterministic gates, or settings.py runtime knobs.**

## 3. A correction to the premise: feedback is NOT lost today

The framing "every time we give feedback it records" is ~90 % already true:

- Gate failure reasons persist in `StageJob.envelope` (models.py:384) and in the
  append-only `progress_event` log (`reason[:300]`, kube_runner.py:884; ADR 0008 —
  never deleted).
- Human send-back reasons persist as `recovery_action` events + AuditEvent
  (transitions.py:205-208); escalations likewise.
- Gate reasons are already auto-injected into the retry prompt (SF_GATE_FEEDBACK,
  entrypoint.sh:59-63).

What is actually missing:

1. **Typed structure** — verifier causes are free text; failing test node-ids are never
   recorded (gate.sh emits counts only).
2. **A structured human "no"** — merge/deploy gates are approve-only (gates.py:37-91);
   the approve endpoints accept an operator note and **discard it** (gates.py:37); human
   send-back reasons are recorded but never reach the agent's retry prompt.
3. **The agent execution trace** — discarded for every build stage (agent-output.txt in
   a deleted emptyDir; opencode's `--format json` output is thrown away). The paper's
   "agent mechanism" axis is unrecoverable today. (Persisting it requires a secret
   scrub first — SEC-04: real creds in every stage pod, unscrubbed logs_tail.)
4. **Harness lineage** — no `harness_version` on any run; prompts changed mid-window
   make any before/after count uninterpretable.
5. **Any read path** — `StageJob` (the richest forensic layer) is exposed by **no**
   router; it cannot be aggregated across requests.

Also a latent bug found on the way: the stage prompts exist in **two hand-synced
stores** — Python f-strings in agent_runner.py (236-346) and the baked markdown in
docker/sf-agent/prompts/*.md — already diverging in wording (steer-note injection is
in-process-only), with no parity guard. The whole production "harness surface" is four
markdown files totaling ~1.5 KB, edited exactly once in the repo's life.

## 4. What to build instead (the adapted slice)

Keep the paper's *framing* — feedback → structured evidence → bounded, audited harness
edits — but keep the human as proposer and validator. Roughly 1–2 weeks total, mostly
mechanical (gpt-5.5-suitable):

| # | Slice | Effort | Notes |
|---|-------|--------|-------|
| 1 | **Unify prompt stores**: make docker/sf-agent/prompts/*.md the single source; agent_runner.py reads the files; add `test_prompt_parity.py`. Reconcile the steer-note divergence deliberately. | S (1–2 d) | Standalone hygiene value; prerequisite for everything else. |
| 2 | **harness_version lineage**: content digest of prompt pack + policy knobs + image tag → SF_HARNESS_VERSION env → new StageJob column. Gate this behind #1 (else the hash misdescribes the in-process path). | S | No lineage ⇒ no attribution ⇒ no measurement, ever. |
| 3 | **Structured human reject**: `reject_gate` transition (modeled on send_back_to_stage, transitions.py:205/324) + endpoint at merge/deploy gates with a small fixed `reason_code` enum + free text; stop discarding approve-notes; inject the reason into SF_GATE_FEEDBACK so a human "no" trains the retry exactly like a gate "no" does. | M (2–3 d) | The only genuinely *new* recording capability; survives both skeptics. |
| 4 | **Harness pressure report**: read-only projection over existing StageJob + progress_event (+ new reject rows), GROUP BY (stage, cause bucket, harness_version), counts + sample reasons + which prompt file governs it. A SELECT + read-time classifier — a new table is optional and can wait for volume. | S–M (1–3 d) | The improvement loop: human reads report → edits a 400-byte prompt → ordinary reviewed PR → watch the report after the version bump; revert = git revert. |

Deliberately **not** built: LLM weakness-miner, K-proposal generator, auto-opened
harness PRs, any offline eval suite, any learner write-access to gates or settings. If
built later, record the decision as an ADR that explicitly forbids auto-apply.

## 5. Revisit triggers

Reconsider a (guarded) automated loop only when **all** of these exist:

- Acceptance-criteria grading (C4/INTAKE-02) — a non-degenerate verifier.
- ≥3 golden subjects (ARCH-03) and a replayable seeded suite with cluster reset + registry GC.
- Token/cost accounting (COST-01).
- ~10× today's real-request volume, so failure clusters reach n≥5 within a stable harness window.

Even then, prefer the guarded siblings over the vanilla loop: **GEPA** (DSPy, shipped,
35× more sample-efficient, prompt-only) for offline prompt optimization against a real
eval set; **ACE**-style incremental playbooks for durable context learning; **AHE**
(arXiv 2604.25850) discipline — pair every edit with a predicted outcome verified on the
next batch — if harness code ever becomes the target.

## 6. Where the assessments disagreed (adjudicated)

- The minimal "FailureSignature table" design was **rejected by its own skeptics** as
  premature capture: nearly every field already exists durably; the gap is a read path.
  Adopted their cheaper version (slice 4 reads existing rows; new table deferred).
- "Feedback is ephemeral" (used by two designs as motivation) was **refuted** with code
  evidence — reflected in section 3.
- The full-loop design's *verdict* (not-worth-it) was the only one both its skeptics
  upheld; its "build the substrate regardless" side-claim was trimmed to slices 1–2.
- The gpt-5.5/codex opinion independently landed on the same shape ("append-only failure
  ledger + human-curated harness PR loop, 6–10 person-days; never let the learner touch
  the deterministic gates"), which raises confidence in the recommendation.

## Sources

- Paper: https://arxiv.org/abs/2606.09498 (read in full, 19 pp).
- Category critiques (IDs verified): https://arxiv.org/abs/2607.12227,
  https://arxiv.org/abs/2605.30621.
- Siblings (IDs verified): Meta-Harness https://arxiv.org/abs/2603.28052,
  AHE https://arxiv.org/abs/2604.25850; GEPA arXiv 2507.19457 (DSPy);
  ACE arXiv 2510.04618; Reflexion arXiv 2303.11366.
- Press/commentary (agent-sourced, not independently verified): VentureBeat explainer;
  Lil'Log 2026-07-04 harness post; bdtechtalks 2026-07-13; antoinebuteau.com.
- Repo evidence: docs/reviews/factory-e2e-gap-analysis-2026-07-16.md (INTAKE-02,
  ARCH-03, COST-01, DEPLOY-01/02/03, SEC-02/04, SPA-01, REVIEW-01) + file:line cites inline.
- Full workflow transcripts: session scratchpad `wf/` (maps, 3 design packs with
  skeptic verdicts, related-work, codex opinion).
