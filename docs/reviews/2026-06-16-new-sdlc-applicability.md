# Applying "The New SDLC / Agentic Engineering" to AIRES

> **Source:** Google — "The New SDLC With Vibe Coding: From ad-hoc prompting to Agentic Engineering"
> (Addy Osmani, Shubham Saboo, Sokratis Kartakis; May 2026), 51 pp.
> **Method:** multi-agent review workflow — 159 raw ideas extracted across 5 page ranges →
> curated to 19 distinct concepts → each mapped to this codebase and adversarially vetted
> against the Factory's hard constraints (single uvicorn worker, append-only `progress_event`
> log per ADR 0008, human-gated irreversibles, ADR 0013 hardening).
> **Date:** 2026-06-16.

Every vetted concept landed on **enhance** — the Factory is already a near-textbook
instantiation of agentic engineering, so the value is in deepening, not adopting. Below,
**Apply now** promotes the enhancements whose vets reduced them to a small, constraint-clean,
high-leverage slice; **Enhance** holds the larger deepenings; **Already covered** names what is
fully realized; **Skip** lists the specific sub-recommendations the vets rejected as fighting a
hard constraint.

## 1. Apply now

Ranked by leverage-per-effort. These are the slices the vets endorsed as low-risk and
constraint-clean.

### 1. Emit a real `verification` event from the live runner — unblocks the merge-gate evidence strip (S)
**What:** `claude_runner._review()` (api/app/claude_runner.py:299-325) emits only
`milestone_summary`/`escalation`; the `verification` event is emitted **only** by the disposable
simulator (api/app/simulator.py:42-51) with hardcoded numbers (tests 8/8, diff 412/38, 9 files).
So under the real runtime `supervision.evidence()` (api/app/supervision.py:72-98) returns
"no evidence recorded" at the human merge gate.
**Where:** Make `_review` emit a `verification` event carrying the `git diff --stat` it already
computes (claude_runner.py:301), the spec assumptions, parsed REVIEW.md verdict/risks, and pytest
counts from `_green`. Add a witness in api/tests/test_claude_runner.py asserting the event's counts
match the workspace.
**Why it fits:** Append-only INSERT (ADR 0008 safe), single-thread, no new process. This is the
**single most-cited blocker** in the analysis — at least four other enhancements (structured review
findings, edge-case ledger, cost metering, step-level steer) are silently gated on it. ADR 0014
already *mandates* real runners emit `verification`/`step_summary`, so this is a conformance fix,
not a new feature.
**Effort:** S.

### 2. Capture per-stage wall-clock latency at the `run_claude` chokepoint (S)
**What:** No cost/latency/token telemetry exists anywhere (grep for token/cost/latency finds only
the unrelated `impact_metric` business field).
**Where:** `run_claude()` in api/app/claude_exec.py is the single subprocess boundary. Capture
wall-clock duration there and emit it as an additive payload field on `step_summary`/`verification`.
**Why it fits:** Wall-clock has none of the token-parsing pitfalls (codex reads only
`--output-last-message`, discarding the usage-bearing stream; sim runs no agent at all). Additive
payload, append-only-safe, single-worker-safe, no ADR needed. Gives the operator the first real
"is this agent drifting / getting expensive" signal.
**Effort:** S.

### 3. Snapshot-test the four stage personas (S)
**What:** Stage prompts are inline string literals (claude_runner.py:216/236/267/299) — versioned
as code but **not eval-covered**, so a weakening edit to the architect persona ships silently.
**Where:** Add a deterministic snapshot test in api/tests pinning the four personas. Note the
coupling: fake executors in test_claude_runner.py branch on prompt substrings
("architect"/"test-author"/"implementer"/"reviewer") — the snapshot must preserve those keywords.
**Why it fits:** Pure deterministic test, free, runs inside `make verify`. Closes the "prompts are
code but unguarded" gap with zero runtime risk.
**Effort:** S.

