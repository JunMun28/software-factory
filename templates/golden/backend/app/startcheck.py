import sys

from fastapi.testclient import TestClient

from app.main import app


def main() -> int:
    with TestClient(app) as client:
        response = client.get("/api/health")
        if response.status_code != 200:
            print(f"Expected 200 from /api/health, got {response.status_code}")
            return 1
        if response.json() != {"status": "ok"}:
            print(f"Unexpected health payload: {response.json()}")
            return 1
    print("Start check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
