import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { Presentation, PresentationFile } = await import(pathToFileURL("/Users/wongjunmun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/@oai+artifact-tool@file+local-deps+-oai-artifact-tool-oai-artifact_tool-2.8.11.tgz/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs").href);

const ROOT = "/Users/wongjunmun/development/ai-development/software-factory";
const BUILD = path.join(ROOT, "outputs/new-sdlc-deck-build");
const QA_DIR = path.join(BUILD, "qa-editable");
const FINAL_PPTX = path.join(ROOT, "outputs/new-sdlc-agentic-engineering-software-factory-editable.pptx");

const W = 1280;
const H = 720;
const C = {
  bg: "#101820",
  bg2: "#17212b",
  panel: "#1d2732",
  panel2: "#222d38",
  line: "#3a4654",
  text: "#f4f8fb",
  muted: "#c2ceda",
  dim: "#91a1b2",
  accent: "#f2c36b",
  blue: "#4d8dff",
  green: "#5ed39a",
  red: "#ff7575",
};

const deck = [
  {
    kicker: "Document briefing",
    title: "The New SDLC With Vibe Coding",
    subtitle: "From ad-hoc prompting to agentic engineering",
    type: "cover",
    note: "Source document: Addy Osmani, Shubham Saboo, Sokratis Kartakis, May 2026",
  },
  {
    kicker: "Executive thesis",
    title: "The center of gravity moved from syntax to intent",
    subtitle: "Generation is cheap. Direction, context, verification, and judgment are now the scarce engineering work.",
    type: "cards",
    cards: [
      ["What changes", ["Developers express goals and constraints", "Agents produce code, tests, plans, and reviews", "Teams build reusable harnesses instead of one-off prompts"]],
      ["What does not disappear", ["Requirements and architecture still need judgment", "Verification becomes more important", "Engineering culture gets amplified"]],
    ],
  },
  {
    kicker: "Why now",
    title: "Adoption crossed from novelty into daily workflow",
    subtitle: "The paper frames early 2026 as the moment coding agents became normal enough to reshape the SDLC itself.",
    type: "metrics",
    metrics: [["85%", "regularly use AI coding agents"], ["51%", "use them daily"], ["41%", "new code estimated as AI generated"]],
    bottom: "The implication: generation is no longer the bottleneck.",
  },
  {
    kicker: "AI agent refresher",
    title: "An agent is a loop, not just a chat box",
    subtitle: "The paper decomposes agents into a model, tools, memory, orchestration, and deployment context.",
    type: "loop",
    items: [["Model", "reasoning and generation"], ["Tools", "files, tests, APIs"], ["Memory", "persistent facts"], ["Orchestration", "planning and retries"], ["Deployment", "where it runs"]],
  },
  {
    kicker: "Terminology",
    title: "Vibe coding is one point on a maturity spectrum",
    subtitle: "The key question is how much structure and verification surrounds AI-generated work.",
    type: "spectrum",
    columns: [
      ["Vibe coding", ["Loose intent", "Manual eyeballing", "Prototype scope", "High hidden risk"]],
      ["Structured AI-assisted", ["Explicit tasks", "Tests and review", "Team workflow", "Moderate risk"]],
      ["Agentic engineering", ["Specs as inputs", "Tests plus evals", "Production scope", "Managed risk"]],
    ],
  },
  {
    kicker: "The dividing line",
    title: "Verification separates agentic engineering from vibes",
    subtitle: "Without deterministic tests and nondeterministic evals, the process is still vibe coding.",
    type: "splitPlus",
    left: ["Tests", "For deterministic code paths: APIs, transforms, business rules, permissions, migrations, and contracts.", ["unit", "integration", "smoke", "regression"]],
    right: ["Evals", "For agent behavior: plan quality, tool choice, trajectory, response quality, refusal behavior, and edge cases.", ["rubrics", "goldens", "trajectories", "review sets"]],
    bottom: "Agentic engineering starts when both sides are explicit and repeatable.",
  },
  {
    kicker: "Context engineering",
    title: "Prompting matters, but context architecture matters more",
    subtitle: "Output quality depends on what the agent knows, when it knows it, and how stale or overloaded that context becomes.",
    type: "gridCore",
    core: "Context\nengineering",
    items: [["Instructions", "rules and role"], ["Knowledge", "docs and references"], ["Memory", "durable facts"], ["Examples", "few-shot patterns"], ["Tools", "actions and APIs"], ["Guardrails", "bounds and policy"]],
  },
  {
    kicker: "Static vs dynamic context",
    title: "The context boundary becomes an architecture decision",
    subtitle: "Teams decide what is always-on, what is retrieved on demand, and what becomes portable procedural knowledge.",
    type: "threeColumns",
    columns: [
      ["Static context", ["AGENTS.md, CLAUDE.md, GEMINI.md", "System instructions and team norms", "Long-lived persona and safety defaults"]],
      ["Dynamic context", ["Tool results and command output", "Retrieved docs and current files", "Windowed conversation history"]],
      ["Agent Skills", ["Portable procedures", "Progressive disclosure", "Less context rot across agents"]],
    ],
  },
  {
    kicker: "New SDLC shape",
    title: "Implementation compresses unevenly; judgment-heavy phases do not",
    subtitle: "AI speeds coding more than deciding. That changes the lifecycle rhythm.",
    type: "bars",
    bars: [["Requirements", 238, C.blue], ["Architecture", 248, C.green], ["Implementation", 145, C.blue], ["Testing and evals", 262, C.accent], ["Review and deploy", 210, C.blue], ["Maintenance", 190, C.blue]],
    bottom: "Implementation narrows; verification and supervision widen.",
  },
  {
    kicker: "Requirements and architecture",
    title: "The front of the SDLC becomes a conversation with constraints",
    subtitle: "AI can elicit cases and prototype flows. Humans still own tradeoffs and intent.",
    type: "cards",
    cards: [
      ["Requirements with AI", ["Interview users and stakeholders", "Generate stories and edge cases", "Draft acceptance criteria", "Prototype early UX and data flows"]],
      ["Architecture with AI", ["Explore options and consequences", "Document decisions before code", "Turn patterns into repeatable rules", "Keep nonfunctional requirements explicit"]],
    ],
  },
  {
    kicker: "Implementation",
    title: "Agents can make broad changes, but verification drag is real",
    subtitle: "The productivity gain is not automatic; review, debugging, and validation can expand.",
    type: "cards",
    cards: [
      ["Where agents help", ["Multi-file edits", "Boilerplate removal", "Migration assistance", "Fast first drafts"]],
      ["Where drag appears", ["Debugging generated code", "Reviewing unfamiliar diffs", "Integration edge cases", "Trust calibration"]],
    ],
    bottom: "Net productivity = generation speed - verification/rework cost",
  },
  {
    kicker: "Testing and QA",
    title: "Quality becomes a flywheel, not a final phase",
    subtitle: "Output evaluation plus trajectory evaluation feeds improvements back into prompts, tools, tests, and monitoring.",
    type: "cycle",
    items: [["Benchmark", "define success cases"], ["Diagnose", "cluster failures"], ["Optimize", "adjust prompt/tools"], ["Regress", "lock fixed cases"], ["Monitor", "watch production behavior"]],
  },
  {
    kicker: "Review, deploy, maintenance",
    title: "Later SDLC phases get AI help, but not blind autonomy",
    subtitle: "AI can assist review, release, observability, and maintenance while humans retain the irreversible decisions.",
    type: "threeColumns",
    columns: [
      ["Review", ["First-pass critique", "Policy checks", "Risk summaries for humans"]],
      ["Deploy", ["Feature flags and rollout checks", "Runtime telemetry", "Rollback triggers"]],
      ["Maintain", ["Legacy explanation", "Migration plans", "Test modernization"]],
    ],
  },
  {
    kicker: "Factory model",
    title: "The developer output shifts from code to a code-producing system",
    subtitle: "Specs, context, agents, tests, gates, and feedback loops become the assembly line.",
    type: "flow",
    items: [["Spec and context", "intent, constraints, examples"], ["Agent harness", "model, tools, sandbox"], ["Code and tests", "diffs, assertions, docs"], ["Gates", "evals, review, security"], ["Feedback", "logs, failures, improvements"]],
  },
  {
    kicker: "Harness engineering",
    title: "Agent = model plus harness",
    subtitle: "Many failures are harness failures: missing context, weak tools, bad sandboxing, no observability, or unclear permissions.",
    type: "harness",
    items: [["Instructions", "task frame and policy"], ["Tools", "repo, shell, browser, APIs"], ["Sandbox", "permissions and isolation"], ["Orchestration", "routing and retries"], ["Guardrails", "hooks and escalation"], ["Observability", "logs, traces, evals"]],
  },
  {
    kicker: "Harness across the lifecycle",
    title: "Each SDLC phase configures or observes the harness",
    subtitle: "You do not just ask the agent to code; you prepare the system that makes useful code likely.",
    type: "table",
    headers: ["Phase", "Harness role", "Typical assets"],
    rows: [["Requirements", "clarify intent", "schemas, examples, acceptance criteria"], ["Planning", "decompose work", "milestones, dependencies, risk list"], ["Implementation", "run agent safely", "tools, sandbox, edit permissions"], ["Testing", "close feedback loop", "tests, evals, failure clusters"], ["Review", "make judgment visible", "summaries, diffs, policy checks"], ["Deploy", "watch the system", "observability, rollbacks, incidents"]],
  },
  {
    kicker: "Role shift",
    title: "Developers move between conductor and orchestrator modes",
    subtitle: "Hands-on pairing and async delegation both matter; the skill is knowing which mode fits the work.",
    type: "cards",
    cards: [
      ["Conductor", ["Works in real time with an IDE or terminal agent", "Steers line by line", "Checks assumptions quickly", "Keeps local context tight"]],
      ["Orchestrator", ["Splits work across async agents", "Writes crisp specs", "Decomposes tasks", "Evaluates and merges safely"]],
    ],
    bottom: "The last 20 percent is where integration, taste, and domain judgment show up.",
  },
  {
    kicker: "Agent landscape",
    title: "Agents differ by where they operate",
    subtitle: "This helps teams choose the right tool instead of treating every coding agent as equivalent.",
    type: "fourColumns",
    columns: [
      ["Editor agents", "Copilot, Cursor, Windsurf, JetBrains AI\nInline edits and pair programming"],
      ["Terminal agents", "Codex CLI, Claude Code, Cline, Open Code\nRepo-scale tasks and shell workflows"],
      ["Background agents", "Jules, Copilot agent mode, Cursor background\nAsync delegation and PR creation"],
      ["Production agents", "Agent as shipped product\nMemory, permissions, evals, observability"],
    ],
  },
  {
    kicker: "Economics",
    title: "Vibes look cheap until operations and maintenance arrive",
    subtitle: "Context engineering is a financial lever: upfront structure can reduce marginal cost, token waste, and remediation.",
    type: "cards",
    cards: [
      ["Vibe coding", ["Low setup cost", "Fast demos", "High token burn over time", "Maintenance and security tax"]],
      ["Agentic engineering", ["Higher upfront CapEx", "Reusable specs and skills", "Lower marginal change cost", "Better routing and governance"]],
    ],
  },
  {
    kicker: "Adoption playbook",
    title: "Start by making one workflow repeatable and measurable",
    subtitle: "Build context as code, set an eval bar, and distinguish prototypes from production.",
    type: "threeColumns",
    columns: [
      ["Individuals", ["Create AGENTS.md", "Write skills", "Pick one repetitive workflow", "Add tests before agent code"]],
      ["Leaders", ["Treat context as code", "Reward eval quality", "Reshape review", "Fund harness assets"]],
      ["Organizations", ["Invest in substrate", "Adopt interop protocols", "Build hybrid teams", "Hire for judgment"]],
    ],
  },
  {
    kicker: "Risks to manage",
    title: "The new SDLC fails when generation outruns control",
    subtitle: "The warning is not anti-AI. It is anti-unbounded-autonomy.",
    type: "sixGrid",
    items: [["Context rot", "old rules pollute outputs"], ["Test theater", "tests do not prove the risk"], ["Silent tool failure", "agent proceeds after bad command"], ["Permission drift", "write/deploy powers expand"], ["Review overload", "humans rubber-stamp huge diffs"], ["Cost opacity", "token spend hides in background"]],
  },
  {
    kicker: "Mapping to this project",
    title: "Software Factory already embodies the paper's agentic direction",
    subtitle: "This repo is a governed AI SDLC pipeline with explicit seams, artifacts, gates, and approval boundaries.",
    type: "table",
    headers: ["Paper SDLC idea", "Software Factory surface", "Concrete repo mechanism"],
    rows: [["Requirements", "intake brain seam", "FACTORY_BRAIN=claude or ScriptedBrain"], ["Architecture", "stage output", "plans and decisions before build"], ["Implementation", "runner seam", "FACTORY_RUNNER=claude or simulator"], ["Verification", "machine gates", "RED, GREEN plus isolation, review file"], ["Deployment", "human merge gate", "POST approve before irreversible merge"], ["Observability", "progress_event", "append-only two-axis event log"]],
  },
  {
    kicker: "Software Factory technical fit",
    title: "The project turns the paper's ideas into operating controls",
    subtitle: "The strongest alignment is the governance model: deterministic fallback, bounded execution, test isolation, and escalation.",
    type: "sixGrid",
    items: [["Brain seam", "scripted offline by default; real model behind env var"], ["Runner seam", "simulator by default; real Codex/Claude when enabled"], ["Subprocess boundary", "timeouts, max turns, sandboxed edit permissions"], ["Machine gates", "RED fails correctly; GREEN passes without weakening tests"], ["Human gate", "merge only after explicit approval"], ["Mission control", "operator view for requests, gates, events, interventions"]],
  },
  {
    kicker: "Overall vision",
    title: "A governed operating system for AI software delivery",
    subtitle: "Software Factory makes direction, verification, and supervision first-class product surfaces.",
    type: "vision",
    items: [["For builders", "turn a request into a supervised SDLC run"], ["For teams", "standardize context, gates, and review expectations"], ["For leaders", "see work health, risk, cost, and approval points"], ["For the platform", "swap brains and runners without changing the domain model"]],
    project: "/Users/wongjunmun/development/ai-development/software-factory",
    commands: ["make verify", "FACTORY_RUNNER=claude uv run uvicorn app.main:app --port 8000"],
  },
];

