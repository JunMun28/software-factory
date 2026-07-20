"""Per-user daily brain budget (Plan 008 Phase 0 / D6).

The caps degrade over-budget reporters to the scripted brain and log a
status="budget" telemetry row — the interview stays working, nothing 4xxes, and
ops can see the throttle. Attribution is per-reporter (brain_calls join requests)
per UTC day; the verdict is memoized ~30s per process.
"""

from sqlalchemy import select

from app import brain_calls, interview_gen, settings
from app.brain_calls import (
    budget_degraded,
    budget_exhausted,
    record_budget_call,
    reset_budget_cache,
)
from app.db import SessionLocal
from app.interview import Question
from app.models import BrainCall, Request
from app.routers.requests import interview_state


def _make_request(client, reporter: str, *, req_type: str = "bug",
                  description: str = "the export is broken") -> int:
    resp = client.post(
        "/api/requests",
        json={
            "type": req_type,
            "title": "Budget probe",
            "description": description,
            "reporter": reporter,
            "reporter_initials": "BP",
        },
    )
    assert resp.status_code == 201
    return resp.json()["id"]


def _add_billed_call(request_id: int, *, tokens: int = 0, status: str = "ok",
                     kind: str = "question") -> None:
    """Insert a brain_calls row attributed to a request (via its reporter)."""
    with SessionLocal() as db:
        db.add(
            BrainCall(
                request_id=request_id,
                kind=kind,
                dedup_key=None,
                model="claude-sonnet-5",
                status=status,
                tokens_out=tokens or None,
            )
        )
        db.commit()


def _calls_for(request_id: int) -> list[BrainCall]:
    with SessionLocal() as db:
        return list(
            db.scalars(select(BrainCall).where(BrainCall.request_id == request_id))
        )


# ---------- the pure budget query ----------

def test_under_budget_is_not_exhausted(client, monkeypatch):
    reset_budget_cache()
    monkeypatch.setattr(settings, "USER_DAILY_TOKENS", 100_000)
    monkeypatch.setattr(settings, "USER_DAILY_CALLS", 300)
    rid = _make_request(client, "Under Budget U")
    _add_billed_call(rid, tokens=500)
    reset_budget_cache()
    assert budget_exhausted("Under Budget U") is False


def test_token_cap_exhausts(client, monkeypatch):
    reset_budget_cache()
    monkeypatch.setattr(settings, "USER_DAILY_TOKENS", 100)
    monkeypatch.setattr(settings, "USER_DAILY_CALLS", 0)  # only the token axis
    rid = _make_request(client, "Token Cap U")
    _add_billed_call(rid, tokens=150)
    reset_budget_cache()
    assert budget_exhausted("Token Cap U") is True


def test_call_cap_exhausts(client, monkeypatch):
    reset_budget_cache()
    monkeypatch.setattr(settings, "USER_DAILY_TOKENS", 0)  # only the call axis
    monkeypatch.setattr(settings, "USER_DAILY_CALLS", 1)
    rid = _make_request(client, "Call Cap U")
    _add_billed_call(rid, tokens=0)  # one billed call, no tokens
    reset_budget_cache()
    assert budget_exhausted("Call Cap U") is True


def test_zero_caps_are_unlimited(client, monkeypatch):
    reset_budget_cache()
    monkeypatch.setattr(settings, "USER_DAILY_TOKENS", 0)
    monkeypatch.setattr(settings, "USER_DAILY_CALLS", 0)
    rid = _make_request(client, "Unlimited U")
    _add_billed_call(rid, tokens=10_000_000)
    reset_budget_cache()
    assert budget_exhausted("Unlimited U") is False


def test_budget_row_does_not_count_toward_usage(client, monkeypatch):
    """status="budget" markers ran scripted and cost nothing — they must not push
    a reporter further over the call cap (which would be self-perpetuating)."""
    reset_budget_cache()
    monkeypatch.setattr(settings, "USER_DAILY_TOKENS", 0)
    monkeypatch.setattr(settings, "USER_DAILY_CALLS", 2)
    rid = _make_request(client, "Marker U")
    _add_billed_call(rid, status="budget", kind="question")
    _add_billed_call(rid, status="budget", kind="summary")
    reset_budget_cache()
    assert budget_exhausted("Marker U") is False


def test_attribution_is_per_reporter(client, monkeypatch):
    """A reporter's spend never counts against a different reporter."""
    reset_budget_cache()
    monkeypatch.setattr(settings, "USER_DAILY_TOKENS", 100)
    monkeypatch.setattr(settings, "USER_DAILY_CALLS", 0)
    rid_a = _make_request(client, "Alice Attribution")
    _make_request(client, "Bob Attribution")
    _add_billed_call(rid_a, tokens=200)  # only Alice spends
    reset_budget_cache()
    assert budget_exhausted("Alice Attribution") is True
    assert budget_exhausted("Bob Attribution") is False


# ---------- the ~30s TTL memoization ----------

