"""Intake interview + Draft-spec generation.

This is the Stage 1 "brain". Per ADR 0007 every model call sits behind one seam
(`InterviewBrain`); the default implementation is deterministic/scripted so the
whole app runs offline. Swapping in a real LLM later means replacing only this
module's `brain` instance.
"""
from dataclasses import dataclass, field
from html import escape

from .models import Request, SpecLine

# US10: intake stays short, but depth scales with how open-ended the request is.
# (floor, ceiling) per type: never stop before `floor`, never exceed `ceiling`.
# Between them the AgentBrain decides when it has enough (grill until it could
# write a confident spec); the scripted brain is additionally bounded by its
# short script, so the offline path stays shallow.
QUESTION_BUDGET: dict[str, tuple[int, int]] = {
    "bug": (2, 3),   # a report is usually concrete — a couple of clarifiers
    "enh": (2, 4),   # scale with complexity, capped
    "new": (3, 99),  # UNCAPPED by design (spec/ADR 0023): the model's judgment and the
                     # submitter's conversational "that's enough" are the real stops
    "other": (2, 4),
}
DEFAULT_BUDGET = (2, 3)


def question_budget(req_type: str) -> tuple[int, int]:
    """(floor, ceiling) number of interview questions for a request type."""
    return QUESTION_BUDGET.get(req_type, DEFAULT_BUDGET)


def question_ceiling(req: "Request") -> int:
    """Hard upper bound on interview questions for this request. Once 'Add more detail' reopens
    a finished interview, a small per-reopen allowance (reopen_ceiling) overrides the type
    budget so a deep new-app grill doesn't restart from scratch."""
    return getattr(req, "reopen_ceiling", None) or question_budget(req.type)[1]

# Describe-step reach chip → spec Impact line (submitters state facts; we word the impact).
# Free-text reach falls through and is quoted as written.
REACH_IMPACT = {
    "me": "just the requester (1 person)",
    "team": "the requester's team (under 10 people)",
    "dept": "their whole department (tens of people)",
    "wider": "multiple departments (100+ people)",
    "site": "the whole site (hundreds of people)",
    "network": "multiple sites across the network (1000+ people)",
}

# Describe-step impact estimate → spec wording, keyed by metric
IMPACT_WORDING = {
    "hours": lambda v: f"{v} man-hours saved per year.",
    "cost": lambda v: f"{v}k saved per year.",
    "other": lambda v: f"{v.rstrip('.')}.",
}


def answered_count(req: Request) -> int:
    """The one definition of an answered turn: answered or explicitly skipped."""
    return sum(1 for t in req.turns if t.answer is not None or t.skipped)


# Short, explicit stop phrases the submitter can type to end an uncapped interview
# (spec/ADR 0023: the chat is the control — no dedicated stop button). Kept deterministic
# so it works in every brain mode; only a SHORT message counts, so a long answer that
# merely contains the words is still treated as a real answer.
# Unambiguous multi-word phrases: safe to match as a whole message OR a prefix
# ("stop asking questions" still means stop).
_STOP_PREFIXES = ("that's enough", "thats enough", "that is enough", "no more questions",
                  "stop asking", "i'm done", "im done")

# Generic bare phrases: only unambiguous when they ARE the entire message. As a
# prefix they collide with real answers ("no more than 5 users", "stop the
# duplicate emails from firing"), so never prefix-match these.
_STOP_EXACT = ("stop", "no more", "enough", "done")


def is_stop_signal(text: str) -> bool:
    t = (text or "").strip().lower().rstrip(".!")
    if not t or len(t) > 40:  # a substantive answer, not a stop command
        return False
    t = t.removesuffix(" please").rstrip()
    if t in _STOP_EXACT:
        return True
    return any(t == p or t.startswith(p + " ") for p in _STOP_PREFIXES)


@dataclass
class Question:
    question: str
    sub: str | None = None
    options: list[dict] | None = None  # [{"t": title, "d": description}]
    final: bool = field(default=False)


def _q(question, sub=None, options=None, final=False) -> Question:
    return Question(question=question, sub=sub, options=options, final=final)


# Request.pending_question marker: the brain ended the interview early (no more
# questions). Distinguishable from a real question, which always has a "question" key.
DONE_SENTINEL = {"done": True}


