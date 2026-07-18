import sys
from typing import Any

from fastapi.testclient import TestClient

from app.main import app


def has_item_shape(item: Any) -> bool:
    return (
        isinstance(item, dict)
        and isinstance(item.get("id"), int)
        and isinstance(item.get("name"), str)
        and bool(item["name"].strip())
        and isinstance(item.get("description"), str)
        and bool(item["description"].strip())
    )


def main() -> int:
    with TestClient(app) as client:
        response = client.get("/api/items")

    if response.status_code != 200:
        print(f"Expected 200 from /api/items, got {response.status_code}")
        return 1

    payload = response.json()
    if not isinstance(payload, list) or not payload:
        print(f"Expected a non-empty items list, got: {payload!r}")
        return 1
    if not all(has_item_shape(item) for item in payload):
        print(f"Expected items with id, name, and description, got: {payload!r}")
        return 1

    print(f"Behavioral smoke passed ({len(payload)} items).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
