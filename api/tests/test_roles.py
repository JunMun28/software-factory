"""Operator roles (console gap #4): the wall is server-side.

admin = may decide gates and roll back deploys; viewer = read-only. Entra auth
will later resolve onto the same operator row + role; until then the picker is
honest about who may act, and the API refuses viewers regardless of UI."""
from helpers import submitted_request

from app import settings
from app.db import SessionLocal
from app.models import Operator


def _viewer_id() -> int:
    with SessionLocal() as db:
        viewer = db.query(Operator).filter(Operator.email == "viewer@test.local").first()
        if not viewer:
            viewer = Operator(name="Vic Viewer", initials="VV", hue="#888888",
                              email="viewer@test.local", role="viewer")
            db.add(viewer)
            db.commit()
            db.refresh(viewer)
        return viewer.id


def test_operators_expose_their_role(client):
    _viewer_id()
    roles = {o["email"]: o["role"] for o in client.get("/api/operators").json()}
    assert roles["viewer@test.local"] == "viewer"
    # seeded operators default to admin — nothing regresses to read-only silently
    assert all(role == "admin" for email, role in roles.items() if email != "viewer@test.local")


def test_viewer_cannot_approve_a_gate(client):
    r = submitted_request(client, title="Roles fixture: viewer denied")
    resp = client.post(f"/api/requests/{r['id']}/approve", json={"operator_id": _viewer_id()})
    assert resp.status_code == 403
    assert "viewer" in resp.json()["detail"]
    # the request is untouched — still parked at the spec gate
    detail = client.get(f"/api/requests/{r['id']}").json()
    assert detail["gate"] == "approve_spec"


def test_viewer_cannot_roll_back(client, monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "REGISTRY", "sf-registry:5000")
    monkeypatch.setattr(settings, "APP_DEPLOY", True)
    app_id = client.get("/api/apps").json()[0]["id"]
    resp = client.post(f"/api/apps/{app_id}/rollback",
                       json={"digest": "sha256:" + "c" * 64, "operator_id": _viewer_id()})
    assert resp.status_code == 403


def test_created_operators_can_be_viewers(client):
    resp = client.post("/api/operators", json={
        "name": "Read Only", "initials": "RO", "hue": "#336699",
        "email": "ro@test.local", "role": "viewer",
    })
    assert resp.status_code == 201
    assert resp.json()["role"] == "viewer"