def pending_payload(q: Question | None) -> dict:
    """Serialize a generated question — or the done marker — for Request.pending_question."""
    if q is None:
        return DONE_SENTINEL
    return {"question": q.question, "sub": q.sub, "options": q.options, "final": q.final}


# The host app's design tokens (mirrors apps/intake/src/styles.css) — the single source both the
# scripted prototype floor and the real design harness cite, so a mock looks like part of THIS
# product (the Micron-purple accent on a near-neutral canvas), not a bespoke palette. Dark keys off
# prefers-color-scheme because the mock renders in an isolated sandbox with no theme toggle.
HOST_APP_PALETTE = """:root {
    --bg:#faf9fb; --surface:#ffffff; --surface-2:#f4f3f7; --fg1:#1a1a1f; --fg2:#3a3a42;
    --muted:#6c6c78; --border:#e6e6ea; --hairline:#eeeef2; --radius:10px;
    --accent:#a402dc; --accent-strong:#bd03f7; --accent-tint:#fbe9fe; --accent-tx:#8a01bc;
    --green:#2e7d52; --amber:#c77800; --red:#c0392b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#101013; --surface:#19191c; --surface-2:#222226; --fg1:#f0f0f3; --fg2:#c7c7cb;
      --muted:#959599; --border:#323237; --hairline:#1e1e21;
      --accent-tint:#2a1140; --accent-tx:#d78bf9;
    }
  }"""


