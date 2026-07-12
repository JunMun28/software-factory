"""Adaptive per-type interview depth (grill-style).

The flat 3-question cap became a (floor, ceiling) budget per request type, and
the AgentBrain may finish early once it could write a confident spec — but never
before the floor, never past the ceiling. The model call is faked; this is unit
coverage of the budget/adaptivity logic, not the CLI.
"""
from app.agent_brain import AgentBrain
from app.agent_exec import AgentResult
from app.interview import question_budget, question_ceiling
from app.models import InterviewTurn, Request


def _req(req_type: str, answered: int = 0) -> Request:
    """A transient request with `answered` completed interview turns."""
    r = Request(ref="REQ-BUD", title="T", description="d", type=req_type)
    for i in range(answered):
        r.turns.append(InterviewTurn(order=i, question=f"Q{i + 1}", answer=f"A{i + 1}"))
    return r


def _fake_brain(monkeypatch, text: str, ok: bool = True):
    calls = {"n": 0, "prompt": None}

    def fake_run(req, prompt, *, timeout):
        calls["n"] += 1
        calls["prompt"] = prompt
        return AgentResult(ok=ok, text=text)

    monkeypatch.setattr("app.agent_brain._run_with_attachments", fake_run)
    return AgentBrain(), calls


# ── budget table ──

def test_ceiling_per_type():
    assert question_ceiling(_req("bug")) == 3
    assert question_ceiling(_req("enh")) == 4
    assert question_ceiling(_req("new")) == 99
    assert question_ceiling(_req("other")) == 4
    assert question_ceiling(_req("mystery")) == 3  # unknown type → default


def test_floor_not_above_ceiling():
    for t in ("bug", "enh", "new", "other"):
        floor, ceiling = question_budget(t)
        assert 1 <= floor <= ceiling


# ── AgentBrain adaptivity ──

def test_stops_at_new_app_ceiling(monkeypatch):
    brain, calls = _fake_brain(monkeypatch, '{"question":"more?"}')
    assert brain.next_question(_req("new", answered=10)) is not None  # uncapped — 10 is not the ceiling
    assert brain.next_question(_req("new", answered=99)) is None  # sentinel ceiling still stops it
    assert calls["n"] == 1  # only the answered=10 call consults the model; the sentinel skips it


def test_asks_below_ceiling(monkeypatch):
    brain, calls = _fake_brain(monkeypatch, '{"question":"Who owns it?","sub":null,"options":null}')
    q = brain.next_question(_req("new", answered=5))
    assert q and q.question == "Who owns it?" and q.final is False
    assert calls["n"] == 1


def test_last_question_flagged_final(monkeypatch):
    brain, _ = _fake_brain(monkeypatch, '{"question":"Anything else?"}')
    q = brain.next_question(_req("bug", answered=2))  # bug ceiling 3 → this is the last
    assert q and q.final is True


def test_model_finishes_early_above_floor(monkeypatch):
    brain, _ = _fake_brain(monkeypatch, '{"done": true}')
    assert brain.next_question(_req("enh", answered=3)) is None  # enh floor 2 — allowed to stop


def test_done_ignored_below_floor(monkeypatch):
    # "new" floor is 3; a done at 1 answered is too early — a question is still produced
    brain, _ = _fake_brain(monkeypatch, '{"done": true}')
    assert brain.next_question(_req("new", answered=1)) is not None


def test_prompt_surfaces_budget_range(monkeypatch):
    brain, calls = _fake_brain(monkeypatch, '{"question":"What is it?"}')
    brain.next_question(_req("new", answered=0))
    assert "99" in calls["prompt"]  # the ceiling is shown to the model
