import threading
import time

from app import interview
from app.db import SessionLocal
from app.models import Request
from app.routers import requests as requests_router


def _new_request(client, *, request_type: str = "new", description: str = "original") -> int:
    response = client.post(
        "/api/requests",
        json={"type": request_type, "title": "Classify me", "description": description},
    )
    assert response.status_code == 201
    return response.json()["id"]


def _wait_for_terminal(client, rid: int, *, timeout: float = 2.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/requests/{rid}/classify")
        assert response.status_code == 200
        body = response.json()
        if body["status"] != "pending":
            return body
        time.sleep(0.01)
    raise AssertionError("classification did not reach a terminal state")


def test_request_classification_returns_pending_then_persists_exact_result(client, monkeypatch):
    started = threading.Event()
    release = threading.Event()

    class BlockingBrain:
        def classify(self, description: str) -> dict:
            assert description == "source snapshot"
            started.set()
            assert release.wait(2), "test did not release the blocking brain"
            return {"type": "bug", "confidence": 0.87}

    monkeypatch.setattr(interview, "get_brain", lambda: BlockingBrain())
    rid = _new_request(client, request_type="enh", description="persisted original")

    try:
        response = client.post(
            "/api/requests/classify",
            json={"request_id": rid, "description": "source snapshot"},
        )
        assert response.status_code == 202
        assert response.json() == {"status": "pending", "type": None, "confidence": None}
        assert started.wait(1), "background classifier did not start"

        with SessionLocal() as db:
            request = db.get(Request, rid)
            assert request is not None
            pending = request.classification_result
            assert pending["status"] == "pending"
            assert pending["source_description"] == "source snapshot"
            assert isinstance(pending["generation_token"], str)
            assert pending["generation_token"]
            assert request.type == "enh"
    finally:
        release.set()

    assert _wait_for_terminal(client, rid) == {
        "status": "succeeded",
        "type": "bug",
        "confidence": 0.87,
    }
    # A genuinely fresh Session sees the durable result, and the worker never
    # overwrites the provisional/manual Request.type chosen by the UI.
    with SessionLocal() as db:
        request = db.get(Request, rid)
        assert request is not None
        assert request.classification_result == {
            "status": "succeeded",
            "source_description": "source snapshot",
            "type": "bug",
            "confidence": 0.87,
        }
        assert request.type == "enh"


def test_request_classification_failure_is_durable(client, monkeypatch):
    class FailingBrain:
        def classify(self, description: str) -> dict:
            raise RuntimeError("model unavailable")

    monkeypatch.setattr(interview, "get_brain", lambda: FailingBrain())
    rid = _new_request(client, request_type="other")

    response = client.post(
        "/api/requests/classify",
        json={"request_id": rid, "description": "ambiguous request"},
    )
    assert response.status_code == 202
    assert response.json()["status"] == "pending"
    assert _wait_for_terminal(client, rid) == {
        "status": "failed",
        "type": None,
        "confidence": None,
    }

    with SessionLocal() as db:
        request = db.get(Request, rid)
        assert request is not None
        assert request.classification_result == {
            "status": "failed",
            "source_description": "ambiguous request",
        }
        assert request.type == "other"


def test_pending_poll_restarts_classification_after_process_restart(client, monkeypatch):
    class ImmediateBrain:
        def classify(self, description: str) -> dict:
            assert description == "resume this"
            return {"type": "new", "confidence": 0.42}

    monkeypatch.setattr(interview, "get_brain", lambda: ImmediateBrain())
    rid = _new_request(client)
    with SessionLocal() as db:
        request = db.get(Request, rid)
        assert request is not None
        request.classification_result = {
            "status": "pending",
            "source_description": "resume this",
            "generation_token": "restart-generation-token",
        }
        db.commit()

    response = client.get(f"/api/requests/{rid}/classify")
    assert response.status_code == 200
    assert response.json()["status"] == "pending"
    assert _wait_for_terminal(client, rid) == {
        "status": "succeeded",
        "type": "new",
        "confidence": 0.42,
    }


def test_pending_poll_closes_read_session_before_restart(monkeypatch):
    events: list[str] = []

    class FakeDb:
        def get(self, model, rid):
            assert model is Request
            assert rid == 17
            return Request(
                id=rid,
                type="new",
                title="Classify me",
                description="resume this",
                classification_result={
                    "status": "pending",
                    "source_description": "resume this",
                },
            )

        def close(self):
            events.append("closed")

    def ensure_classification(rid: int):
        assert rid == 17
        events.append("ensure")

    monkeypatch.setattr(requests_router.classify_gen, "ensure_classification", ensure_classification)

    result = requests_router.get_classification(17, FakeDb())

    assert result.status == "pending"
    assert events == ["closed", "ensure"]


def test_poll_returns_404_for_unknown_or_never_kicked_request(client):
    assert client.get("/api/requests/999999999/classify").status_code == 404
    rid = _new_request(client)
    assert client.get(f"/api/requests/{rid}/classify").status_code == 404


def test_legacy_classification_is_immediate_deterministic_and_succeeded(client, monkeypatch):
    def agent_brain_must_not_run():
        raise AssertionError("legacy classification must not resolve the configured agent brain")

    monkeypatch.setattr(interview, "get_brain", agent_brain_must_not_run)
    response = client.post(
        "/api/requests/classify",
        json={"description": "the login page is broken"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "succeeded"
    assert body["type"] == "bug"
    assert 0.0 <= body["confidence"] <= 1.0


def test_legacy_empty_description_still_defaults_to_new(client):
    response = client.post("/api/requests/classify", json={"description": ""})

    assert response.status_code == 200
    assert response.json() == {
        "status": "succeeded",
        "type": "new",
        "confidence": 0.0,
    }
