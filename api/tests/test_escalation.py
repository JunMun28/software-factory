"""Consent-gated mid-interview escalation (ADR 0023).

The brain MAY propose a type change mid-interview; the UI pulses the chip and shows an
in-chat Accept/Decline. Accept PATCHes the type (lossless — the draft's other facts
persist) and continues; decline records and continues. Phase 5 fills the API-brain
proposal seam while the scripted fallback remains silent.

Uses the session-scoped `client` fixture from conftest.py (enters `with TestClient(app)`
so FastAPI lifespan/migrate runs and the tables exist) — NOT a bare module-level client.
"""


def _new_bug(client) -> int:
    return client.post("/api/requests", json={
        "type": "bug", "description": "the thing is broken", "title": "Broken thing",
    }).json()["id"]


def test_accepting_escalation_changes_the_type_losslessly(client):
    rid = _new_bug(client)
    # the draft accumulates real facts before the escalation lands
    client.patch(f"/api/requests/{rid}", json={"description": "actually build a new app"})
    r = client.post(f"/api/requests/{rid}/interview/escalate",
                    json={"accept": True, "to_type": "new"})
    assert r.status_code == 200
    detail = client.get(f"/api/requests/{rid}").json()
    assert detail["type"] == "new"
    # lossless: the description the submitter already gave survives the type change
    assert detail["description"] == "actually build a new app"


def test_declining_escalation_keeps_the_type(client):
    rid = _new_bug(client)
    r = client.post(f"/api/requests/{rid}/interview/escalate",
                    json={"accept": False, "to_type": "new"})
    assert r.status_code == 200
    detail = client.get(f"/api/requests/{rid}").json()
    assert detail["type"] == "bug"


def test_accepting_escalation_invalidates_the_cached_summary(client):
    """A type change reshapes the request, so the cached Review summary must be dropped."""
    rid = _new_bug(client)
    # warm the summary cache (SYNC mode generates + stores it inline)
    client.get(f"/api/requests/{rid}/summary")
    client.post(f"/api/requests/{rid}/interview/escalate", json={"accept": True, "to_type": "enh"})
    from app.db import SessionLocal
    from app.models import Request
    with SessionLocal() as db:
        assert db.get(Request, rid).summary is None


def test_scripted_brain_never_auto_proposes_an_escalation(client):
    """The generation is a seam: the offline brain surfaces no escalation on the state."""
    rid = _new_bug(client)
    st = client.get(f"/api/requests/{rid}/interview").json()
    assert st.get("escalation") is None


def test_team_proposal_is_cached_and_decline_hides_it(client, monkeypatch):
    from app.interview import ScriptedBrain
    from app.routers import requests as requests_router

    class ProposingBrain(ScriptedBrain):
        def __init__(self):
            self.proposal_calls = 0

        def propose_escalation(self, req):
            self.proposal_calls += 1
            return {
                "to_type": "other",
                "why": "Data Platform owns this request (queue DATA).",
            }

    brain = ProposingBrain()
    monkeypatch.setattr(requests_router, "get_brain", lambda: brain)
    rid = _new_bug(client)

    first = client.get(f"/api/requests/{rid}/interview").json()
    second = client.get(f"/api/requests/{rid}/interview").json()

    assert first["escalation"] == second["escalation"] == {
        "to_type": "other",
        "why": "Data Platform owns this request (queue DATA).",
    }
    assert brain.proposal_calls == 1

    declined = client.post(
        f"/api/requests/{rid}/interview/escalate",
        json={"accept": False, "to_type": "other"},
    ).json()
    after = client.get(f"/api/requests/{rid}/interview").json()

    assert declined["escalation"] is None
    assert after["escalation"] is None
    assert brain.proposal_calls == 1


def test_team_proposal_cache_does_not_advance_request_updated_at(client, monkeypatch):
    from app.db import SessionLocal
    from app.interview import ScriptedBrain
    from app.models import Request
    from app.routers import requests as requests_router

    class ProposingBrain(ScriptedBrain):
        def propose_escalation(self, req):
            return {
                "to_type": "other",
                "why": "Data Platform owns this request.",
            }

    rid = _new_bug(client)
    client.get(f"/api/requests/{rid}/interview")
    with SessionLocal() as db:
        before = db.get(Request, rid).updated_at

    monkeypatch.setattr(requests_router, "get_brain", lambda: ProposingBrain())
    client.get(f"/api/requests/{rid}/interview")

    with SessionLocal() as db:
        after = db.get(Request, rid).updated_at
    assert after == before