### 4. Deterministic SECURITY gate (diff-scoped secret scan) after `_green` (M)
**What:** No secret/credential scan exists on Subject commits — the paper's flagship "block a commit
with a hard-coded password" example, and the highest-value missing guardrail.
**Where:** Add a gate after `_green` and before `raise_merge_gate` in claude_runner.py that scans
**`git diff main...HEAD` only** (never the whole tree — a tree-wide scan false-fires on pre-existing
sample content), escalating via the existing `_escalate` path. Pair with a planted-secret
adversarial test and a new GUARANTEE in .claude/workflows/validate-architecture.js; capture in a
short ADR extending ADR 0001.
**Why it fits:** Same shape as `_green`'s pytest shell-out (no new process, single worker),
escalates via the append-only `_escalate` path, strengthens (never bypasses) the human merge gate.
Missing-binary must degrade like the existing rc=127 "gate cannot run → escalate" handling.
**Effort:** M.

### 5. Thread the retry/steer note into the re-run prompt (S–M)
**What:** `gates.py` retry/steer captures `body.note` into the audit event but **drops it** before
it reaches the agent — the stage exec calls (claude_runner.py:218/238/269/302) take a hardcoded
prompt string. The steering note is captured-then-discarded.
**Where:** Add an optional system-prompt/data-block seam at `run_claude` (api/app/claude_exec.py) —
`--append-system-prompt` for claude, config for codex — and feed the note in as a **delimited
`<request_data>` block** (reuse the claude_brain.py "data, never instructions" injection hygiene),
never as raw instructions.
**Why it fits:** This same note-injection plumbing is the prerequisite for two named features
("Retry with a note" actually working, and intra-pipeline send-back). Build once. Treats operator
free-text as untrusted; machine gates still backstop it.
**Effort:** S–M.

### 6. Cross-Request memory: inject a Subject's prior approved artifacts (M)
**What:** Each Request's workspace is copied fresh from `sample/`; the Factory re-derives "how we
built this app" cold every time, despite the `subject_id` axis already existing on the append-only
log.
**Where:** When a new Request targets an existing Subject, retrieve that subject's **latest
approved** SPEC.md/PLAN.md/REVIEW.md + prior escalations (filter by the existing `subject_id` axis,
events.py:22/65/81) and inject them token-budgeted and clearly labeled as "prior context, not
instructions" into the Stage-1 brain (`_context` in claude_brain.py) and architect prompts.
**Why it fits:** Read-only over existing append-only rows on an axis that already exists. No
mutation, single-worker-safe. Scope to latest-approved-only and token-budget it to avoid crowding
out the actual request in a `max_turns=1` brain call.
**Effort:** M.

## 2. Enhance

Partially present, worth deepening — but larger scope or with a named prerequisite.