function addShape(slide, geometry, left, top, width, height, opts = {}) {
  return slide.shapes.add({
    geometry,
    position: { left, top, width, height },
    fill: opts.fill ?? "none",
    line: opts.line ?? { style: "solid", fill: "none", width: 0 },
    borderRadius: opts.radius ?? undefined,
  });
}

function addText(slide, text, left, top, width, height, opts = {}) {
  const sh = addShape(slide, "textbox", left, top, width, height, {
    fill: opts.fill ?? "none",
    line: opts.line ?? { style: "solid", fill: "none", width: 0 },
  });
  sh.text = text;
  sh.text.style = {
    fontSize: opts.size ?? 18,
    bold: opts.bold ?? false,
    color: opts.color ?? C.text,
    alignment: opts.align ?? "left",
    verticalAlignment: opts.valign ?? "top",
    wrap: "square",
    insets: opts.insets ?? { left: 0, right: 0, top: 0, bottom: 0 },
  };
  return sh;
}

function addCard(slide, x, y, w, h, title, lines, opts = {}) {
  addShape(slide, "roundRect", x, y, w, h, {
    fill: opts.fill ?? C.panel,
    line: { style: "solid", fill: opts.line ?? C.line, width: 1 },
    radius: 8,
  });
  addText(slide, title, x + 18, y + 18, w - 36, 34, { size: opts.titleSize ?? 22, bold: true });
  const body = Array.isArray(lines) ? lines.map((l) => `- ${l}`).join("\n") : lines;
  addText(slide, body, x + 18, y + 62, w - 36, h - 76, { size: opts.bodySize ?? 17, color: C.muted });
}

