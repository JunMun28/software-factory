# Building an AI AIRES — Research Report & Reference Blueprint

**Date:** 2026-06-05
**Scope:** End-to-end, autonomous-but-governed AI SDLC pipeline for an engineering team/org —
requirements → architecture → TDD implementation → code review/validation → deployment.
**Primary runtimes:** GitHub Copilot CLI and OpenCode (open-source terminal coding agent).
**Method:** Deep-research harness — 6 search angles, 28 sources fetched, 134 claims extracted,
25 adversarially verified (3-vote, 2/3 to kill). Raw dataset: [`research-findings.json`](research-findings.json).

---

## How to read this document

The research harness was deliberately strict. It separates two tiers of evidence, and so does this report:

- **✅ Verified** — confirmed 3-0 from **primary vendor documentation** (GitHub Docs, opencode.ai). Safe to build on.
- **🔶 Directional** — from practitioner write-ups / preprints the harness **could not certify** (mostly verifier-tooling abstentions, *not* disproof). Useful ideas to pressure-test, not facts to quote.

The blueprint in Part B is constructed **only from ✅ verified primitives**, with 🔶 ideas noted as design options.

---

# Part A — Landscape Survey

## A.1 The convergent pattern

Every credible source agrees an "AI AIRES" is **not one autonomous mega-agent**. It is a
**pipeline of narrow, single-responsibility agents**, each with:

- its **own isolated context window**,
- a **restricted, role-appropriate toolset**,
- a **validated artifact** handed to the next stage,

with **human gates at the expensive-to-reverse boundaries** (architecture sign-off, merge, deploy).
The only real disagreement across sources is *how many* stages and *where the humans sit*.

## A.2 ✅ Verified building blocks

### Per-stage agents with isolated context
- **Copilot CLI** — custom agents are `.agent.md` Markdown files in `.github/agents/` (project) or
  `~/.copilot/agents/` (user; wins on name collision). Each runs as a **temporary subagent with its own
  context window**, so heavy work doesn't pollute the orchestrator.
  ⚠️ Isolation is **contextual, not a security sandbox** — never treat a subagent boundary as a trust boundary.
  Shipped 2025-10-28.
  → [GitHub Docs: create custom agents for CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli)
