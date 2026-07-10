import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/wongjunmun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.js");
const sharp = require("/Users/wongjunmun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/sharp@0.34.5/node_modules/sharp/lib/index.js");
const { Presentation, PresentationFile } = await import(pathToFileURL("/Users/wongjunmun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/@oai+artifact-tool@file+local-deps+-oai-artifact-tool-oai-artifact_tool-2.8.11.tgz/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs").href);

const ROOT = "/Users/wongjunmun/development/ai-development/software-factory";
const BUILD = path.join(ROOT, "outputs/new-sdlc-deck-build");
const SLIDES_DIR = path.join(ROOT, "outputs/new-sdlc-agentic-engineering-software-factory-slides");
const PPTX_PATH = path.join(ROOT, "outputs/new-sdlc-agentic-engineering-software-factory.pptx");
const HTML_PATH = path.join(BUILD, "new-sdlc-agentic-engineering-deck.html");
const QA_DIR = path.join(BUILD, "qa");
const NOTES_PATH = path.join(BUILD, "source-notes.md");

const slides = [
  {
    kicker: "Document briefing",
    title: "The New SDLC With Vibe Coding",
    subtitle: "From ad-hoc prompting to agentic engineering",
    source: "Source document: Addy Osmani, Shubham Saboo, Sokratis Kartakis, May 2026",
    layout: "cover",
    body: `
      <div class="cover-map">
        <div class="lane active">Intent</div>
        <div class="lane">Context</div>
        <div class="lane">Agents</div>
        <div class="lane">Tests</div>
        <div class="lane">Evals</div>
        <div class="lane">Gates</div>
      </div>
      <div class="cover-callout">
        <span>Deck goal</span>
        Explain the paper deeply, then map it onto this repo's Software Factory vision.
      </div>
    `,
  },
  {
    kicker: "Executive thesis",
    title: "The center of gravity moved from syntax to intent",
    subtitle: "AI now writes large chunks of code. The scarce work is specifying direction, feeding context, verifying behavior, and deciding what is safe to ship.",
    layout: "twoColumn",
    left: `
      <h3>What changes</h3>
      <ul>
        <li>Developers express goals, constraints, examples, and acceptance bars.</li>
        <li>Agents translate that intent into code, tests, diffs, plans, and reviews.</li>
        <li>Teams build reusable harnesses instead of treating every prompt as a one-off.</li>
      </ul>
    `,
    right: `
      <h3>What does not disappear</h3>
      <ul>
        <li>Requirements and architecture still need human judgment.</li>
        <li>Verification becomes more important, not less.</li>
        <li>Engineering culture is amplified: strong teams scale, weak habits scale too.</li>
      </ul>
    `,
  },
  {
    kicker: "Why now",
    title: "Adoption crossed from novelty into daily workflow",
    subtitle: "The paper frames early 2026 as the moment AI coding agents became normal enough that the SDLC itself had to be rethought.",
    layout: "metrics",
    metrics: [
      ["85%", "professional developers regularly using AI coding agents"],
      ["51%", "using them daily"],
      ["41%", "new code estimated as AI generated"],
    ],
    note: "The raw numbers are less important than the implication: generation is no longer the bottleneck.",
  },
  {
    kicker: "AI agent refresher",
    title: "An agent is a loop, not just a chat box",
    subtitle: "The document breaks agents into a model, tools, memory, orchestration, and deployment context.",
    layout: "loop",
    nodes: [
      ["Model", "reasoning and generation"],
      ["Tools", "read files, run tests, search, call APIs"],
      ["Memory", "persistent preferences and project facts"],
      ["Orchestration", "planning, retries, routing, delegation"],
      ["Deployment", "where the agent runs and what it can touch"],
    ],
  },
  {
    kicker: "Terminology",
    title: "Vibe coding is one point on a maturity spectrum",
    subtitle: "The paper's key distinction is not whether AI is used. It is how much structure and verification surrounds it.",
    layout: "spectrum",
    columns: [
      ["Vibe coding", "Loose intent", "Manual eyeballing", "Prototype scope", "High hidden risk"],
      ["Structured AI-assisted", "Explicit tasks", "Tests and review", "Team workflow", "Moderate risk"],
      ["Agentic engineering", "Specs as inputs", "Tests plus evals", "Production scope", "Managed risk"],
    ],
  },
  {
    kicker: "The dividing line",
    title: "Verification is what separates agentic engineering from vibes",
    subtitle: "The paper is blunt here: without tests for deterministic behavior and evals for nondeterministic behavior, the process is still vibe coding.",
    layout: "verification",
    left: `
      <h3>Tests</h3>
      <p>Best for deterministic code paths: APIs, data transforms, business rules, permissions, migrations, contracts.</p>
      <div class="pill-row"><span>unit</span><span>integration</span><span>smoke</span><span>regression</span></div>
    `,
    right: `
      <h3>Evals</h3>
      <p>Best for agent behavior: plan quality, tool choice, trajectory, response quality, refusal behavior, edge-case handling.</p>
      <div class="pill-row"><span>rubrics</span><span>goldens</span><span>trajectories</span><span>review sets</span></div>
    `,
  },
  {
    kicker: "Context engineering",
    title: "Prompting matters, but context architecture matters more",
    subtitle: "The paper argues that output quality depends heavily on what the agent knows, when it knows it, and how stale or overloaded that context becomes.",
    layout: "contextWheel",
    segments: [
      ["Instructions", "rules and role"],
      ["Knowledge", "docs and references"],
      ["Memory", "durable facts"],
      ["Examples", "few-shot patterns"],
      ["Tools", "actions and APIs"],
      ["Guardrails", "bounds and policy"],
    ],
  },
  {
    kicker: "Static vs dynamic context",
    title: "The context boundary becomes an architecture decision",
    subtitle: "Teams must decide what stays always-on, what is retrieved on demand, and what should be packaged as reusable procedural knowledge.",
    layout: "staticDynamic",
    left: `
      <h3>Static context</h3>
      <ul>
        <li>AGENTS.md, CLAUDE.md, GEMINI.md</li>
        <li>System instructions and team norms</li>
        <li>Long-lived persona and safety defaults</li>
      </ul>
    `,
    middle: `
      <h3>Dynamic context</h3>
      <ul>
        <li>Tool results and command output</li>
        <li>Retrieved docs and current source files</li>
        <li>Windowed conversation history</li>
      </ul>
    `,
    right: `
      <h3>Agent Skills</h3>
      <ul>
        <li>Portable procedures</li>
        <li>Progressive disclosure</li>
        <li>Less context rot across agents</li>
      </ul>
    `,
  },
  {
    kicker: "New SDLC shape",
    title: "Implementation compresses unevenly; judgment-heavy phases do not",
    subtitle: "AI speeds coding more than it speeds deciding. That changes the rhythm of the lifecycle.",
    layout: "sdlc",
    phases: [
      ["Requirements", "human-paced"],
      ["Architecture", "human tradeoffs"],
      ["Implementation", "compressed"],
      ["Testing and evals", "expanded"],
      ["Review and deploy", "gated"],
      ["Maintenance", "continuous"],
    ],
  },
  {
    kicker: "Requirements and architecture",
    title: "The front of the SDLC becomes a conversation with constraints",
    subtitle: "AI can elicit edge cases, draft user stories, propose schemas, and prototype flows. Humans still own the tradeoffs.",
    layout: "splitProcess",
    leftTitle: "Requirements with AI",
    leftItems: ["Interview users and stakeholders", "Generate stories and edge cases", "Draft acceptance criteria", "Prototype early UX and data flows"],
    rightTitle: "Architecture with AI",
    rightItems: ["Explore options and consequences", "Document decisions before code", "Turn patterns into repeatable rules", "Keep nonfunctional requirements explicit"],
  },
  {
    kicker: "Implementation",
    title: "Agents can make broad changes, but verification drag is real",
    subtitle: "The document cites productivity gains in some studies while also highlighting cases where experienced developers slowed down because review, debugging, and validation expanded.",
    layout: "tradeoff",
    gains: ["Multi-file edits", "Boilerplate removal", "Migration assistance", "Fast first drafts"],
    drags: ["Debugging generated code", "Reviewing unfamiliar diffs", "Integration edge cases", "Trust calibration"],
  },
  {
    kicker: "Testing and QA",
    title: "Quality becomes a flywheel, not a final phase",
    subtitle: "The paper's QA model combines output evaluation with trajectory evaluation, then feeds fixes back into prompts, tools, tests, and monitoring.",
    layout: "flywheel",
    steps: [
      ["Benchmark", "define success cases"],
      ["Diagnose", "cluster failures"],
      ["Optimize", "adjust prompt/tools/harness"],
      ["Regress", "lock in fixed cases"],
      ["Monitor", "watch production behavior"],
    ],
  },
  {
    kicker: "Review, deploy, maintenance",
    title: "Later SDLC phases get AI help, but not blind autonomy",
    subtitle: "AI reviewers can catch patterns and explain diffs; deployment needs AI-aware observability; maintenance benefits from codebase navigation and refactor support.",
    layout: "threeCards",
    cards: [
      ["Review", "First-pass critique, policy checks, test gap discovery, risk summaries for humans."],
      ["Deploy", "Feature flags, rollout checks, runtime telemetry, rollback triggers, release notes."],
      ["Maintain", "Legacy explanation, migration plans, dependency upgrades, test modernization."],
    ],
  },
  {
    kicker: "Factory model",
    title: "The developer output shifts from code to a code-producing system",
    subtitle: "The paper's factory metaphor is practical: specs, context, agents, tests, gates, and feedback loops form the assembly line.",
    layout: "factoryFlow",
    stages: [
      ["Spec and context", "intent, constraints, examples"],
      ["Agent harness", "model, tools, sandbox"],
      ["Code and tests", "diffs, assertions, docs"],
      ["Gates", "evals, review, security"],
      ["Feedback", "logs, failures, improvements"],
    ],
  },
  {
    kicker: "Harness engineering",
    title: "Agent = model plus harness",
    subtitle: "The paper warns that many failures are harness failures: missing context, weak tools, bad sandboxing, no observability, or unclear permissions.",
    layout: "harness",
    core: "Model",
    rings: [
      ["Instructions", "task frame and policy"],
      ["Tools", "repo, shell, browser, APIs"],
      ["Sandbox", "permissions and isolation"],
      ["Orchestration", "routing, retries, delegation"],
      ["Guardrails", "hooks, budgets, escalation"],
      ["Observability", "logs, traces, eval results"],
    ],
  },
  {
    kicker: "Harness across the lifecycle",
    title: "Each SDLC phase configures or observes the harness",
    subtitle: "This reframes engineering work: you do not just ask the agent to code; you prepare the system that makes useful code likely.",
    layout: "matrix",
    rows: [
      ["Requirements", "clarify intent", "schemas, examples, acceptance criteria"],
      ["Planning", "decompose work", "milestones, dependencies, risk list"],
      ["Implementation", "run agent safely", "tools, sandbox, edit permissions"],
      ["Testing", "close feedback loop", "tests, evals, failure clusters"],
      ["Review", "make judgment visible", "summaries, diffs, policy checks"],
      ["Deploy", "watch the system", "observability, rollbacks, incidents"],
    ],
  },
  {
    kicker: "Role shift",
    title: "Developers move between conductor and orchestrator modes",
    subtitle: "The paper names two common postures: hands-on pairing in the IDE and async delegation to background agents.",
    layout: "roles",
    left: `
      <h3>Conductor</h3>
      <p>Works in real time with an IDE or terminal agent.</p>
      <ul><li>steers line by line</li><li>checks assumptions quickly</li><li>keeps local context tight</li></ul>
    `,
    right: `
      <h3>Orchestrator</h3>
      <p>Splits work across async agents and reviews outputs.</p>
      <ul><li>writes crisp specs</li><li>decomposes tasks</li><li>evaluates and merges safely</li></ul>
    `,
    footerNote: "The last 20 percent is where integration, taste, and domain judgment show up.",
  },
  {
    kicker: "Agent landscape",
    title: "The paper separates agents by where they operate",
    subtitle: "This helps teams choose the right tool rather than treating every AI coding product as equivalent.",
    layout: "landscape",
    lanes: [
      ["Editor agents", "Copilot, Cursor, Windsurf, JetBrains AI", "inline edits and pair programming"],
      ["Terminal agents", "Codex CLI, Claude Code, Cline, Open Code", "repo-scale tasks and shell workflows"],
      ["Background agents", "Jules, Copilot agent mode, Cursor background", "async delegation and PR creation"],
      ["Production agents", "agent as shipped product", "memory, permissions, evals, observability"],
    ],
  },
  {
    kicker: "Economics",
    title: "Vibes look cheap until operations and maintenance arrive",
    subtitle: "The document frames context engineering as a financial lever: upfront structure can lower marginal cost, token waste, and remediation later.",
    layout: "economics",
    leftTitle: "Vibe coding",
    leftItems: ["Low setup cost", "Fast demos", "High token burn over time", "Maintenance and security tax"],
    rightTitle: "Agentic engineering",
    rightItems: ["Higher upfront CapEx", "Reusable specs and skills", "Lower marginal change cost", "Better routing and governance"],
  },
  {
    kicker: "Adoption playbook",
    title: "Start by making one workflow repeatable and measurable",
    subtitle: "The paper's advice is deliberately practical: build context as code, set an eval bar, and distinguish prototypes from production.",
    layout: "playbook",
    columns: [
      ["Individuals", "Create AGENTS.md; write skills; pick one repetitive workflow; add tests before agent code; review every shipping line."],
      ["Leaders", "Treat context as code; reward eval quality; reshape review; fund harness assets; separate demo speed from production readiness."],
      ["Organizations", "Invest in substrate; adopt interop protocols; build hybrid teams; hire for judgment, decomposition, and evaluation."],
    ],
  },
  {
    kicker: "Risks to manage",
    title: "The new SDLC fails when generation outruns control",
    subtitle: "The paper's warnings are not anti-AI. They are anti-unbounded-autonomy.",
    layout: "riskGrid",
    risks: [
      ["Context rot", "old rules and stale examples pollute outputs"],
      ["Test theater", "tests exist but do not prove the risk"],
      ["Silent tool failure", "agent proceeds after a bad command or bad retrieval"],
      ["Permission drift", "write/deploy powers expand without review"],
      ["Review overload", "humans rubber-stamp massive unfamiliar diffs"],
      ["Cost opacity", "token spend and retries hide in the background"],
    ],
  },
  {
    kicker: "Mapping to this project",
    title: "Software Factory already embodies the paper's agentic direction",
    subtitle: "This repo is not just a demo app. It is a governed AI SDLC pipeline with explicit seams, artifacts, gates, and human approval boundaries.",
    layout: "repoMap",
    rows: [
      ["Requirements", "intake brain seam", "FACTORY_BRAIN=claude or ScriptedBrain"],
      ["Architecture", "stage output", "plans and decisions before build"],
      ["Implementation", "runner seam", "FACTORY_RUNNER=claude or simulator"],
      ["Verification", "machine gates", "RED, GREEN plus isolation, review file"],
      ["Deployment", "human merge gate", "POST approve before irreversible merge"],
      ["Observability", "progress_event", "append-only two-axis event log"],
    ],
  },
  {
    kicker: "Software Factory technical fit",
    title: "The project turns the paper's ideas into operating controls",
    subtitle: "The strongest alignment is not the UI. It is the governance model: deterministic fallback, bounded runner execution, test isolation, and explicit escalation.",
    layout: "controls",
    controls: [
      ["Brain seam", "scripted offline by default; real model behind env var"],
      ["Runner seam", "simulator by default; real Codex/Claude execution when enabled"],
      ["Subprocess boundary", "timeouts, max turns, sandboxed edit permissions"],
      ["Machine gates", "RED must fail correctly; GREEN must pass without test weakening"],
      ["Human gate", "merge only after explicit approval"],
      ["Mission control", "operator view for requests, gates, events, and interventions"],
    ],
  },
  {
    kicker: "Overall vision",
    title: "A governed operating system for AI software delivery",
    subtitle: "The paper says generation is no longer enough. Software Factory's vision is to make direction, verification, and supervision first-class product surfaces.",
    layout: "vision",
    vision: [
      ["For builders", "turn a request into a supervised SDLC run"],
      ["For teams", "standardize context, gates, and review expectations"],
      ["For leaders", "see work health, risk, cost, and human approval points"],
      ["For the platform", "swap brains and runners without changing the domain model"],
    ],
    projectPath: "/Users/wongjunmun/development/ai-development/software-factory",
    commands: ["make verify", "FACTORY_RUNNER=claude uv run uvicorn app.main:app --port 8000"],
  },
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function list(items) {
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function bodyHtml(s) {
  switch (s.layout) {
    case "cover":
      return s.body;
    case "twoColumn":
      return `<div class="two"><section>${s.left}</section><section>${s.right}</section></div>`;
    case "metrics":
      return `<div class="metrics">${s.metrics.map(([n, t]) => `<div><strong>${n}</strong><span>${escapeHtml(t)}</span></div>`).join("")}</div><p class="large-note">${escapeHtml(s.note)}</p>`;
    case "loop":
      return `<div class="agent-loop">${s.nodes.map(([name, text], i) => `<div class="loop-node n${i + 1}"><b>${escapeHtml(name)}</b><span>${escapeHtml(text)}</span></div>`).join("")}<div class="loop-center">observe<br/>plan<br/>act<br/>verify</div></div>`;
    case "spectrum":
      return `<div class="spectrum">${s.columns.map((col, i) => `<section class="maturity m${i}"><h3>${escapeHtml(col[0])}</h3>${col.slice(1).map((x) => `<p>${escapeHtml(x)}</p>`).join("")}</section>`).join("")}</div>`;
    case "verification":
      return `<div class="verify-line"><section>${s.left}</section><div class="divider">+</div><section>${s.right}</section></div><div class="bottom-rule">Agentic engineering begins when both sides are explicit and repeatable.</div>`;
    case "contextWheel":
      return `<div class="context-grid">${s.segments.map(([name, text]) => `<section><b>${escapeHtml(name)}</b><span>${escapeHtml(text)}</span></section>`).join("")}</div><div class="context-core">Context<br/>engineering</div>`;
    case "staticDynamic":
      return `<div class="three">${["left", "middle", "right"].map((k) => `<section>${s[k]}</section>`).join("")}</div>`;
    case "sdlc":
      return `<div class="sdlc">${s.phases.map(([phase, text], i) => `<div class="phase p${i}"><b>${escapeHtml(phase)}</b><span>${escapeHtml(text)}</span></div>`).join("")}</div><div class="compression">Implementation narrows; verification and supervision widen.</div>`;
    case "splitProcess":
      return `<div class="two process"><section><h3>${escapeHtml(s.leftTitle)}</h3>${list(s.leftItems)}</section><section><h3>${escapeHtml(s.rightTitle)}</h3>${list(s.rightItems)}</section></div>`;
    case "tradeoff":
      return `<div class="trade"><section><h3>Where agents help</h3>${list(s.gains)}</section><section><h3>Where drag appears</h3>${list(s.drags)}</section></div><div class="equation">Net productivity = generation speed - verification/rework cost</div>`;
    case "flywheel":
      return `<div class="flywheel">${s.steps.map(([name, text], i) => `<div class="fly f${i}"><b>${escapeHtml(name)}</b><span>${escapeHtml(text)}</span></div>`).join("")}<div class="fly-center">quality<br/>loop</div></div>`;
    case "threeCards":
      return `<div class="cards3">${s.cards.map(([title, text]) => `<section><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></section>`).join("")}</div>`;
    case "factoryFlow":
      return `<div class="flow">${s.stages.map(([title, text], i) => `<section><span>0${i + 1}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></section>`).join("")}</div>`;
    case "harness":
      return `<div class="harness"><div class="harness-core">${escapeHtml(s.core)}</div>${s.rings.map(([title, text], i) => `<section class="hr h${i}"><b>${escapeHtml(title)}</b><span>${escapeHtml(text)}</span></section>`).join("")}</div>`;
    case "matrix":
      return `<table class="matrix"><thead><tr><th>Phase</th><th>Harness role</th><th>Typical assets</th></tr></thead><tbody>${s.rows.map((r) => `<tr>${r.map((x) => `<td>${escapeHtml(x)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    case "roles":
      return `<div class="two roles"><section>${s.left}</section><section>${s.right}</section></div><div class="bottom-rule">${escapeHtml(s.footerNote)}</div>`;
    case "landscape":
      return `<div class="landscape">${s.lanes.map(([title, examples, work]) => `<section><h3>${escapeHtml(title)}</h3><p>${escapeHtml(examples)}</p><span>${escapeHtml(work)}</span></section>`).join("")}</div>`;
    case "economics":
      return `<div class="two economics"><section><h3>${escapeHtml(s.leftTitle)}</h3>${list(s.leftItems)}</section><section><h3>${escapeHtml(s.rightTitle)}</h3>${list(s.rightItems)}</section></div><div class="cost-line"><span>setup cost</span><span>operating cost</span><span>risk cost</span></div>`;
    case "playbook":
      return `<div class="playbook">${s.columns.map(([title, text]) => `<section><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></section>`).join("")}</div>`;
    case "riskGrid":
      return `<div class="risk-grid">${s.risks.map(([title, text]) => `<section><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></section>`).join("")}</div>`;
    case "repoMap":
      return `<table class="repo-map"><thead><tr><th>Paper SDLC idea</th><th>Software Factory surface</th><th>Concrete repo mechanism</th></tr></thead><tbody>${s.rows.map((r) => `<tr>${r.map((x) => `<td>${escapeHtml(x)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    case "controls":
      return `<div class="controls">${s.controls.map(([title, text]) => `<section><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></section>`).join("")}</div>`;
    case "vision":
      return `<div class="vision-grid">${s.vision.map(([title, text]) => `<section><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></section>`).join("")}</div><div class="project-link"><b>Project</b><code>${escapeHtml(s.projectPath)}</code><b>Useful commands</b>${s.commands.map((c) => `<code>${escapeHtml(c)}</code>`).join("")}</div>`;
    default:
      return "";
  }
}

function slideHtml(s, index) {
  return `
  <article class="slide slide-${index + 1} layout-${s.layout}">
    <div class="topline"><span>${escapeHtml(s.kicker)}</span><span>The New SDLC With Vibe Coding</span></div>
    <header>
      <h1>${escapeHtml(s.title)}</h1>
      <p>${escapeHtml(s.subtitle)}</p>
    </header>
    <main>${bodyHtml(s)}</main>
    <footer><span>${s.source ? escapeHtml(s.source) : "Source: user-provided PDF and Software Factory repo docs"}</span><span>${String(index + 1).padStart(2, "0")} / ${slides.length}</span></footer>
  </article>`;
}

const css = `
* { box-sizing: border-box; }
body { margin: 0; background: #0a0c10; font-family: Inter, Avenir Next, Helvetica Neue, Arial, sans-serif; color: #eef3f8; }
.deck { width: 1280px; }
.slide { position: relative; width: 1280px; height: 720px; overflow: hidden; padding: 44px 58px 40px; background: #111820; page-break-after: always; }
.slide::before { content: ""; position: absolute; inset: 0; background: linear-gradient(135deg, rgba(77, 141, 255, .08), transparent 42%), radial-gradient(circle at 92% 9%, rgba(244, 184, 64, .16), transparent 28%); pointer-events: none; }
.slide::after { content: ""; position: absolute; inset: 28px; border: 1px solid rgba(255,255,255,.08); pointer-events: none; }
.topline, footer { position: relative; z-index: 1; display: flex; justify-content: space-between; align-items: center; color: #8fa0b3; font-size: 13px; letter-spacing: 0; }
.topline span:first-child { color: #f2c36b; font-weight: 700; text-transform: uppercase; }
header { position: relative; z-index: 1; width: 1060px; margin-top: 28px; }
h1 { margin: 0; max-width: 1010px; font-size: 45px; line-height: 1.04; letter-spacing: 0; color: #f7fbff; }
header p { margin: 15px 0 0; max-width: 1030px; font-size: 20px; line-height: 1.36; color: #b9c6d4; }
main { position: relative; z-index: 1; height: 445px; margin-top: 28px; }
footer { position: absolute; z-index: 2; left: 58px; right: 58px; bottom: 28px; font-size: 12px; }
h3 { margin: 0 0 16px; color: #ffffff; font-size: 23px; letter-spacing: 0; }
p, li { color: #c8d2de; font-size: 18px; line-height: 1.42; }
ul { margin: 0; padding-left: 22px; }
li { margin: 10px 0; }
section, .cardish { background: rgba(255,255,255,.055); border: 1px solid rgba(255,255,255,.11); border-radius: 8px; box-shadow: 0 16px 48px rgba(0,0,0,.18); }
.layout-cover header { margin-top: 70px; width: 760px; }
.layout-cover h1 { font-size: 62px; line-height: .98; }
.layout-cover header p { font-size: 25px; max-width: 720px; }
.cover-map { position: absolute; right: 82px; top: 144px; width: 330px; display: grid; gap: 12px; }
.lane { height: 50px; padding: 15px 18px; border-left: 5px solid #4d8dff; background: rgba(255,255,255,.07); color: #dce8f5; font-size: 18px; border-radius: 6px; }
.lane.active { border-left-color: #f2c36b; color: #fff; background: rgba(242,195,107,.16); }
.cover-callout { position: absolute; left: 58px; bottom: 98px; width: 700px; padding: 18px 22px; border-radius: 8px; background: rgba(242,195,107,.11); border: 1px solid rgba(242,195,107,.28); font-size: 21px; line-height: 1.35; color: #f9ead0; }
.cover-callout span { display: block; font-size: 13px; text-transform: uppercase; color: #f2c36b; font-weight: 800; margin-bottom: 6px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; height: 348px; }
.two section { padding: 28px; }
.metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; margin-top: 18px; }
.metrics div { min-height: 210px; padding: 28px; border-radius: 8px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); }
.metrics strong { display: block; color: #f2c36b; font-size: 72px; line-height: .9; margin-bottom: 22px; }
.metrics span { color: #d8e1ea; font-size: 21px; line-height: 1.25; }
.large-note { margin-top: 34px; font-size: 24px; color: #fff; }
.agent-loop { position: relative; height: 380px; }
.loop-center, .context-core, .fly-center, .harness-core { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: grid; place-items: center; text-align: center; border-radius: 999px; background: #f2c36b; color: #111820; font-weight: 900; line-height: 1.22; }
.loop-center { width: 160px; height: 160px; font-size: 24px; }
.loop-node { position: absolute; width: 260px; min-height: 98px; padding: 20px; border-radius: 8px; border: 1px solid rgba(255,255,255,.13); background: rgba(255,255,255,.06); }
.loop-node b, .loop-node span { display: block; }
.loop-node b { color: #fff; font-size: 22px; margin-bottom: 7px; }
.loop-node span { color: #b9c6d4; font-size: 16px; }
.n1 { left: 60px; top: 12px; } .n2 { right: 95px; top: 12px; } .n3 { right: 30px; bottom: 30px; } .n4 { left: 480px; bottom: 0; } .n5 { left: 35px; bottom: 54px; }
.spectrum { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; height: 350px; }
.maturity { padding: 24px; }
.maturity h3 { font-size: 25px; }
.maturity p { margin: 12px 0; padding: 10px 12px; background: rgba(255,255,255,.055); border-radius: 6px; font-size: 17px; }
.m2 { border-color: rgba(94, 211, 154, .45); }
.verify-line { display: grid; grid-template-columns: 1fr 80px 1fr; gap: 22px; align-items: stretch; }
.verify-line section { padding: 28px; min-height: 280px; }
.divider { display: grid; place-items: center; color: #f2c36b; font-size: 58px; font-weight: 900; }
.pill-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; }
.pill-row span { padding: 8px 11px; border-radius: 999px; border: 1px solid rgba(242,195,107,.35); color: #f6d998; font-size: 15px; }
.bottom-rule { margin-top: 22px; padding: 18px 22px; border-left: 5px solid #5ed39a; background: rgba(94,211,154,.1); color: #dff7e9; font-size: 22px; border-radius: 6px; }
.context-grid { position: relative; display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; width: 820px; }
.context-grid section { height: 130px; padding: 23px; }
.context-grid b, .context-grid span { display: block; }
.context-grid b { color: #fff; font-size: 23px; margin-bottom: 10px; }
.context-grid span { color: #bdcad8; font-size: 17px; }
.context-core { right: 76px; left: auto; top: 174px; transform: none; width: 230px; height: 230px; font-size: 28px; }
.three { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; height: 340px; }
.three section { padding: 24px; }
.sdlc { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; align-items: end; height: 290px; }
.phase { border-radius: 8px 8px 0 0; padding: 16px 12px; border: 1px solid rgba(255,255,255,.12); background: rgba(77,141,255,.14); min-height: 140px; display: flex; flex-direction: column; justify-content: flex-end; }
.phase b { color: #fff; font-size: 18px; margin-bottom: 9px; }
.phase span { color: #c7d5e3; font-size: 15px; }
.p2 { min-height: 248px; background: rgba(94,211,154,.15); } .p3 { min-height: 214px; } .p4 { min-height: 262px; background: rgba(242,195,107,.16); } .p5 { min-height: 210px; } .p0, .p1 { min-height: 238px; }
.compression { margin-top: 24px; padding: 18px 22px; background: rgba(255,255,255,.06); border-radius: 6px; color: #fff; font-size: 23px; }
.process section, .trade section, .roles section, .economics section { padding: 28px; }
.trade { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
.trade section:first-child { border-color: rgba(94,211,154,.42); }
.trade section:last-child { border-color: rgba(255,117,117,.40); }
.equation { margin-top: 23px; text-align: center; font-size: 27px; font-weight: 800; color: #f2c36b; }
.flywheel { position: relative; height: 365px; }
.fly { position: absolute; width: 215px; min-height: 94px; padding: 18px; border-radius: 8px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.13); }
.fly b, .fly span { display: block; }
.fly b { font-size: 21px; color: #fff; } .fly span { margin-top: 6px; font-size: 15px; color: #bdcad8; }
.f0 { left: 90px; top: 20px; } .f1 { left: 480px; top: 0; } .f2 { right: 90px; top: 100px; } .f3 { left: 585px; bottom: 0; } .f4 { left: 150px; bottom: 42px; }
.fly-center { width: 160px; height: 160px; font-size: 25px; }
.cards3, .playbook { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; }
.cards3 section, .playbook section { min-height: 300px; padding: 27px; }
.cards3 p, .playbook p { font-size: 18px; }
.flow { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; }
.flow section { min-height: 310px; padding: 22px; display: flex; flex-direction: column; justify-content: flex-end; }
.flow span { color: #f2c36b; font-size: 16px; font-weight: 900; }
.flow h3 { font-size: 21px; }
.flow p { font-size: 16px; }
.harness { position: relative; height: 365px; }
.harness-core { width: 150px; height: 150px; font-size: 30px; }
.hr { position: absolute; width: 245px; min-height: 90px; padding: 18px; }
.hr b, .hr span { display: block; }
.hr b { color: #fff; font-size: 20px; } .hr span { color: #c2cfdd; font-size: 15px; margin-top: 6px; }
.h0 { left: 80px; top: 0; } .h1 { left: 450px; top: 0; } .h2 { right: 80px; top: 0; } .h3 { right: 80px; bottom: 0; } .h4 { left: 450px; bottom: 0; } .h5 { left: 80px; bottom: 0; }
table { width: 100%; border-collapse: collapse; overflow: hidden; border-radius: 8px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.12); }
th { color: #f2c36b; text-align: left; font-size: 16px; padding: 13px 16px; border-bottom: 1px solid rgba(255,255,255,.14); }
td { color: #d2dde8; font-size: 16px; line-height: 1.3; padding: 13px 16px; border-bottom: 1px solid rgba(255,255,255,.08); }
.matrix td:first-child, .repo-map td:first-child { color: #fff; font-weight: 800; }
.roles p { margin-top: 0; }
.landscape { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.landscape section { min-height: 315px; padding: 22px; }
.landscape h3 { font-size: 21px; }
.landscape p { color: #fff; font-size: 17px; }
.landscape span { display: block; margin-top: 24px; color: #b9c6d4; font-size: 16px; }
.cost-line { margin-top: 18px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.cost-line span { padding: 15px; border-radius: 6px; text-align: center; background: rgba(242,195,107,.12); color: #f6dda4; font-weight: 800; }
.risk-grid, .controls { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.risk-grid section, .controls section { min-height: 132px; padding: 18px; }
.risk-grid h3, .controls h3 { font-size: 20px; margin-bottom: 8px; }
.risk-grid p, .controls p { font-size: 15px; margin: 0; }
.repo-map th, .repo-map td { font-size: 15px; }
.vision-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.vision-grid section { min-height: 170px; padding: 20px; }
.vision-grid h3 { font-size: 20px; }
.vision-grid p { font-size: 15px; }
.project-link { margin-top: 18px; padding: 18px; border-radius: 8px; background: rgba(242,195,107,.12); border: 1px solid rgba(242,195,107,.28); display: grid; grid-template-columns: 120px 1fr; gap: 10px 16px; align-items: center; }
.project-link b { color: #f2c36b; font-size: 16px; }
.project-link code { grid-column: 2; }
code { color: #f7fbff; background: rgba(0,0,0,.28); border: 1px solid rgba(255,255,255,.10); padding: 8px 10px; border-radius: 6px; font-family: SFMono-Regular, Menlo, Consolas, monospace; font-size: 15px; overflow-wrap: anywhere; }
`;

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

async function readImageBlob(imagePath) {
  const bytes = await fs.readFile(imagePath);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function buildHtml() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="deck">${slides.map(slideHtml).join("\n")}</div></body></html>`;
  await fs.writeFile(HTML_PATH, html, "utf8");
}

async function screenshotSlides() {
  await fs.rm(SLIDES_DIR, { recursive: true, force: true });
  await fs.mkdir(SLIDES_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(HTML_PATH).href);
  for (let i = 0; i < slides.length; i += 1) {
    const output = path.join(SLIDES_DIR, `slide-${String(i + 1).padStart(2, "0")}.png`);
    await page.locator(`.slide-${i + 1}`).screenshot({ path: output });
  }
  await browser.close();
}

async function createPptx() {
  const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  for (let i = 0; i < slides.length; i += 1) {
    const slide = presentation.slides.add();
    slide.background.fill = "#111820";
    const imagePath = path.join(SLIDES_DIR, `slide-${String(i + 1).padStart(2, "0")}.png`);
    slide.images.add({
      blob: await readImageBlob(imagePath),
      contentType: "image/png",
      alt: `Rendered slide ${i + 1}: ${slides[i].title}`,
      fit: "cover",
      position: { left: 0, top: 0, width: 1280, height: 720 },
    });
  }
  const montage = await presentation.export({ format: "webp", montage: true, scale: 0.5 });
  await writeBlob(path.join(QA_DIR, "artifact-tool-montage.webp"), montage);
  for (const [index, slide] of presentation.slides.items.entries()) {
    const png = await presentation.export({ slide, format: "png", scale: 1 });
    await writeBlob(path.join(QA_DIR, `rendered-${String(index + 1).padStart(2, "0")}.png`), png);
  }
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(PPTX_PATH);
}

async function createContactSheet() {
  const thumbs = [];
  for (let i = 0; i < slides.length; i += 1) {
    const file = path.join(QA_DIR, `rendered-${String(i + 1).padStart(2, "0")}.png`);
    const buffer = await sharp(file).resize(320, 180).png().toBuffer();
    thumbs.push(buffer);
  }
  const cols = 4;
  const rows = Math.ceil(slides.length / cols);
  const composites = thumbs.map((input, i) => ({
    input,
    left: (i % cols) * 320,
    top: Math.floor(i / cols) * 180,
  }));
  await sharp({
    create: {
      width: cols * 320,
      height: rows * 180,
      channels: 4,
      background: "#0a0c10",
    },
  })
    .composite(composites)
    .webp({ quality: 88 })
    .toFile(path.join(QA_DIR, "contact-sheet.webp"));
}

async function writeNotes() {
  const notes = [
    "# New SDLC Agentic Engineering Deck Notes",
    "",
    `Source PDF: /Users/wongjunmun/Library/Mobile Documents/com~apple~CloudDocs/file_1461D0C5-3834-4828-8093-75BEA283F902.pdf`,
    `Project repo: ${ROOT}`,
    "",
    "Correction applied: earlier abstract image plates were discarded. The final PPTX contains complete slide PNGs with deterministic text and diagrams.",
    "",
    "Project docs used: README.md, CONTEXT.md, AGENTS.md, docs/adr/0015-supervision-first-console.md, docs/adr/0016-factory-map-spatial-lens-and-cockpit-exception.md, docs/design/ui-ux/README.md, docs/design/ui-ux/screens.md, docs/design/ui-ux/image-prompts.md.",
    "",
    "Slides:",
    ...slides.map((s, i) => `${i + 1}. ${s.title}`),
  ].join("\n");
  await fs.writeFile(NOTES_PATH, notes, "utf8");
}

async function main() {
  await fs.mkdir(BUILD, { recursive: true });
  await fs.mkdir(QA_DIR, { recursive: true });
  await buildHtml();
  await screenshotSlides();
  await createPptx();
  await createContactSheet();
  await writeNotes();
  console.log(JSON.stringify({
    slides: slides.length,
    html: HTML_PATH,
    slidesDir: SLIDES_DIR,
    pptx: PPTX_PATH,
    contactSheet: path.join(QA_DIR, "contact-sheet.webp"),
    montage: path.join(QA_DIR, "artifact-tool-montage.webp"),
    notes: NOTES_PATH,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