function addHeader(slide, s, index) {
  addText(slide, s.kicker.toUpperCase(), 58, 46, 430, 18, { size: 13, bold: true, color: C.accent });
  addText(slide, "The New SDLC With Vibe Coding", 930, 46, 290, 18, { size: 13, color: C.dim, align: "right" });
  addText(slide, s.title, 58, 88, 1040, 104, { size: s.title.length > 62 ? 35 : 43, bold: true, color: C.text });
  addText(slide, s.subtitle, 58, 198, 1080, 58, { size: 20, color: C.muted });
  addText(slide, "Source: user-provided PDF and Software Factory repo docs", 58, 682, 620, 16, { size: 11, color: C.dim });
  addText(slide, `${String(index + 1).padStart(2, "0")} / ${deck.length}`, 1160, 682, 60, 16, { size: 11, color: C.dim, align: "right" });
}

function initSlide(presentation, s, index) {
  const slide = presentation.slides.add();
  slide.background.fill = C.bg;
  addShape(slide, "rect", 28, 28, W - 56, H - 56, { fill: "none", line: { style: "solid", fill: "#2b3643", width: 1 } });
  if (s.type === "cover") {
    addText(slide, s.kicker.toUpperCase(), 58, 46, 430, 18, { size: 13, bold: true, color: C.accent });
    addText(slide, "The New SDLC With Vibe Coding", 930, 46, 290, 18, { size: 13, color: C.dim, align: "right" });
    addText(slide, "Source: user-provided PDF and Software Factory repo docs", 58, 682, 620, 16, { size: 11, color: C.dim });
    addText(slide, `${String(index + 1).padStart(2, "0")} / ${deck.length}`, 1160, 682, 60, 16, { size: 11, color: C.dim, align: "right" });
  } else {
    addHeader(slide, s, index);
  }
  return slide;
}

