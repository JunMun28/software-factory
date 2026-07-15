# Implementation notes — opencode as default agent runtime

Task: add **opencode** as a third `FACTORY_CLI` (alongside codex/claude), make it the
**default**, and prove it with a real full-pipeline end-to-end run.

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

### Deviations

- `apply()` guards parameter-dependent effect construction so a consumed precondition
  resolves as `Loss`, while an eligible call with missing parameters still raises.
- `apply()` flushes staged sibling writes before its CAS, preserving them across the
  winner refresh while `Loss` still rolls the transaction back.
- Simulator merge-gate notification now fires through `Win.notify()` after commit;
  recipients and exactly-once behavior are unchanged, and rolled-back gates are not announced.
- Task 7 was subsequently committed by the coordinator as `9eeb068`.
