from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_classify_endpoint_returns_type_and_confidence():
    r = client.post("/api/requests/classify", json={"description": "the login page is broken"})
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "bug"
    assert 0.0 <= body["confidence"] <= 1.0


def test_classify_endpoint_empty_description_defaults_new():
    r = client.post("/api/requests/classify", json={"description": ""})
    assert r.status_code == 200
    assert r.json()["type"] == "new"