function drawCover(slide, s) {
  addText(slide, s.title, 58, 96, 720, 150, { size: 60, bold: true });
  addText(slide, s.subtitle, 58, 246, 720, 48, { size: 23, color: C.muted });
  const labels = ["Intent", "Context", "Agents", "Tests", "Evals", "Gates"];
  labels.forEach((label, i) => addCard(slide, 880, 142 + i * 54, 300, 42, label, "", { titleSize: 16, bodySize: 1, fill: i === 0 ? "#3b3427" : C.panel, line: i === 0 ? C.accent : C.line }));
  addShape(slide, "roundRect", 58, 520, 700, 88, { fill: "#2a261d", line: { style: "solid", fill: "#7b6738", width: 1 }, radius: 8 });
  addText(slide, "DECK GOAL", 78, 538, 220, 18, { size: 12, bold: true, color: C.accent });
  addText(slide, "Explain the paper deeply, then map it onto this repo's Software Factory vision.", 78, 560, 630, 36, { size: 20, color: "#f9ead0" });
}

function drawCards(slide, s) {
  const n = s.cards.length;
  const gap = 28;
  const w = (1164 - gap * (n - 1)) / n;
  s.cards.forEach((card, i) => addCard(slide, 58 + i * (w + gap), 286, w, 285, card[0], card[1], { fill: i === 1 && n === 2 ? C.panel2 : C.panel }));
  if (s.bottom) addText(slide, s.bottom, 150, 590, 980, 36, { size: 24, bold: true, color: C.accent, align: "center" });
}

