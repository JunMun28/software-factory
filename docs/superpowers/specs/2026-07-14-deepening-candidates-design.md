# Deepening candidates 1–3 — design decisions

**Date:** 2026-07-14
**Source:** /improve-codebase-architecture review (report in session scratchpad) + grilling
(Q1–Q3 answered by owner; remainder delegated — "you decide everything").
**Prerequisite:** Plan A branch merges to local main first (owner-approved, Q1).

---

## Candidate 1 — Request lifecycle transitions module

**Decisions:**

- **D1 (owner, Q1):** Plan A merges first; this work is its own branch on top.
- **D2 (owner, Q2):** `apply()` owns CAS + audit row + `progress_event` append +
  loss-resolution in ONE transaction. Intent rows attach only via an optional
  `intent=` argument (transitions that imply an external side effect).
- **D3 (owner-delegated, Q3):** one table over the composite state
  `(status, stage, gate, needs_human)`; stage-advance is one parameterized
  transition; both runners and all routers go through `apply()`. Migration staged:
  routers → simulator → agent_runner, verify-green between stages.
- **D4:** the table + `apply()` live in **`api/app/transitions.py`** — the module
  Plan A created for `cas_status`; the primitive and its production callers belong
  together. `lifecycle.py` is absorbed and deleted (its 3 functions become table
  rows). `_resolve_cas_loss` and the 7 endpoint copies collapse into `apply()`'s
  `Loss(resolution)` path.
- **D5:** interface:
  `apply(db, req, transition: str, *, actor: Actor, params: dict = {}, intent: IntentSpec | None = None) -> Win | Loss`.
  Status/gate values become module constants next to the table (kills the ~90
  magic strings incrementally — call sites adopt constants as they migrate).
- **D6:** `supervision.classify(req) -> {phase, at_gate, in_flight, stalled}` ships
  in the same branch, derived from the same table (absorbs candidate 7);
  mission/inbox/detail read it.
- **D7:** tests: direct unit tests per transition row + the race pairs
  (cancel-vs-approve, retry-vs-escalate) at module level; existing HTTP tests stay
  as integration coverage, unchanged.
- **D8 (domain modeling):** add **Transition** to CONTEXT.md when the module lands:
  "a named, table-declared move of a Request's lifecycle state, applied atomically
  with its audit and event record; the only legal way to mutate lifecycle columns."

## Candidate 2 — kit split

- **D9:** `packages/shared/src/lib/kit.ts` splits in place: true primitives
  (Glyph, Icon, Avatar, Pill, and whatever else both apps import — verified by grep
  at implementation time) stay in shared under `lib/kit/`; the six console-only
  domain modals (ApproveModal, SendBackModal, RecoveryConfirm, SendBackStageModal,
  CancelConfirm, EvidenceStrip) move into the console app next to their only
  consumers (floor/dossier). `floor-action-outcome` moves to a console-shared
  location at the same time (fixes the cross-folder reach).
- **D10:** `public-api.ts` moves to per-symbol exports (no `export *`).
- **D11:** `EscalationBox` is deleted (deletion test passed: zero consumers).
- **D12:** `shared-gate.yml` unchanged — the win is the shrunken protected surface,
  not a weaker gate. No ADR needed: this aligns with ADR 0017's intent.

## Candidate 3 — GenerationStream

- **D13:** lives in **apps/intake** (`src/app/submitter/generation-stream.ts`) —
  NOT in @sf/shared: all four consumers are intake wizard steps, and putting it in
  shared would recreate the candidate-2 blast-radius problem.
- **D14:** shape: a plain class (not a component, not a global service),
  one instance per wizard step:
  `new GenerationStream<T>(readFn: () => Observable<T>, streamUrl: (id) => string, isThinking: (t: T) => boolean, destroyRef)`
  exposing signals `{ state, thinking, streaming }`; owns the 1500 ms poll loop,
  SSE-with-fallback, and teardown. The existing `streamState()` util is absorbed.
- **D15:** tests: pure unit tests with fake timers + a stubbed EventSource — no
  TestBed. The four components' own specs shrink to "wires the stream" assertions.

## Sequencing

1. Merge Plan A → local main (`task verify` already green ×2; push stays held).
2. Candidate 1 (backend, biggest) as branch `lifecycle-transitions`.
3. Candidates 2 and 3 (frontend, independent of 1 and of each other) as separate
   small branches, in either order or parallel.
4. Each branch: SDD execution (codex gpt-5.6-sol implementers, fable reviewers),
   `task verify` before its merge decision.

## Explicitly out of scope

Candidates 4 (Runner interface — falls naturally out of Plan B's KubeJobRunner),
5 (contract slimming — bundle with candidate 2's shared-gate touch or later),
6 (single-flight generator). Candidate 7 absorbed into D6.