def scripted_prototype_html(req: Request) -> str:
    """A deterministic, self-contained, CSP-safe single-screen mock — the offline prototype
    floor (and the seed the real harness improves on). Themed from the host app's tokens
    (HOST_APP_PALETTE) so it matches this product; carries data-pid / data-screen-label
    anchors so the point-to-edit inspector works even offline."""
    app = escape((req.app_name or "New app").strip())
    title = escape((req.title or req.app_name or "New app").strip())
    desc = escape((req.description or "").strip() or "A first look at the experience you described.")
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'">
<title>{app}</title>
<style>
  {HOST_APP_PALETTE}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; font-family:'Hanken Grotesk',system-ui,sans-serif; background:var(--bg); color:var(--fg1); }}
  .wrap {{ max-width:720px; margin:0 auto; padding:40px 24px; }}
  header {{ display:flex; align-items:center; gap:10px; margin-bottom:26px; }}
  .logo {{ font-family:'Space Grotesk',system-ui,sans-serif; font-weight:700; font-size:20px; color:var(--accent); }}
  h1 {{ font-family:'Space Grotesk',system-ui,sans-serif; font-size:32px; line-height:1.15; margin:0 0 10px; max-width:16ch; text-wrap:balance; color:var(--fg1); }}
  p.sub {{ color:var(--muted); font-size:16px; margin:0 0 26px; max-width:52ch; }}
  .cards {{ display:grid; gap:14px; }}
  .card {{ background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:20px; }}
  .card h2 {{ font-size:15px; margin:0 0 6px; color:var(--fg1); }}
  .card p {{ margin:0; color:var(--muted); font-size:14px; }}
  .cta {{ display:inline-flex; background:var(--accent); color:#fff; font-weight:600; padding:11px 20px; border-radius:var(--radius); margin-top:18px; }}
</style>
</head>
<body>
  <div class="wrap" data-screen-label="Home">
    <header><span class="logo" data-pid="logo">{app}</span></header>
    <h1 data-pid="headline">{title}</h1>
    <p class="sub" data-pid="subhead">{desc}</p>
    <div class="cards">
      <div class="card" data-pid="card-primary"><h2>Get started</h2><p>The main thing a person comes here to do.</p></div>
      <div class="card" data-pid="card-secondary"><h2>Recent activity</h2><p>What's happened lately, at a glance.</p></div>
    </div>
    <span class="cta" data-pid="cta">Start</span>
  </div>
</body>
</html>"""


SCRIPTS: dict[str, list[Question]] = {
    "enh": [
        _q("In a sentence, what's slow or painful about this today?"),
        _q(
            "Got it. How many items do you usually handle in one go?",
            options=[
                {"t": "A handful", "d": "Under 10 at a time — one-off lookups."},
                {"t": "A few dozen", "d": "A typical week's worth."},
                {"t": "A few hundred", "d": "A full month in one export — most common."},
                {"t": "Thousands or more", "d": "Quarterly or annual pulls; performance matters most here."},
            ],
        ),
        _q(
            "Last thing — anything we should be careful not to break?",
            sub="Totally fine to skip if nothing comes to mind.",
            final=True,
        ),
    ],
    "bug": [
        _q("What did you expect to happen instead?"),
        _q(
            "How often does it happen?",
            options=[
                {"t": "Every time", "d": "Reliably reproducible."},
                {"t": "Most of the time", "d": "More often than not."},
                {"t": "Sometimes", "d": "Intermittent — hard to pin down."},
                {"t": "Only once so far", "d": "Seen it a single time."},
            ],
        ),
        _q(
            "Last thing — anything that seems to make it better or worse?",
            sub="Totally fine to skip if nothing comes to mind.",
            final=True,
        ),
    ],
    "new": [
        # who + headcount already come from the basics (the reach chip) — don't re-ask them here;
        # this question is about the functional job the app must do, in plain non-technical terms
        _q("What are the main things people should be able to do in it?"),
        _q(
            "Last thing — what single outcome would make this a clear win?",
            sub="One sentence is plenty.",
            final=True,
        ),
    ],
    "other": [
        _q("Tell us a bit more about what's prompting this."),
        _q(
            "How urgent does it feel?",
            options=[
                {"t": "Blocking me now", "d": "I can't get my work done."},
                {"t": "This week", "d": "Needed soon, not this minute."},
                {"t": "This quarter", "d": "Important, not urgent."},
                {"t": "Whenever", "d": "Nice to have."},
            ],
        ),
        _q(
            "Last thing — anything else we should know?",
            sub="Totally fine to skip.",
            final=True,
        ),
    ],
}


# Deterministic offline classifier (the ADR 0007 fallback). Real models override
# in AgentBrain. Keyword hits vote for a type; the winning margin sets confidence.
_CLASSIFY_KEYWORDS: dict[str, tuple[str, ...]] = {
    "bug": ("broken", "error", "crash", "fails", "failing", "wrong", "bug",
            "doesn't work", "does not work", "slow", "stuck", "can't", "cannot"),
    "enh": ("add", "improve", "existing", "also", "better", "extend", "support",
            "enhance", "option to", "ability to", "would be nice"),
    "new": ("build", "new app", "new tool", "from scratch", "create a", "brand-new",
            "brand new", "greenfield", "stand up", "spin up"),
}
_VAGUE = ("not sure", "maybe", "idea", "think about", "unsure", "no idea", "dunno")


def _classify_scores(text: str) -> dict[str, int]:
    t = text.lower()
    return {k: sum(t.count(kw) for kw in kws) for k, kws in _CLASSIFY_KEYWORDS.items()}


class ScriptedBrain:
    """Deterministic interview + spec generator (the offline LLMClient)."""

    def next_question(self, req: Request) -> Question | None:
        script = SCRIPTS.get(req.type, SCRIPTS["other"])
        answered = answered_count(req)
        if answered >= min(question_ceiling(req), len(script)):
            return None
        return script[answered]

    def propose_escalation(self, req: Request) -> dict | None:
        """Whether the brain wants to propose a mid-interview type change (ADR 0023).
        The offline default never proposes one — deterministic, so the scripted/smoke
        path stays silent. A real model fills this seam later; the UI drives accept/decline."""
        return None

    def classify(self, description: str) -> dict:
        """Deterministic type guess + confidence from the free-text description.
        Empty/vague → new with low confidence; a clear keyword winner → high."""
        text = (description or "").strip()
        if not text:
            return {"type": "new", "confidence": 0.0}
        scores = _classify_scores(text)
        best = max(scores, key=lambda k: scores[k])
        top = scores[best]
        if top == 0:
            # no signal — default to the factory's main flow, low confidence
            conf = 0.15 if any(v in text.lower() for v in _VAGUE) else 0.35
            return {"type": "new", "confidence": conf}
        runner_up = max((v for k, v in scores.items() if k != best), default=0)
        margin = top - runner_up
        conf = min(0.95, 0.55 + 0.15 * margin)
        if any(v in text.lower() for v in _VAGUE):
            conf = min(conf, 0.45)  # hedged language caps confidence
        return {"type": best, "confidence": round(conf, 2)}

    def summarize(self, req: Request) -> dict:
        """Deterministic review spec (the offline fallback): overview from the request, plus
        structured sections built from reach/impact/answers. Real models override with a written
        narrative. Returns {overview, sections:[{title, items}]}."""
        overview = (req.description or "").strip() or req.title
        sections: list[dict] = []
        if req.reach:
            sections.append({"title": "Who it's for", "items": [REACH_IMPACT.get(req.reach, req.reach)]})
        answers = [t.answer.strip().rstrip(".") for t in req.turns if t.answer]
        if answers:
            sections.append({"title": "Details from the interview", "items": answers[:8]})
        if req.impact_metric and req.impact_value:
            wording = IMPACT_WORDING.get(req.impact_metric, IMPACT_WORDING["other"])
            sections.append({"title": "Success measure", "items": [wording(req.impact_value).rstrip(".")]})
        return {"overview": overview, "sections": sections}

    def generate_prototype(self, req: Request, instruction: str | None = None,
                           annotation: dict | None = None, current_html: str | None = None) -> dict:
        """Deterministic offline prototype (the fallback / floor). The first call rewrites a
        static single-file mock from the request; a later instruction records a visible edit
        marker so the document changes and a revision is recorded. Real models override with the
        baoyu/artifact-design harness. Returns {mode, note, html} — html is None for a chat turn."""
        if current_html is None:
            return {"mode": "rewrite", "note": f"Drafted a starting layout for {req.app_name}.",
                    "html": scripted_prototype_html(req)}
        instr = (instruction or "").strip()
        if not instr:
            return {"mode": "chat", "note": "Tell me what to change and I'll update the mock.", "html": None}
        marker = f"\n  <!-- edit: {escape(instr[:120])} -->\n"
        edited = (current_html.replace("</body>", marker + "</body>", 1)
                  if "</body>" in current_html else current_html + marker)
        return {"mode": "rewrite", "note": f"Applied: {instr[:80]}", "html": edited}

    def draft_spec(self, req: Request) -> tuple[list[SpecLine], str]:
        """Grounded lines: every line carries provenance; gaps become ASSUMPTIONs."""
        lines: list[SpecLine] = []
        order = 0

        def add(text: str, prov: str | None = None, assume: bool = False):
            nonlocal order
            lines.append(SpecLine(request=req, order=order, text=text, prov=prov, assume=assume))
            order += 1

        add(f"Deliver: {req.title}.", prov="request")
        if req.description:
            add(req.description.strip().rstrip(".") + ".", prov="request")
        skipped = []
        for i, t in enumerate(req.turns, start=1):
            if t.answer:
                add(t.answer.strip().rstrip(".") + ".", prov=f"Q{i}")
            elif t.skipped:
                skipped.append(i)
        if req.type == "bug" and req.bug_where:
            add(f"Affected area: {req.bug_where}.", prov="request")
        # value justification: reach + impact estimate ground Impact lines; gaps become ASSUMPTIONs
        if req.type != "bug":
            if req.reach:
                worded = REACH_IMPACT.get(req.reach, req.reach)
                add(f"Impact: affects {worded}.", prov="request")
            has_estimate = bool(req.impact_metric and req.impact_value)
            if has_estimate:
                wording = IMPACT_WORDING.get(req.impact_metric, IMPACT_WORDING["other"])
                add(f"Impact estimate: {wording(req.impact_value)}", prov="request")
            if not req.reach:
                if has_estimate:
                    add("Who's affected wasn't stated — assumed only the requester.", assume=True)
                else:
                    add("Impact not stated — assumed to affect only the requester.", assume=True)
        # one explicit assumption — the anti-rubber-stamp ledger always has something to check
        if req.app_id:
            add("Work is scoped to the existing app's current integrations only.", assume=True)
        else:
            add("A new repository will be provisioned for this app on approval.", assume=True)

        n_skip = len(skipped)
        n_assume = sum(1 for line in lines if line.assume)
        note = (
            f"{n_assume} assumption{'s need' if n_assume > 1 else ' needs'} confirming before approval"
            + (f" — and {n_skip} interview question{'s were' if n_skip > 1 else ' was'} skipped." if n_skip else ".")
        )
        return lines, note


brain = ScriptedBrain()


def get_brain() -> ScriptedBrain:
    """ADR 0007 seam: FACTORY_BRAIN=agent swaps in the real model (the claude/codex CLI,
    picked by FACTORY_CLI); scripted is the offline default."""
    from .agent_exec import brain_mode  # local import — brains subclass ScriptedBrain

    if brain_mode() != "agent":
        return brain
    from .agent_brain import AgentBrain

    return AgentBrain()
