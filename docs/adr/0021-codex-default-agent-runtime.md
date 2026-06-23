# Codex CLI is the default agent runtime; the agent seam goes runtime-neutral

**Status:** accepted
**Amends:** ADR 0001 (Copilot-first) · ADR 0011 (Claude-Code runtime)

ADR 0011 wired **Claude Code** in as the first real runtime behind both seams,
because that is the CLI the team had. The team now drives both seams — the Stage 1
**intake brain** and the Stages 2–5 **runner** — with the **Codex CLI** instead, because
that is the CLI they are logged into today. Because enforcement lives at the
**orchestration/git layer** (ADR 0001/0011: "runtime-agnostic, checked against the
Artifact, not the agent's good behavior"), changing the CLI changes **no guarantee** —
the gates do not care which agent did the work.

Codex is a **bridge, not the destination.** ADR 0001's Copilot-first intent still
stands; the trajectory is **Claude Code (the detour) → Codex (now) → GitHub Copilot CLI
(later)**. The word **"for now"** is load-bearing here: this is a default we expect to
move, so we keep churn cheap and reversible.

## Decision

- **`FACTORY_CLI=codex` is the default**; `claude` is the optional alternate. The single
  chokepoint `agent_exec.py::run_agent` switches CLI per call, so nothing else in the app
  ever names a vendor.
- **The seam is runtime-neutral.** The mode value that turns on the real runtime is now
  `FACTORY_BRAIN=agent` / `FACTORY_RUNNER=agent` (was `claude` — which read as a lie next to
  `FACTORY_CLI=codex`). The chokepoint, its modules and symbols are `agent_*`
  (`agent_exec.py`, `agent_runner.py`, `agent_brain.py`, `run_agent`, `AgentRunner`,
  `AgentBrain`, `AgentResult`).
- **Genuinely Claude-specific names stay** — they are correct, not legacy: `FACTORY_CLI=claude`,
  `CLAUDE_BIN`, `FACTORY_CLAUDE_MODEL`, and the `_run_claude_cli` / `_claude_cmd` branch.

## Consequences

- **Honest attribution.** Milestone summaries label the worker `"Factory agent"`, never a
  vendor — the evidence trail can no longer claim Claude did work that Codex (or, later,
  Copilot) did. The live CLI stays observable at `GET /api/health` (`cli`).
- **Autonomy bound under codex is the wall clock.** `codex exec` has no turn cap, so the
  stage/brain **timeout** is its only bound; `--max-turns` applies only to the claude path.
  ADR 0011's "one turn" wording is corrected to match.
- **Model is operator-governed.** `FACTORY_CODEX_MODEL` is empty by default, so codex uses
  whatever the operator's CLI is configured for; set it to pin a reproducible run. (The
  claude path still pins `claude-haiku-4-5`.) Two operators can therefore get different
  cost/quality from "the same Factory" unless they pin — accepted for a "for now" default.
- **No-edits parity holds.** Codex enforces the read-only contract with its OS sandbox
  (`read-only` vs `workspace-write`); claude uses a tool disallow list. Either way the
  artifact/git gates re-check the result, so the enforcement layer is unchanged.
- **Determinism is preserved.** `make verify` and CI stay on `sim` / `scripted` — no CLI,
  no tokens — so flipping the default costs nothing on the deterministic path.
- **Copilot is the next step, not now (YAGNI).** `run_agent` is a binary fork today
  (`claude` vs else → codex); the explicit `copilot` branch lands when Copilot is actually
  wired, as a localized change at the one chokepoint. A consequence to accept meanwhile: an
  unknown `FACTORY_CLI` value silently runs codex rather than failing loud.
- **Operational.** Running the real factory needs the chosen CLI logged in on the host
  (codex auth); the compose stack / `api/Dockerfile` carry those credentials. CI is
  unaffected because it never leaves `sim`.