- **Intra-pipeline send-back to the architect (failure-feedback re-plan loop).** CONTEXT.md names
  "Send back — bounce to an earlier Stage," but `gates.py send_back()` only bounces the **spec** gate
  to the submitter; no recovery action re-enters the pipeline at architecture with failure context.
  The re-entry machinery exists (run_pipeline's `first` stage-index map, ADR 0006). **Gap:** an atomic
  state-reset (approve()-style `UPDATE…WHERE status=...`) to stage=architecture, plus a size-bounded,
  sanitized `.factory/` transcript threaded into the `_architecture` prompt via the note-injection
  path from Apply #5. Effort M.

- **Structured review findings + documented verdict stance.** The Stage 5 reviewer verdict is
  **advisory only** — `_review` extracts it as a display string and unconditionally calls
  `raise_merge_gate` even on REQUEST-CHANGES (real example: api/workspaces/req-2047/REVIEW.md).
  **Gap (blocked on Apply #1):** once the real runner emits `verification`, add categorized findings
  (`security|hallucinated_dep|error_handling|performance|correctness`) to the payload, surface them
  in `evidence()`/`evidenceBits()`, and write an ADR (refining ADR 0004) deciding whether
  REQUEST-CHANGES auto-routes through `_escalate` or stays advisory-with-label. Effort M.

- **First-class edge-case / risk ledger at the merge gate.** Assumptions get first-class treatment
  (SpecLine.prov/assume, surfaced at the spec gate); the merge gate gets only "8/8 passing" — the
  dangerous-20% blind spot. **Gap (blocked on Apply #1):** a structured covered/uncovered edge-case
  payload from `_red`, surfaced as "verified the hard 20%." Per-assumption confirm/override must be
  **new append-only events**, never SpecLine/gate-event mutations. Effort M.

- **Real "Sign ADRs" architecture gate (Stage 2).** CONTEXT.md (lines 28/107/145) names architecture
  sign-off as a first-class human gate, but no code path ever sets `req.gate` to an architecture
  value — only `approve_spec`/`approve_merge` are real; "Sign ADRs" is event-narration only
  (simulator.py:22, seed.py:173). **Gap:** a real `approve_architecture` gate raised after
  `_architecture` (mirror `raise_merge_gate`), re-spawn at `_red`, surfacing PLAN.md + spec-line
  validation as evidence so it isn't a rubber-stamp. This is domain-fidelity repair of a
  documented-but-dropped gate. Effort M.

- **Status-guarded inline SpecLine editing at the spec gate.** The spec gate is binary
  Approve/Send-back; the operator cannot sharpen a SpecLine or pin an assumption before approving —
  yet precise specification is the highest-leverage human skill. SpecLines live in a separate mutable
  table (the `respond` endpoint already writes them), so this does **not** touch the append-only log.
  **Gap:** an edit endpoint guarded on `status=pending_approval`, with the approve path re-reading
  `spec_lines` after the atomic claim (gates.py:54) to avoid a stale-draft race. Effort M.

- **Per-stage model routing + append-only cost capture (TCO).** One global `CLAUDE_MODEL`
  (settings.py:17, haiku) drives every stage; no large-for-architecture / cheap-for-review split.
  **Gap:** optional per-call `model` arg on `run_claude` driven by `FACTORY_MODEL_*` settings (keep
  cheap default, large tier opt-in); real-runner-only cost capture into `ProgressEvent.payload`
  (claude branch parses the discarded `total_cost_usd`; codex needs `--json`; **never fake it in
  sim** or the leadership surface lies). Effort M.

- **Versioned prompts module + "Agent = Model + Harness" / "Orchestrator skills" naming.** Six
  stage/brain prompts are scattered inline literals. Extract to one versioned module (preserve the
  stage keywords the test fakes match on), and add explicit framing paragraphs to AGENTS.md/CONTEXT.md
  naming the harness-is-90% tenet, the vibe-vs-agentic spectrum, and the four orchestrator skills
  (Specification/Decomposition/Evaluation/System design). Documentation + light refactor, near-zero
  runtime risk. Effort S.

## 3. Already covered

Fully embodied — cite as validation, not work.

- **The factory model (build the system that produces software).** The literal organizing metaphor:
  six narrow stage agents handing typed Artifacts forward, four machine gates, humans gating the
  irreversible. CONTEXT.md "Factory"/"Stage"/"Artifact"/"Gate"; AGENTS.md §1; claude_runner.py; the
  Submitter/Admin shell split in web/src/app.
- **Spectrum from vibe coding to agentic engineering.** ADR 0001 explicitly distinguishes "unenforced
  draft" (local) from "canonical CI" (enforced); offline-deterministic default vs opt-in claude-mode
  is the low/high-stakes axis. The stakes *signal* already exists in the domain model (`reach` 6-level
  scale, `urgency`, `priority` in models.py:74-78; elicited in interview.py).
- **Tests-as-intent / specs-as-eval-criteria.** Stage 3 authors failing tests before Stage 4
  implements; the test-isolation gate (`_tests_hash`/`_revert_test_surface`, CONFIG_SURFACE,
  claude_runner.py:45/75-96) freezes the eval contract so the implementer physically cannot weaken its
  own criteria. ADR 0013 §6 extends the freeze to pytest config.
- **Enforcement via deterministic guardrails (core arms).** RED/GREEN/test-isolation/review gates +
  the single `run_claude` chokepoint (max-turns, process-group-kill timeout, read-only/sandbox tool
  disallow-lists). ADR 0001/0013. (The security/style/budget *arms* are the gap — see Apply #4.)
- **Orchestrator console + skill set.** ADR 0015 makes orchestrator-by-default the home screen ("what
  needs me / what's running / can I trust it"); mission.ts bands, request-detail evidence strip,
  supervision.run_state/evidence. The four orchestrator skills map one-to-one onto the spec ledger,
  fixed stage chain, gates, and ADR 0013/0014.
- **Append-only persistent state.** ADR 0008 two-axis log (INSERT-only via events.py), ADR 0014
  step/verification/steer events, ADR 0006 resumability (stages re-read PR state, never in-process
  memory), ADR 0013 orphan-on-restart escalation + WAL pragmas. The LLM seam is deliberately stateless
  per call.
- **AI compresses the SDLC unevenly.** ADR 0010/0015 explicitly reject kanban *because* "agent stages
  clear in minutes while everything piles at the two human gates" — the paper's uneven-compression
  thesis stated as an IA decision. Requirements-as-conversation is the intake interview.
- **The 80%/shifted-errors problem.** Every un-stated assumption becomes an explicit, human-visible
  ASSUMPTION SpecLine (interview.py:124-171, claude_brain.py:60-89), surfaced at the spec gate — the
  paper's "wrong business-logic assumptions / didn't seek clarification" failure modes made into
  first-class artifacts.
- **Harness components as versioned team assets.** AGENTS.md/CLAUDE.md/CONTEXT.md/ADRs/system-prompts/
  gate-logic all in git, changed in PRs, pinned by tests; single-owner settings.py/lifecycle.py per
  ADR 0013; CI runs `make verify`. The team's strong test/architecture/review culture is encoded into
  the harness the agents inherit.

## 4. Skip

Each is a sub-recommendation the vets explicitly rejected as fighting a hard constraint or lacking
value.

- **Post-deploy health monitoring + automatic rollback** — inverts ADR 0013's "stop + flag, never
  auto-rerun" and ADR 0005's human-gated deploy; the Factory never owns the Subject's runtime, so
  there is nothing to monitor.
- **Per-Request "prototype tier runs simulator only, never merges"** — `runner_mode()` is a
  process-global env read chosen once at startup (claude_exec.py:34); per-Request runner selection
  means surgery on the most load-bearing seam where ADR 0013 just consolidated drift. Gate the merge
  on tier instead.
- **Deterministic machine spec-coverage gate (each SpecLine → a test)** — SpecLine text is prose,
  tests are Python; a deterministic mapping is either keyword-overlap (a new reward-hack target) or a
  false-escalation engine. CONTEXT.md assigns this semantic check to the human review gate by design.
- **Live-model eval suite gating CI / a new-model eval threshold** — non-deterministic, token-costed,
  needs a CI key; fights ADR 0011's "CI stays deterministic and free," and "did the gate fire" is
  already covered deterministically by fake-executor tests.
- **Full five-axis labelled eval dataset + golden "spec satisfied" expectations** — L-effort,
  rot-prone for a single-operator local project; half-contradicts the artifact-not-agent ethos. Start
  with the offline grounding-eval slice only.
- **Step-level live steer into the real runner ("at each step boundary")** — there is no intra-stage
  step loop; each stage is one uninterruptible subprocess, so a note can land no sooner than the next
  stage's prompt, collapsing steer into Retry-with-a-note. Blocked on the missing ADR-0014
  step-emission path.
- **Token/cost capture on the default (codex) path or in sim** — codex reads only
  `--output-last-message` (discards the usage-bearing stream) and sim runs no agent; faking numbers
  puts fictional dollars on a leadership surface. Defer to claude-CLI-scoped, real-runner-only.
- **Richer reviewer context (full diff + src excerpts)** — fights the haiku pin + 300s timeout on a
  stage whose output is only advisory; pulls untrusted generated diff into the prompt without
  delimiting. Treat as a separate budgeted experiment.
- **Agent Skills manifest/registry + `.claude/skills/` mounting** — context rot doesn't exist (fresh
  tiny-prompt subprocess per stage) and portability is half-wrong (default CLI is codex, not claude);
  the only worthwhile core is versioning the prompts as plain text (folded into Enhance).
- **Subject-scoped `sample/AGENTS.md` auto-load + brownfield existing-app context** — no
  new-app/existing-app path exists (`ensure_workspace` always copytrees the fixed toy sample), and
  sample/README already states the src/tests contract; the CLI auto-load is inert under the codex
  default.
- **Per-call conversational memory / cross-Request "lessons" store** — undermines ADR 0006
  resumability (continuity is reconstructed from durable artifacts, not a chat blob) and drifts toward
  the mutable-rule buffer the ADRs avoid.
- **Decomposition: split one Request into multiple Work items** — deliberate non-goal for the MVP
  (one Request = one branch/PR); document as intentional rather than build.