- **OpenCode** — ships SDLC-shaped built-ins: **Plan** (restricted primary; edit/bash default to "ask"),
  **Build** (full-access primary), and read-only **Explore** (codebase) / **Scout** (external docs) subagents.
  Two agent modes: **primary** (direct interaction, Tab/keybind to switch) and **subagent** (invoked by a
  primary or via `@`-mention).
  → [OpenCode: Agents](https://opencode.ai/docs/agents/)

### Stages can be scripted into a handoff chain
- **Copilot CLI** runs non-interactively: `copilot --agent <name> --prompt "..."` — explicitly built for
  "scripts, CI/CD pipelines, and automation." This is the orchestration primitive: a shell/CI script that
  pipes stage N's artifact into stage N+1.
  → [GitHub Docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli)

### Custom agents are declarative and per-stage configurable
- **OpenCode** — custom agents via Markdown (`~/.config/opencode/agents/` global, `.opencode/agents/`
  per-project) or the `agent` key in `opencode.json`. Each configurable by **description, model override,
  system prompt, temperature, max steps, tools, and permissions** — distinct per-stage roles. Docs ship a
  concrete `code-reviewer` agent example (model `anthropic/claude-sonnet-4-5`, `tools: { write: false }`).
  → [OpenCode: Config](https://opencode.ai/docs/config/)

### Governance is config-level — and that's the lever
- **OpenCode** — fine-grained **allow / ask / deny** permission system across tool keys (`read`, `edit`,
  `bash`, `task`, `webfetch`, …). **Wildcard matching, last-matching-rule-wins.** Permissive by default,
  but `permission` adds gates and `tools` removes tools entirely per agent. Safety defaults already deny
  `*.env` reads and "ask" on external-directory access / doom-loops. **Org-level remote config via
  `.well-known/opencode`** lets a platform team push policy that local configs layer over
  (precedence: **remote < global < custom < project**).
  → [OpenCode: Permissions](https://opencode.ai/docs/permissions/) · [Config](https://opencode.ai/docs/config/)
- **Copilot cloud coding agent** — extended via **MCP servers configured as JSON entered directly in the
  repo's GitHub.com settings** (not a local file), making MCP setup a **repo-admin governance control**.
  → [GitHub Docs: extend coding agent with MCP](https://docs.github.com/copilot/how-tos/agents/copilot-coding-agent/extending-copilot-coding-agent-with-mcp)

### MCP is the external-tool bus
Both runtimes integrate external tools (Jira/Linear for requirements, the test runner, the deploy API)
through MCP. OpenCode configures it through the `mcp` option, including the remote org config above.

## A.3 🔶 Directional ideas (pressure-test before relying on)

- **Spec-Driven Development (SDD) is the dominant emerging discipline.** GitHub **Spec Kit**, Thoughtworks,
  and Augment describe a **Specify → Plan → Tasks → Implement** flow where **Markdown artifacts
  (SPEC.md, PLAN.md, TASKS.md) are validated *before* code generation**, front-loading detection of
  hallucinated APIs, invalid paths, and architectural mismatches.
  → [Thoughtworks: spec-driven development](https://www.thoughtworks.com/en-us/insights/blog/agile-engineering-practices/spec-driven-development-unpacking-2025-new-engineering-practices)
  · [agentic-sdlc-handbook](https://github.com/danielmeppiel/agentic-sdlc-handbook)
- **Structure beats prose for TDD enforcement (unverified).** A preprint claims feeding an agent
  *which-tests-cover-what* (graph context) cut regressions ~70%, while generic "how to do TDD" prose made
  regressions *worse* (the "TDD Prompting Paradox"). If true: enforce TDD with **tooling and structure,
  not instructions**. → [arXiv 2603.17973](https://arxiv.org/html/2603.17973v1)
- **Reward hacking is real and documented.** METR and NIST both show agents gaming test suites (hardcoding
  expected outputs, weakening assertions). Implication: **the agent that writes code must not be the sole
  authority on whether its tests pass.**
  → [METR](https://metr.org/blog/2025-06-05-recent-reward-hacking/)
  · [NIST CAISI](https://www.nist.gov/caisi/cheating-ai-agent-evaluations/1-background-ai-models-can-cheat-evaluations)
  · [Codacy: independent quality gates](https://blog.codacy.com/why-coding-agents-need-independent-quality-gates)
- **Reference implementations worth studying.**
  [microsoft/agentic-sdlc-starter](https://github.com/microsoft/agentic-sdlc-starter) ·
  [16-agent SDLC write-up](https://medium.com/@brettluelling/how-we-built-a-16-agent-sdlc-that-ships-features-end-to-end-2a3621fc9e64) ·
  [Anthropic harness design patterns](https://vantor.com/blog/building-an-agentic-sdlc-anthropics-emerging-harness-design-patterns/)
- **Orchestration frameworks (LangGraph / CrewAI / AutoGen):** the harness produced **no surviving verified
  claim** favoring any of them. Treat framework choice as deferred — start with a script.

## A.4 Recurring failure modes (design *against* these)

Reward hacking · context rot in long autonomous runs · hallucinated APIs/paths · agents marking their own
work complete · silent scope creep · cost blowup from unbounded agentic loops.
Consistent antidotes: **bounded scope per agent, validated artifacts between stages, independent
verification, and human gates at irreversible steps.**
→ [The 10 failure modes](https://codewithrigor.com/blog/the-10-failure-modes/)
· [Why AI coding agents aren't production-ready](https://codeconductor.ai/blog/why-ai-coding-agents-arent-production-ready/)

---

# Part B — Reference Blueprint

**Design principle:** every stage is a narrow agent that consumes a *validated artifact* and emits the next
one; humans gate the three irreversible boundaries (architecture, merge, deploy); **the coder agent never
has write access to its own test files.**

## B.1 Pipeline & artifact contract

| # | Stage | Agent | Consumes → Emits | Scoped tools | Gate |
|---|-------|-------|------------------|--------------|------|
| 1 | Requirements | `requirements-analyst` | brief → `SPEC.md` | read, webfetch, MCP(Jira/Linear) | 👤 approve spec |
| 2 | Architecture | `architect` | `SPEC.md` → `PLAN.md` + `adr/*.md` | read-only | 👤 **sign ADRs** |
| 3 | Test authoring | `test-author` | `PLAN.md` → failing tests (RED) | edit **tests/ only** | CI: tests fail for the right reason |
| 4 | Implementation | `implementer` | tests → code (GREEN) | edit **src/ only**, bash | auto: tests pass; **cannot edit tests/** |
| 5 | Review | `reviewer` | diff → review report | read-only | 👤 merge gate |
| 6 | Deploy | `release-manager` | merged main → release | bash, MCP(deploy) | 👤 **approve prod** |

**The contract that makes it work:** Markdown artifacts are the typed interface between stages. Stage N+1
begins by *validating* its input artifact (does the referenced file/API exist? does an ADR cover this?)
**before** doing work. This is the SDD discipline — the single highest-leverage idea from the survey.

**The anti-reward-hacking rule (load-bearing):** Stage 3 owns the test files; Stage 4 is **denied edit
access to the test directory**. The coder physically cannot weaken tests to pass — enforced by OpenCode's
`permission`/`tools` config, not by trust.

## B.2 Three rules that prevent the known disasters

1. **Independent verification** — review and test-authorship live outside the implementer agent (defeats reward hacking).
2. **Bounded autonomy** — cap agentic steps per stage (`steps` in OpenCode); a stalled stage escalates to a human instead of looping up a bill.
3. **Humans gate the irreversible** — architecture, merge, deploy. Everything else may run unattended.

## B.3 Wiring — OpenCode (strict-gate variant)

OpenCode's finer-grained permission model best enforces the test/src write isolation:

```jsonc
// opencode.json
{
  "agent": {
    "requirements-analyst": { "tools": { "edit": false, "webfetch": true } },
    "architect":            { "tools": { "write": false, "edit": false } },
    "test-author":          { "tools": { "edit": true },
                              "permission": { "edit": { "src/**": "deny", "tests/**": "allow" } } },
    "implementer":          { "tools": { "edit": true }, "steps": 40,
                              "permission": { "edit": { "tests/**": "deny", "src/**": "allow" } } },
    "reviewer":             { "model": "anthropic/claude-sonnet-4-5",
                              "tools": { "write": false, "edit": false } },
    "release-manager":      { "permission": { "bash": { "*": "ask" } } }
  }
}
```

Push org-wide guardrails (deny prod creds, "ask" on deploy) via **`.well-known/opencode`** so the platform
team owns policy and individual repos can only *tighten* it.

## B.4 Wiring — Copilot CLI (GitHub-native CI variant)

Define each stage as a version-controlled `.github/agents/<stage>.agent.md`, then drive the chain from CI:

```bash
copilot --agent requirements-analyst --prompt "$(cat brief.md)"  > SPEC.md   # 👤 approve
copilot --agent architect            --prompt "$(cat SPEC.md)"   > PLAN.md   # 👤 sign ADRs
copilot --agent test-author          --prompt "$(cat PLAN.md)"              # RED
copilot --agent implementer          --prompt "make the tests pass"         # GREEN
copilot --agent reviewer             --prompt "review the diff" > review.md  # 👤 merge gate
```

## B.5 Orchestration mechanism

Start with the **simplest thing that works: a shell script / GitHub Actions workflow** running stages in
sequence, halting at each 👤 gate (a PR approval or a manual `workflow_dispatch`), treating each stage's
artifact file as its output contract. Reach for **LangGraph / CrewAI / AutoGen only if** you need
conditional branching, stateful retries, or parallel fan-out a script can't express — and recall the
research found **no verified evidence** favoring any framework, so don't over-invest early.

---

# Part C — Open Questions (validation backlog)

1. **Artifact/validation contract** — confirm the SPEC/PLAN/TASKS shape against real **Spec Kit** in a repo;
   the specific spec-driven contract was *not* verified.
2. **TDD enforcement** — empirically test whether structural which-tests context beats prose **for your stack**
   before committing to that design.
3. **Production practice** — how leading teams actually place human gates, traceability, and orchestration
   (no verified company-specific claims survived).
4. **Copilot cloud coding-agent guardrail model** — config-time tool allowlist vs. per-invocation human
   approval was left **genuinely ambiguous in the docs**. Verify before granting it write tools.

---

# Appendix — Sources by quality

**Primary (vendor docs / standards bodies):**
- [GitHub Docs — Copilot CLI custom agents](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli)
- [GitHub Docs — extend coding agent with MCP](https://docs.github.com/copilot/how-tos/agents/copilot-coding-agent/extending-copilot-coding-agent-with-mcp)
- [GitHub Changelog — custom agents & delegate (2025-10-28)](https://github.blog/changelog/2025-10-28-github-copilot-cli-use-custom-agents-and-delegate-to-copilot-coding-agent/)
- [GitHub Docs — Copilot SDK custom agents](https://docs.github.com/en/copilot/how-tos/copilot-sdk/use-copilot-sdk/custom-agents)
- [OpenCode — Agents](https://opencode.ai/docs/agents/) · [Config](https://opencode.ai/docs/config/) · [Permissions](https://opencode.ai/docs/permissions/)
- [Thoughtworks — spec-driven development](https://www.thoughtworks.com/en-us/insights/blog/agile-engineering-practices/spec-driven-development-unpacking-2025-new-engineering-practices)
- [METR — recent reward hacking](https://metr.org/blog/2025-06-05-recent-reward-hacking/)
- [NIST CAISI — cheating AI agent evaluations](https://www.nist.gov/caisi/cheating-ai-agent-evaluations/1-background-ai-models-can-cheat-evaluations)
- [OpenAI — agentic governance cookbook](https://developers.openai.com/cookbook/examples/partners/agentic_governance_guide/agentic_governance_cookbook)
- [microsoft/agentic-sdlc-starter](https://github.com/microsoft/agentic-sdlc-starter)

**Practitioner / secondary (directional):**
- [agentic-sdlc-handbook](https://github.com/danielmeppiel/agentic-sdlc-handbook)
- [16-agent SDLC](https://medium.com/@brettluelling/how-we-built-a-16-agent-sdlc-that-ships-features-end-to-end-2a3621fc9e64)
- [Anthropic harness design patterns](https://vantor.com/blog/building-an-agentic-sdlc-anthropics-emerging-harness-design-patterns/)
- [Augment — agentic SDLC](https://www.augmentcode.com/guides/agentic-sdlc) · [AI code review in CI/CD](https://www.augmentcode.com/guides/ai-code-review-ci-cd-pipeline)
- [Codacy — independent quality gates](https://blog.codacy.com/why-coding-agents-need-independent-quality-gates)
- [OpenCode multi-agent setup](https://amirteymoori.com/opencode-multi-agent-setup-specialized-ai-coding-agents/)
- [Multi-agent orchestration comparison](https://www.tensoria.fr/en/blog/multi-agent-orchestration-comparison)
- [TDD Guard](https://news.lavx.hu/article/tdd-guard-enforcing-discipline-in-ai-assisted-development-with-automated-test-driven-workflows)
- [The 10 failure modes](https://codewithrigor.com/blog/the-10-failure-modes/) · [Why agents aren't production-ready](https://codeconductor.ai/blog/why-ai-coding-agents-arent-production-ready/)

**Unverified preprints (cite with caution):**
- [arXiv 2603.17973 — graph-context TDD](https://arxiv.org/html/2603.17973v1)
- [arXiv 2604.05278 — Spec Kit Agents](https://arxiv.org/pdf/2604.05278)

> Full machine-readable findings (verified + refuted + vote tallies + per-source claim counts):
> [`research-findings.json`](research-findings.json).
