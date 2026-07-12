"""Consent-gated mid-interview escalation (ADR 0023).

The brain MAY propose a type change mid-interview; the UI pulses the chip and shows an
in-chat Accept/Decline. Accept PATCHes the type (lossless — the draft's other facts
persist) and continues; decline records and continues. These tests exercise the endpoint
directly (the auto-proposal generator is a deliberate None-returning seam).

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