def test_verdict_is_memoized_within_ttl(client, monkeypatch):
    """Correctness over freshness: a stale ALLOW within the TTL is acceptable, so a
    polling user never hammers the aggregate."""
    reset_budget_cache()
    monkeypatch.setattr(settings, "USER_DAILY_TOKENS", 0)
    monkeypatch.setattr(settings, "USER_DAILY_CALLS", 1)
    rid = _make_request(client, "TTL User")
    # First call: under budget -> False, and that verdict is cached.
    assert budget_exhausted("TTL User") is False
    # Cross the cap, but stay within the TTL: the cached allow still stands.
    _add_billed_call(rid, tokens=0)
    assert budget_exhausted("TTL User") is False
    # Expiring the cache re-queries and now sees the reporter over budget.
    monkeypatch.setattr(brain_calls, "BUDGET_TTL_SECONDS", 0.0)
    assert budget_exhausted("TTL User") is True


# ---------- the mode gate ----------

def test_budget_degraded_only_on_billing_tiers(client, monkeypatch):
    reset_budget_cache()
    monkeypatch.setattr(settings, "USER_DAILY_TOKENS", 0)
    monkeypatch.setattr(settings, "USER_DAILY_CALLS", 1)
    rid = _make_request(client, "Mode Gate U")
    _add_billed_call(rid, tokens=0)
    reset_budget_cache()

    monkeypatch.setenv("FACTORY_BRAIN", "api")
    assert budget_degraded("Mode Gate U") is True
    reset_budget_cache()
    monkeypatch.setenv("FACTORY_BRAIN", "agent")
    assert budget_degraded("Mode Gate U") is True
    reset_budget_cache()
    monkeypatch.setenv("FACTORY_BRAIN", "scripted")
    # Scripted mode has no spend to cap — the budget is a no-op offline.
    assert budget_degraded("Mode Gate U") is False


# ---------- the kick-site degradation ----------

def test_over_budget_kick_uses_scripted_and_records_budget_row(client, monkeypatch):
    reset_budget_cache()
    monkeypatch.setenv("FACTORY_BRAIN", "api")
    monkeypatch.setattr(settings, "USER_DAILY_TOKENS", 0)
    monkeypatch.setattr(settings, "USER_DAILY_CALLS", 1)
    rid = _make_request(client, "Over Budget Kick", req_type="bug")
    _add_billed_call(rid, tokens=0, kind="classify")  # one billed call -> over cap
    reset_budget_cache()

    # The api brain must never be reached once the reporter is over budget.
    def _boom():
        raise AssertionError("get_brain() must not be called over budget")

    monkeypatch.setattr(interview_gen, "get_brain", _boom)

    interview_gen._generate(rid, 0)

    with SessionLocal() as db:
        r = db.get(Request, rid)
        # The scripted bug script's first question was served — interview still works.
        assert r.pending_question["question"] == "What did you expect to happen instead?"

    rows = _calls_for(rid)
    budget_rows = [c for c in rows if c.status == "budget" and c.kind == "question"]
    assert len(budget_rows) == 1
    marker = budget_rows[0]
    assert marker.tokens_in is None and marker.tokens_out is None  # no tokens
    assert marker.model == settings.QUESTION_MODEL  # which tier got throttled
    # No durable "question" generation claim was created — the claim was skipped.
    assert not any(
        c.kind == "question" and c.status in ("running", "ok") for c in rows
    )


def test_under_budget_kick_uses_the_real_brain(client, monkeypatch):
    reset_budget_cache()
    monkeypatch.setenv("FACTORY_BRAIN", "api")
    monkeypatch.setattr(settings, "USER_DAILY_TOKENS", 100_000)
    monkeypatch.setattr(settings, "USER_DAILY_CALLS", 300)
    rid = _make_request(client, "Under Budget Kick", req_type="bug")
    reset_budget_cache()

    calls = {"n": 0}

    class _FakeBrain:
        def next_question(self, req):
            calls["n"] += 1
            return Question(question="FAKE api question")

    monkeypatch.setattr(interview_gen, "get_brain", lambda: _FakeBrain())

    interview_gen._generate(rid, 0)

    assert calls["n"] == 1  # the real (api) brain ran
    with SessionLocal() as db:
        r = db.get(Request, rid)
        assert r.pending_question["question"] == "FAKE api question"
    rows = _calls_for(rid)
    assert not any(c.status == "budget" for c in rows)  # no throttle logged
    assert any(c.kind == "question" and c.status == "ok" for c in rows)  # a real claim


# ---------- the InterviewState surface ----------

def test_interview_state_exposes_budget_limited(client, monkeypatch):
    reset_budget_cache()
    monkeypatch.setenv("FACTORY_BRAIN", "api")
    monkeypatch.setattr(settings, "USER_DAILY_TOKENS", 0)
    monkeypatch.setattr(settings, "USER_DAILY_CALLS", 1)
    rid = _make_request(client, "Flag User", req_type="bug")

    with SessionLocal() as db:
        r = db.get(Request, rid)
        assert interview_state(db, r, generate=False).budget_limited is False

    _add_billed_call(rid, tokens=0)  # cross the call cap
    reset_budget_cache()

    with SessionLocal() as db:
        r = db.get(Request, rid)
        assert interview_state(db, r, generate=False).budget_limited is True


def test_record_budget_call_never_raises(monkeypatch):
    """Telemetry is best-effort — a write failure must not surface to the caller."""
    def _broken_session(*args, **kwargs):
        raise RuntimeError("db down")

    monkeypatch.setattr(brain_calls, "SessionLocal", _broken_session)
    # Must swallow the failure rather than break the (already degraded) interview.
    record_budget_call(request_id=1, kind="question", model="claude-sonnet-5")