function drawMetrics(slide, s) {
  s.metrics.forEach(([num, label], i) => {
    const x = 58 + i * 390;
    addShape(slide, "roundRect", x, 300, 360, 190, { fill: C.panel, line: { style: "solid", fill: C.line, width: 1 }, radius: 8 });
    addText(slide, num, x + 24, 328, 310, 70, { size: 62, bold: true, color: C.accent });
    addText(slide, label, x + 24, 410, 300, 50, { size: 18, color: C.muted });
  });
  addText(slide, s.bottom, 58, 536, 1020, 32, { size: 22, color: C.text });
}

function drawLoop(slide, s) {
  addShape(slide, "ellipse", 560, 335, 160, 120, { fill: C.accent, line: { style: "solid", fill: C.accent, width: 1 } });
  addText(slide, "observe\nplan\nact\nverify", 582, 360, 116, 70, { size: 20, bold: true, color: C.bg, align: "center" });
  const pos = [[120, 290], [500, 270], [880, 290], [700, 500], [260, 500]];
  s.items.forEach(([title, body], i) => addCard(slide, pos[i][0], pos[i][1], 260, 92, title, body, { bodySize: 15 }));
}

function drawSpectrum(slide, s) {
  s.columns.forEach(([title, items], i) => addCard(slide, 58 + i * 390, 286, 360, 300, title, items, { fill: i === 2 ? "#1d3029" : C.panel, line: i === 2 ? C.green : C.line }));
}

