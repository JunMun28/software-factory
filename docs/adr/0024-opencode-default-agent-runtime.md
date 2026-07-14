# opencode is the default agent runtime

**Status:** accepted
**Amends:** ADR 0011 (Claude-Code runtime) · ADR 0021 (Codex default runtime)

ADR 0021 made **Codex** the default CLI behind the two agent seams (the Stage 1
**intake brain** and the Stages 2–5 **runner**), with the word **"for now"** called out
as load-bearing. This ADR moves that default to the **opencode CLI**. As ADR 0021
established, enforcement lives at the **orchestration/git layer** — the gates check the
Artifact, not which agent produced it — so changing the CLI changes **no guarantee**.

opencode joins as a third branch at the single chokepoint; codex and claude stay as
optional alternates. The trajectory and its reversibility are unchanged — this is still a
default we expect to keep cheap to move.

## Decision

- **`FACTORY_CLI=opencode` is the default**; `codex` and `claude` are the optional
  alternates. The one chokepoint `agent_exec.py::run_agent` switches CLI per call, so
  nothing else in the app names a vendor. An unknown `FACTORY_CLI` value now falls through
  to opencode (was codex).
- **Headless invocation:** `opencode run --format json --dir <workspace> -m <provider/model>`.
  `--format json` yields an NDJSON event stream; the final message is the concatenation of
  its `text` parts. `--dir` is **mandatory** — headless opencode resolves its project from
  `--dir`, not the subprocess cwd, so without it a stage agent reads the wrong tree.
- **No-edits parity is a hard, operator-independent guarantee.** opencode's read-only vs
  write contract is enforced by a **factory-owned config** pointed at with `OPENCODE_CONFIG`
  (`api/app/opencode/factory-readonly.json` denies edit/bash/webfetch; `factory-write.json`
  allows edit/bash, denies webfetch — FS + shell, no network, matching codex `workspace-write`).
  The operator's own opencode agents are deliberately bypassed: they may be configured
  allow-all and cannot be trusted as the sandbox.
- **Single-turn autonomy directive.** The opencode adapter appends a short "you are headless,
  act in one turn, never ask for confirmation" instruction to the prompt — the counterpart to
  claude's `--safe-mode`. Without it the model can answer a stage with a plan and wait for an
  approval that a single-shot `run` never delivers. The shared stage prompts stay CLI-neutral.

## Consequences

- **Autonomy bound is the wall clock.** Like `codex exec`, `opencode run` has no turn cap, so
  the stage/brain **timeout** is its only bound; `--max-turns` still applies only to claude.
- **Model is operator-governed but pinned by default.** `FACTORY_OPENCODE_MODEL` defaults to
  `openai/gpt-5.5` (opencode ids are `provider/model`); override to pin a different provider.
  A foreign (claude/codex) model id handed in by a brain step — which has no `provider/` — is
  ignored in favor of the opencode default rather than passed to a CLI that can't resolve it.
- **Determinism is preserved.** `make verify` and CI stay on `sim` / `scripted` — no CLI, no
  tokens — so flipping the default costs nothing on the deterministic path.
- **Honest attribution unchanged.** Milestone summaries still label the worker `"Factory agent"`,
  never a vendor; the live CLI stays observable at `GET /api/health` (`cli`).
- **Operational.** Running the real factory needs opencode logged in on the host (an
  authed provider, e.g. OpenAI) plus the CLI in the image; `api/Dockerfile` carries it. CI is
  unaffected because it never leaves `sim`.
- **Proven end-to-end.** A full pipeline run (architecture → RED → GREEN + test-isolation →
  review → human merge) drove the sample subject to a green merge on `main` with opencode as
  the live runner, every gate machine-checked.
