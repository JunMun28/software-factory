from fastapi.testclient import TestClient

from app.main import app


def test_factory_health_alias() -> None:
    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_items_endpoint() -> None:
    with TestClient(app) as client:
        response = client.get("/api/items")

    assert response.status_code == 200
    items = response.json()
    assert isinstance(items, list)
    assert items
    assert all(
        isinstance(item.get("id"), int)
        and isinstance(item.get("name"), str)
        and bool(item["name"].strip())
        and isinstance(item.get("description"), str)
        and bool(item["description"].strip())
        for item in items
    )