def test_concurrent_state_reads_deduplicate_team_check(client, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from app.db import SessionLocal
    from app.interview import ScriptedBrain
    from app.models import Request
    from app.routers import requests as requests_router

    started = threading.Event()
    release = threading.Event()

    class SlowBrain(ScriptedBrain):
        def __init__(self):
            self.proposal_calls = 0

        def propose_escalation(self, req):
            self.proposal_calls += 1
            started.set()
            assert release.wait(timeout=5)
            return {
                "to_type": "other",
                "why": "Data Platform owns this request.",
            }

    brain = SlowBrain()
    monkeypatch.setattr(requests_router, "get_brain", lambda: brain)
    rid = _new_bug(client)

    def read_state():
        with SessionLocal() as db:
            return requests_router._routing_proposal(db, db.get(Request, rid))

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(read_state)
        assert started.wait(timeout=5)
        second = pool.submit(read_state)
        second.result(timeout=5)
        release.set()
        first.result(timeout=5)

    assert brain.proposal_calls == 1


def test_failed_team_check_is_retried_instead_of_negative_cached(client, monkeypatch):
    from app.brain_calls import record_api_call
    from app.interview import ScriptedBrain
    from app.models import utcnow
    from app.routers import requests as requests_router

    class FlakyBrain(ScriptedBrain):
        def __init__(self):
            self.proposal_calls = 0

        def propose_escalation(self, req):
            self.proposal_calls += 1
            if self.proposal_calls == 1:
                record_api_call(
                    request_id=req.id,
                    kind="escalation",
                    model="claude-haiku-4-5",
                    status="fallback",
                    tokens_in=None,
                    tokens_out=None,
                    ttft_ms=None,
                    duration_ms=1,
                    tool_rounds=None,
                    created_at=utcnow(),
                )
                return None
            return {
                "to_type": "other",
                "why": "Data Platform owns this request.",
            }

    brain = FlakyBrain()
    monkeypatch.setattr(requests_router, "get_brain", lambda: brain)
    monkeypatch.setattr(requests_router.settings, "ESCALATION_RETRY_SECONDS", 0)
    rid = _new_bug(client)

    first = client.get(f"/api/requests/{rid}/interview").json()
    second = client.get(f"/api/requests/{rid}/interview").json()

    assert first["escalation"] is None
    assert second["escalation"] == {
        "to_type": "other",
        "why": "Data Platform owns this request.",
    }
    assert brain.proposal_calls == 2


def test_accepting_team_proposal_preserves_routing_evidence(client, monkeypatch):
    from app.db import SessionLocal
    from app.interview import ScriptedBrain
    from app.models import Request
    from app.routers import requests as requests_router

    class ProposingBrain(ScriptedBrain):
        def propose_escalation(self, req):
            return {
                "to_type": "other",
                "why": "Data Platform owns this request (queue DATA).",
            }

    monkeypatch.setattr(requests_router, "get_brain", lambda: ProposingBrain())
    rid = _new_bug(client)
    proposal = client.get(f"/api/requests/{rid}/interview").json()["escalation"]

    response = client.post(
        f"/api/requests/{rid}/interview/escalate",
        json={"accept": True, "to_type": proposal["to_type"]},
    )
    replay = client.post(
        f"/api/requests/{rid}/interview/escalate",
        json={"accept": True, "to_type": proposal["to_type"]},
    )

    assert response.status_code == 200
    assert replay.status_code == 200
    with SessionLocal() as db:
        request = db.get(Request, rid)
        assert request.type == "other"
        assert request.intake_escalation["accepted"] is True
        assert request.intake_escalation["proposal"] == proposal


def test_cached_proposal_rejects_mismatched_action(client, monkeypatch):
    from app.interview import ScriptedBrain
    from app.routers import requests as requests_router

    class ProposingBrain(ScriptedBrain):
        def propose_escalation(self, req):
            return {
                "to_type": "other",
                "why": "Data Platform owns this request.",
            }

    monkeypatch.setattr(requests_router, "get_brain", lambda: ProposingBrain())
    rid = _new_bug(client)
    client.get(f"/api/requests/{rid}/interview")

    response = client.post(
        f"/api/requests/{rid}/interview/escalate",
        json={"accept": True, "to_type": "new"},
    )

    assert response.status_code == 409
    assert client.get(f"/api/requests/{rid}").json()["type"] == "bug"


def test_declined_team_proposal_rejects_late_accept(client, monkeypatch):
    from app.interview import ScriptedBrain
    from app.routers import requests as requests_router

    class ProposingBrain(ScriptedBrain):
        def propose_escalation(self, req):
            return {
                "to_type": "other",
                "why": "Data Platform owns this request.",
            }

    monkeypatch.setattr(requests_router, "get_brain", lambda: ProposingBrain())
    rid = _new_bug(client)
    client.get(f"/api/requests/{rid}/interview")
    declined = client.post(
        f"/api/requests/{rid}/interview/escalate",
        json={"accept": False, "to_type": "other"},
    )

    late_accept = client.post(
        f"/api/requests/{rid}/interview/escalate",
        json={"accept": True, "to_type": "other"},
    )

    assert declined.status_code == 200
    assert late_accept.status_code == 409
    assert client.get(f"/api/requests/{rid}").json()["type"] == "bug"


def test_stale_team_check_can_run_again_if_fingerprint_returns(client, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from app.db import SessionLocal
    from app.interview import ScriptedBrain
    from app.models import Request
    from app.routers import requests as requests_router

    started = threading.Event()
    release = threading.Event()

    class SlowFirstBrain(ScriptedBrain):
        def __init__(self):
            self.proposal_calls = 0

        def propose_escalation(self, req):
            self.proposal_calls += 1
            if self.proposal_calls == 1:
                started.set()
                assert release.wait(timeout=5)
            return {
                "to_type": "other",
                "why": "Data Platform owns this request.",
            }

    brain = SlowFirstBrain()
    monkeypatch.setattr(requests_router, "get_brain", lambda: brain)
    monkeypatch.setattr(requests_router.settings, "ESCALATION_RETRY_SECONDS", 0)
    rid = _new_bug(client)
    original = "the thing is broken"

    def resolve():
        with SessionLocal() as db:
            return requests_router._routing_proposal(db, db.get(Request, rid))

    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(resolve)
        assert started.wait(timeout=5)
        client.patch(f"/api/requests/{rid}", json={"description": "changed facts"})
        release.set()
        assert first.result(timeout=5) is None

    client.patch(f"/api/requests/{rid}", json={"description": original})
    second = resolve()

    assert second == {
        "to_type": "other",
        "why": "Data Platform owns this request.",
    }
    assert brain.proposal_calls == 2


def test_async_mode_routing_check_never_runs_on_the_request_thread(client, monkeypatch):
    """Plan 008 rule: interview_state (a request-thread read) may only READ the
    routing cache in async mode; the provider call runs on a background worker."""
    import threading
    import time

    from app.db import SessionLocal
    from app.interview import ScriptedBrain
    from app.models import Request
    from app.routers import requests as requests_router

    reader_thread = threading.get_ident()
    called_on: list[int] = []
    done = threading.Event()

    class ThreadRecordingBrain(ScriptedBrain):
        def propose_escalation(self, req):
            called_on.append(threading.get_ident())
            done.set()
            return {"to_type": "other", "why": "Data Platform owns this request."}

    rid = _new_bug(client)
    # materialize the first question while still in SYNC mode so the async-mode
    # read below hits the ready-state (thinking=False) path deterministically
    client.get(f"/api/requests/{rid}/interview")

    monkeypatch.setattr(requests_router, "get_brain", lambda: ThreadRecordingBrain())
    monkeypatch.setattr(requests_router.interview_gen, "SYNC", False)

    with SessionLocal() as db:
        state = requests_router.interview_state(db, db.get(Request, rid), generate=False)

    # the request-thread read returns immediately with no proposal yet
    assert state.escalation is None
    assert done.wait(timeout=5)
    assert called_on and all(t != reader_thread for t in called_on)

    # the worker publishes; a later poll serves it from cache with no new call
    deadline = time.monotonic() + 5
    escalation = None
    while time.monotonic() < deadline and escalation is None:
        with SessionLocal() as db:
            escalation = requests_router.interview_state(
                db, db.get(Request, rid), generate=False
            ).escalation
        if escalation is None:
            time.sleep(0.05)
    assert escalation == {"to_type": "other", "why": "Data Platform owns this request."}
    assert len(called_on) == 1


def test_thinking_state_defers_optional_team_check(client, monkeypatch):
    from app.db import SessionLocal
    from app.interview import ScriptedBrain
    from app.models import Request
    from app.routers import requests as requests_router

    class CountingBrain(ScriptedBrain):
        def __init__(self):
            self.proposal_calls = 0

        def propose_escalation(self, req):
            self.proposal_calls += 1
            return None

    brain = CountingBrain()
    monkeypatch.setattr(requests_router, "get_brain", lambda: brain)
    rid = _new_bug(client)

    with SessionLocal() as db:
        state = requests_router.interview_state(
            db,
            db.get(Request, rid),
            generate=False,
        )

    assert state.thinking is True
    assert brain.proposal_calls == 0


def test_reclaimed_team_check_fences_the_abandoned_caller(client, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    from datetime import timedelta

    from sqlalchemy import select

    from app.db import SessionLocal
    from app.interview import ScriptedBrain
    from app.models import BrainCall, Request, utcnow
    from app.routers import requests as requests_router

    started = threading.Event()
    release = threading.Event()

    class OverlappingBrain(ScriptedBrain):
        def __init__(self):
            self.proposal_calls = 0

        def propose_escalation(self, req):
            self.proposal_calls += 1
            if self.proposal_calls == 1:
                started.set()
                assert release.wait(timeout=5)
                reason = "Data Platform first claimant."
            else:
                reason = "Data Platform replacement claimant."
            return {"to_type": "other", "why": reason}

    brain = OverlappingBrain()
    monkeypatch.setattr(requests_router, "get_brain", lambda: brain)
    rid = _new_bug(client)

    def resolve():
        with SessionLocal() as db:
            return requests_router._routing_proposal(db, db.get(Request, rid))

    with ThreadPoolExecutor(max_workers=1) as pool:
        abandoned = pool.submit(resolve)
        assert started.wait(timeout=5)
        with SessionLocal() as db:
            claim = db.scalar(
                select(BrainCall).where(
                    BrainCall.request_id == rid,
                    BrainCall.kind == "escalation",
                    BrainCall.status == "running",
                )
            )
            assert claim is not None
            claim.created_at = utcnow() - timedelta(seconds=60)
            db.commit()

        replacement = resolve()
        release.set()
        abandoned_result = abandoned.result(timeout=5)

    with SessionLocal() as db:
        cached = db.get(Request, rid).intake_escalation

    assert replacement == {
        "to_type": "other",
        "why": "Data Platform replacement claimant.",
    }
    assert abandoned_result is None
    assert cached["proposal"] == replacement
    assert brain.proposal_calls == 2


def test_post_claim_cache_hit_revalidates_live_request_facts(client, monkeypatch):
    from app.db import SessionLocal
    from app.interview import ScriptedBrain
    from app.models import Request
    from app.routers import requests as requests_router

    class CountingBrain(ScriptedBrain):
        def __init__(self):
            self.proposal_calls = 0

        def propose_escalation(self, req):
            self.proposal_calls += 1
            return None

    brain = CountingBrain()
    monkeypatch.setattr(requests_router, "get_brain", lambda: brain)
    original_claim = requests_router.claim_call

    def claim_then_change_facts(**kwargs):
        call_id = original_claim(**kwargs)
        fingerprint = kwargs["dedup_key"].rsplit(":", 1)[1]
        with SessionLocal() as db:
            request = db.get(Request, kwargs["request_id"])
            request.description = "facts changed after the claim"
            request.intake_escalation = {
                "fingerprint": fingerprint,
                "proposal": {
                    "to_type": "other",
                    "why": "Data Platform stale proposal.",
                },
                "declined": False,
                "accepted": False,
            }
            db.commit()
        return call_id

    monkeypatch.setattr(requests_router, "claim_call", claim_then_change_facts)
    rid = _new_bug(client)
    with SessionLocal() as db:
        result = requests_router._routing_proposal(db, db.get(Request, rid))

    assert result is None
    assert brain.proposal_calls == 0
