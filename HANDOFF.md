# Handoff — AI AIRES build

**Date:** 2026-06-05
**Owner:** the repo maintainers
**Next session focus:** Turn the validated research blueprint into a runnable, governed multi-agent SDLC pipeline scaffold in this directory (the repo root).

---

## 1. Goal

Build a "AIRES" — an autonomous-but-governed AI pipeline covering the full SDLC for an **engineering team/org**:

requirements → architecture → TDD implementation → code review/validation → deployment.

**Tooling decision (locked by the user):** center on **GitHub Copilot CLI** and/or **OpenCode** (open-source terminal coding agent) as the primary agent runtimes. Not Claude Agent SDK, not Cursor. Compare against others only where useful.

## 2. What's already been done

A deep-research pass (28 sources, 134 claims, 25 adversarially verified) is **complete**. Do **not** re-run it. Key outputs:

- **Full cited research dataset** (8 verified findings + refuted list + 28 sources):
  `<scratch path, since expired>`
  ⚠️ This is in OS temp and may be cleaned up — copy it into this repo (`research/findings.json`) early next session if you want it preserved.
- The synthesized **survey + reference blueprint** was delivered in the prior conversation turn (Part A landscape survey, Part B blueprint). The blueprint is summarized below so you don't need the transcript.

## 3. The blueprint to implement (from verified primitives only)

**Design principle:** every stage is a narrow agent that consumes a *validated artifact* and emits the next one; humans gate the three irreversible boundaries (architecture, merge, deploy); **the coder agent never has write access to its own test files** (anti-reward-hacking).

| # | Stage | Agent | Consumes → Emits | Scoped tools | Gate |
|---|-------|-------|------------------|--------------|------|
| 1 | Requirements | `requirements-analyst` | brief → `SPEC.md` | read, webfetch, MCP(Jira/Linear) | 👤 approve spec |
| 2 | Architecture | `architect` | `SPEC.md` → `PLAN.md` + `adr/*.md` | read-only | 👤 sign ADRs |
| 3 | Test authoring | `test-author` | `PLAN.md` → failing tests (RED) | edit **tests only** | CI: tests fail correctly |
| 4 | Implementation | `implementer` | tests → code (GREEN) | edit **src only**, bash | auto: tests pass |
| 5 | Review | `reviewer` | diff → review report | read-only | 👤 merge gate |
| 6 | Deploy | `release-manager` | main → release | bash, MCP(deploy) | 👤 approve prod |

**Three load-bearing rules:** (1) independent verification — review + test-authorship live outside the implementer; (2) bounded autonomy — cap agentic steps per stage, escalate instead of looping; (3) humans gate the irreversible.

### Verified implementation primitives (safe to rely on)
- **OpenCode**: built-in Plan/Build primaries + read-only Explore/Scout subagents. Custom agents via Markdown (`.opencode/agents/`) or `agent` key in `opencode.json`, each with model/prompt/temperature/steps/tools/permission. Permission system: **allow/ask/deny**, wildcard, **last-match-wins**. Org policy via `.well-known/opencode` (precedence remote < global < custom < project). → use this runtime for the strict test/src write-isolation gate.
- **Copilot CLI**: custom agents = `.agent.md` files in `.github/agents/` (project) or `~/.copilot/agents/` (user). Run non-interactively: `copilot --agent <name> --prompt "..."` — built for CI. Context isolation is **NOT a security sandbox**. → use this runtime for GitHub-native CI orchestration.
- **Orchestration:** start with a **shell script / GitHub Actions workflow** chaining stages, halting at human gates (PR approval / `workflow_dispatch`). Only adopt LangGraph/CrewAI/AutoGen if branching/retry/fan-out demands it — research found **no verified evidence** favoring any framework, so don't over-invest.

### Starter config snippets (verified syntax)
```jsonc
// opencode.json — test-author can't touch src; implementer can't touch tests
{
  "agent": {
    "test-author":  { "tools": { "edit": true }, "permission": { "edit": { "src/**": "deny", "tests/**": "allow" } } },
    "implementer":  { "tools": { "edit": true }, "permission": { "edit": { "tests/**": "deny", "src/**": "allow" } } },
    "reviewer":     { "model": "anthropic/claude-sonnet-4-5", "tools": { "write": false, "edit": false } }
  }
}
```

## 4. Caveats / what is NOT proven (don't present as fact)

The verifier **refuted or could not certify** (mostly verifier tooling abstentions, not disproof):
- The specific Spec Kit `SPEC.md/PLAN.md/TASKS.md` validation contract — *plausible, confirm against real Spec Kit before relying on it.*
- The arXiv TDD findings ("70% regression cut with graph context", "TDD Prompting Paradox") — directional only.
- Copilot SDK custom-agent field schema and the `/delegate` async-handoff command details.
- Copilot cloud coding-agent's real-time guardrail model (config-time allowlist vs per-call approval) — **genuinely ambiguous in docs; verify before giving it write tools.**
- Any "company X runs it this way" claim.

## 5. Suggested next steps (pick with user)

1. **Scaffold** — write `opencode.json`, `.github/agents/*.agent.md` for all 6 stages, the orchestration GitHub Actions workflow, and a sample `SPEC.md`/`PLAN.md` template into this repo. Highest value.
2. **Spike the riskiest assumption** — build just the Stage 3↔4 test-isolation gate and empirically prove an agent cannot edit/cheat its own tests under the OpenCode permission config.
3. **Pressure-test** the blueprint before building.
4. **Validate** the open questions in §4 against live OpenCode/Copilot CLI docs (use context7 MCP for current docs).

## Suggested skills for the next agent

- **`grill-me`** or **`grill-with-docs`** — stress-test the blueprint and resolve open design questions before scaffolding.
- **`to-prd`** then **`to-issues`** — convert this blueprint into a PRD and grabbable implementation issues if the user wants tracked execution.
- **`tdd`** — when implementing the Stage 3↔4 test-isolation spike (the factory is itself TDD-shaped).
- **`architecture`** (engineering plugin) — to capture the runtime choice (OpenCode vs Copilot CLI vs both) as an ADR.
- **context7 MCP** (`resolve-library-id` / `query-docs`) — fetch *current* OpenCode + Copilot CLI docs to re-confirm the §4 unverified items before relying on them. This field moves fast (Copilot CLI custom agents only shipped 2025-10-28).

## Environment notes

- This repo (`software-factory`) is currently **empty** — fresh start, no git yet. Offer to `git init`.
- User uses **uv** for Python package management (per global CLAUDE.md) if any Python tooling is built.
- Parent research was conducted from the unrelated `atlas-design-system` repo; ignore that context.