function drawSplitPlus(slide, s) {
  addCard(slide, 58, 298, 500, 220, s.left[0], s.left[1], { bodySize: 17 });
  addText(slide, s.left[2].join("   "), 86, 475, 440, 24, { size: 14, color: C.accent });
  addText(slide, "+", 610, 364, 60, 80, { size: 58, bold: true, color: C.accent, align: "center" });
  addCard(slide, 720, 298, 500, 220, s.right[0], s.right[1], { bodySize: 17 });
  addText(slide, s.right[2].join("   "), 748, 475, 440, 24, { size: 14, color: C.accent });
  addShape(slide, "roundRect", 58, 560, 1162, 48, { fill: "#162d25", line: { style: "solid", fill: C.green, width: 1 }, radius: 6 });
  addText(slide, s.bottom, 80, 574, 1100, 22, { size: 20, color: "#dff7e9" });
}

function drawGridCore(slide, s) {
  s.items.forEach(([title, body], i) => {
    const x = 58 + (i % 3) * 270;
    const y = 292 + Math.floor(i / 3) * 126;
    addCard(slide, x, y, 250, 100, title, body, { bodySize: 15 });
  });
  addShape(slide, "ellipse", 928, 340, 220, 180, { fill: C.accent, line: { style: "solid", fill: C.accent, width: 1 } });
  addText(slide, s.core, 958, 386, 160, 70, { size: 24, bold: true, color: C.bg, align: "center" });
}

function drawThreeColumns(slide, s) {
  s.columns.forEach(([title, items], i) => addCard(slide, 58 + i * 390, 290, 360, 285, title, items, { bodySize: 16 }));
}

function drawFourColumns(slide, s) {
  s.columns.forEach(([title, body], i) => addCard(slide, 58 + i * 292, 294, 270, 285, title, body, { bodySize: 15 }));
}

function drawBars(slide, s) {
  s.bars.forEach(([label, height, color], i) => {
    const x = 58 + i * 190;
    const y = 560 - height;
    addShape(slide, "rect", x, y, 158, height, { fill: color, line: { style: "solid", fill: "#293442", width: 1 } });
    addText(slide, label, x + 10, y + height - 58, 138, 22, { size: 15, bold: true, color: "#ffffff" });
  });
  addText(slide, s.bottom, 58, 592, 880, 30, { size: 21, color: C.text });
}

function drawCycle(slide, s) {
  const pos = [[128, 320], [468, 286], [828, 335], [642, 520], [236, 514]];
  s.items.forEach(([title, body], i) => addCard(slide, pos[i][0], pos[i][1], 210, 86, title, body, { bodySize: 14 }));
  addShape(slide, "ellipse", 560, 380, 160, 130, { fill: C.accent, line: { style: "solid", fill: C.accent, width: 1 } });
  addText(slide, "quality\nloop", 586, 418, 108, 48, { size: 23, bold: true, color: C.bg, align: "center" });
}

function drawFlow(slide, s) {
  s.items.forEach(([title, body], i) => {
    const x = 58 + i * 232;
    addCard(slide, x, 314, 210, 250, `0${i + 1}\n${title}`, body, { bodySize: 15 });
    if (i < s.items.length - 1) addText(slide, ">", x + 214, 408, 28, 30, { size: 28, bold: true, color: C.accent, align: "center" });
  });
}

function drawHarness(slide, s) {
  addShape(slide, "ellipse", 570, 370, 140, 110, { fill: C.accent, line: { style: "solid", fill: C.accent, width: 1 } });
  addText(slide, "Model", 600, 410, 82, 26, { size: 24, bold: true, color: C.bg, align: "center" });
  const pos = [[108, 288], [458, 276], [818, 288], [818, 518], [458, 540], [108, 518]];
  s.items.forEach(([title, body], i) => addCard(slide, pos[i][0], pos[i][1], 255, 90, title, body, { bodySize: 14 }));
}

