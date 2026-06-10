"""Intake interview + Draft-spec generation.

This is the Stage 1 "brain". Per ADR 0007 every model call sits behind one seam
(`InterviewBrain`); the default implementation is deterministic/scripted so the
whole app runs offline. Swapping in a real LLM later means replacing only this
module's `brain` instance.
"""
from dataclasses import dataclass, field

from .models import Request, SpecLine

MAX_QUESTIONS = 3  # US10: stop after a few — hard ceiling


def answered_count(req: Request) -> int:
    """The one definition of an answered turn: answered or explicitly skipped."""
    return sum(1 for t in req.turns if t.answer is not None or t.skipped)


@dataclass
class Question:
    question: str
    sub: str | None = None
    options: list[dict] | None = None  # [{"t": title, "d": description}]
    final: bool = field(default=False)


def _q(question, sub=None, options=None, final=False) -> Question:
    return Question(question=question, sub=sub, options=options, final=final)


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
        _q("Who will use this day-to-day, and for what?"),
        _q(
            "Roughly how many people would use it?",
            options=[
                {"t": "Just my team", "d": "Under 10 people."},
                {"t": "My department", "d": "Tens of people."},
                {"t": "Several departments", "d": "Low hundreds."},
                {"t": "The whole site", "d": "Hundreds or more."},
            ],
        ),
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


class ScriptedBrain:
    """Deterministic interview + spec generator (the offline LLMClient)."""

    def next_question(self, req: Request) -> Question | None:
        script = SCRIPTS.get(req.type, SCRIPTS["other"])
        answered = answered_count(req)
        if answered >= min(MAX_QUESTIONS, len(script)):
            return None
        return script[answered]

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
        # one explicit assumption — the anti-rubber-stamp ledger always has something to check
        if req.app_id:
            add("Work is scoped to the existing app's current integrations only.", assume=True)
        else:
            add("A new repository will be provisioned for this app on approval.", assume=True)

        n_skip = len(skipped)
        note = (
            "1 assumption needs confirming before approval"
            + (f" — and {n_skip} interview question{'s' if n_skip > 1 else ''} were skipped." if n_skip else ".")
        )
        return lines, note


brain = ScriptedBrain()


def get_brain() -> ScriptedBrain:
    """ADR 0007 seam: FACTORY_BRAIN=claude swaps in the real model, scripted is the offline default."""
    from .claude_exec import brain_mode  # local import — claude_brain subclasses ScriptedBrain

    if brain_mode() == "claude":
        from .claude_brain import ClaudeBrain

        return ClaudeBrain()
    return brain