function drawTable(slide, s) {
  const x = 58, y = 286, w = 1162, h = 330;
  const rowH = h / (s.rows.length + 1);
  const colW = [260, 310, 592];
  addShape(slide, "roundRect", x, y, w, h, { fill: C.panel, line: { style: "solid", fill: C.line, width: 1 }, radius: 8 });
  let cx = x;
  s.headers.forEach((head, i) => {
    addText(slide, head, cx + 16, y + 14, colW[i] - 28, 22, { size: 15, bold: true, color: C.accent });
    cx += colW[i];
  });
  addShape(slide, "line", x, y + rowH, w, 0, { line: { style: "solid", fill: C.line, width: 1 } });
  s.rows.forEach((row, r) => {
    let left = x;
    const top = y + rowH * (r + 1);
    if (r > 0) addShape(slide, "line", x, top, w, 0, { line: { style: "solid", fill: "#2f3a46", width: 1 } });
    row.forEach((cell, c) => {
      addText(slide, cell, left + 16, top + 12, colW[c] - 28, rowH - 16, { size: 15, bold: c === 0, color: c === 0 ? C.text : C.muted });
      left += colW[c];
    });
  });
}

function drawSixGrid(slide, s) {
  s.items.forEach(([title, body], i) => {
    const x = 58 + (i % 3) * 390;
    const y = 292 + Math.floor(i / 3) * 150;
    addCard(slide, x, y, 360, 116, title, body, { bodySize: 15 });
  });
}

function drawVision(slide, s) {
  s.items.forEach(([title, body], i) => addCard(slide, 58 + i * 292, 292, 270, 150, title, body, { bodySize: 15 }));
  addShape(slide, "roundRect", 58, 472, 1162, 142, { fill: "#26261f", line: { style: "solid", fill: "#78663e", width: 1 }, radius: 8 });
  addText(slide, "Project", 78, 500, 130, 22, { size: 16, bold: true, color: C.accent });
  addText(slide, s.project, 220, 496, 960, 28, { size: 16, bold: true, color: C.text });
  addText(slide, "Useful commands", 78, 542, 130, 46, { size: 16, bold: true, color: C.accent });
  addText(slide, s.commands.join("\n"), 220, 538, 960, 58, { size: 16, bold: true, color: C.text });
}

function drawSlide(presentation, s, index) {
  const slide = initSlide(presentation, s, index);
  if (s.type === "cover") return drawCover(slide, s);
  if (s.type === "cards") return drawCards(slide, s);
  if (s.type === "metrics") return drawMetrics(slide, s);
  if (s.type === "loop") return drawLoop(slide, s);
  if (s.type === "spectrum") return drawSpectrum(slide, s);
  if (s.type === "splitPlus") return drawSplitPlus(slide, s);
  if (s.type === "gridCore") return drawGridCore(slide, s);
  if (s.type === "threeColumns") return drawThreeColumns(slide, s);
  if (s.type === "fourColumns") return drawFourColumns(slide, s);
  if (s.type === "bars") return drawBars(slide, s);
  if (s.type === "cycle") return drawCycle(slide, s);
  if (s.type === "flow") return drawFlow(slide, s);
  if (s.type === "harness") return drawHarness(slide, s);
  if (s.type === "table") return drawTable(slide, s);
  if (s.type === "sixGrid") return drawSixGrid(slide, s);
  if (s.type === "vision") return drawVision(slide, s);
}

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

async function main() {
  await fs.mkdir(QA_DIR, { recursive: true });
  const presentation = Presentation.create({ slideSize: { width: W, height: H } });
  deck.forEach((s, i) => drawSlide(presentation, s, i));

  for (const [index, slide] of presentation.slides.items.entries()) {
    await writeBlob(path.join(QA_DIR, `editable-slide-${String(index + 1).padStart(2, "0")}.png`), await presentation.export({ slide, format: "png", scale: 1 }));
    await fs.writeFile(path.join(QA_DIR, `editable-slide-${String(index + 1).padStart(2, "0")}.layout.json`), await (await slide.export({ format: "layout" })).text());
  }
  await writeBlob(path.join(QA_DIR, "editable-montage.webp"), await presentation.export({ format: "webp", montage: true, scale: 0.5 }));
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(FINAL_PPTX);
  await fs.writeFile(path.join(QA_DIR, "source-notes.txt"), [
    "Editable deck rebuilt with native PPTX objects using @oai/artifact-tool.",
    "No full-slide bitmap images are used in the final editable deck.",
    "Sources: user-provided PDF; Software Factory README.md, CONTEXT.md, AGENTS.md, ADR 0015, ADR 0016, design docs.",
    `Final PPTX: ${FINAL_PPTX}`,
  ].join("\n"));
  console.log(JSON.stringify({ slides: deck.length, pptx: FINAL_PPTX, qa: QA_DIR }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
