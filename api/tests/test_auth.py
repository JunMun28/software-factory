"""SEC-01 Entra auth wall — fake JWKS + self-signed RS256 tokens, no network.

Proves the four contracts:
1. FACTORY_AUTH=off (default) is byte-for-byte today's open behavior.
2. entra: no/bad token -> 401; /api/health and CORS preflight stay open.
3. Valid token -> Operator resolution: email->row, role synced from the roles
   claim, first-seen admin auto-provisioned, submitter-only gets no identity.
4. The token identity OVERRIDES client-sent operator ids (body, path, audit).
"""
import time

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from sqlalchemy import select

import app.auth as auth
from app import settings
from app.db import SessionLocal
from app.models import Operator, OperatorAppMute

KID = "test-key-1"
ISSUER = "https://login.microsoftonline.com/test-tenant/v2.0"
ISSUER_V1 = "https://sts.windows.net/test-tenant/"
AUDIENCE = "api://test-audience"
CLIENT_ID_AUD = "test-audience"  # v2 tokens carry the bare client id as aud

_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _jwks() -> dict:
    import json

    jwk = json.loads(pyjwt.algorithms.RSAAlgorithm.to_jwk(_private_key.public_key()))
    jwk["kid"] = KID
    return {"keys": [jwk]}


def mint(email: str, roles: list[str], *, name: str = "Test User",
         kid: str = KID, issuer: str = ISSUER, audience: str = AUDIENCE,
         expired: bool = False, key=None) -> str:
    now = int(time.time())
    claims = {
        "iss": issuer,
        "aud": audience,
        "exp": now - 600 if expired else now + 600,
        "iat": now - 60,
        "preferred_username": email,
        "name": name,
        "roles": roles,
    }
    return pyjwt.encode(claims, key or _private_key, algorithm="RS256", headers={"kid": kid})


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def entra(monkeypatch):
    """Flip the wall on against a locally generated keyset."""
    monkeypatch.setenv("FACTORY_AUTH", "entra")
    monkeypatch.setattr(settings, "AUTH_ISSUER", ISSUER)
    monkeypatch.setattr(settings, "AUTH_ISSUER_V1", ISSUER_V1)
    monkeypatch.setattr(settings, "AZURE_API_AUDIENCE", AUDIENCE)
    monkeypatch.setattr(settings, "AZURE_API_CLIENT_ID", CLIENT_ID_AUD)
    monkeypatch.setattr(settings, "AUTH_JWKS_URL", "https://unit.test/jwks")
    monkeypatch.setattr(auth, "fetch_jwks", lambda url: _jwks())
    monkeypatch.setattr(auth, "_jwks", auth._JwksCache())  # no cross-test key cache


@pytest.fixture(autouse=True)
def _clean_auth_rows():
    """The suite shares one sqlite file — remove this module's operators (some
    are viewers, which test_roles.py's all-admins assertion would trip over),
    plus their mutes and the seeded test app."""
    yield
    from app.models import App

    with SessionLocal() as db:
        ops = db.scalars(
            select(Operator).where(Operator.email.like("%@example.com"))
        ).all()
        for op in ops:
            for mute in db.scalars(
                select(OperatorAppMute).where(OperatorAppMute.operator_id == op.id)
            ).all():
                db.delete(mute)
            db.delete(op)
        app_row = db.scalar(select(App).where(App.key == "auth-test-app"))
        if app_row is not None:
            db.delete(app_row)
        db.commit()


def _add_operator(email: str, role: str = "admin") -> int:
    with SessionLocal() as db:
        op = Operator(name=email.split("@")[0], initials="TT", hue="#7C5CFC",
                      email=email, role=role)
        db.add(op)
        db.commit()
        return op.id


# ---------- 1. the off-gate default ----------

def test_auth_off_default_keeps_api_open(client):
    assert client.get("/api/operators").status_code == 200


# ---------- 2. the wall ----------

def test_missing_token_is_401_with_challenge(client, entra):
    response = client.get("/api/operators")
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"


def test_health_stays_open_for_probes(client, entra):
    assert client.get("/api/health").status_code == 200


def test_cors_preflight_bypasses_the_wall(client, entra):
    response = client.options("/api/operators", headers={
        "Origin": "http://localhost:4202",
        "Access-Control-Request-Method": "GET",
    })
    assert response.status_code != 401


@pytest.mark.parametrize("bad", [
    "garbage-not-a-jwt",
    mint("x@y.z", ["admin"], audience="api://wrong-audience"),
    mint("x@y.z", ["admin"], issuer="https://evil.example/v2.0"),
    mint("x@y.z", ["admin"], expired=True),
    mint("x@y.z", ["admin"],
         key=rsa.generate_private_key(public_exponent=65537, key_size=2048)),
])
def test_invalid_tokens_are_401(client, entra, bad):
    assert client.get("/api/operators", headers=bearer(bad)).status_code == 401


def test_v1_format_token_is_accepted(client, entra):
    """Entra's DEFAULT for custom APIs (requestedAccessTokenVersion=null) issues
    v1 tokens: iss=sts.windows.net, aud=api://<id>, email claim instead of
    preferred_username. Found live 2026-07-18 — the wall must take them."""
    _add_operator("v1-token@example.com", role="admin")
    now = int(time.time())
    token = pyjwt.encode(
        {"iss": ISSUER_V1, "aud": AUDIENCE, "exp": now + 600, "iat": now - 60,
         "email": "v1-token@example.com", "name": "V One", "roles": ["admin"]},
        _private_key, algorithm="RS256", headers={"kid": KID},
    )
    body = client.get("/api/auth/me", headers=bearer(token)).json()
    assert body["operator"]["role"] == "admin"


def test_v2_format_token_with_guid_audience_is_accepted(client, entra):
    _add_operator("v2-token@example.com", role="admin")
    token = mint("v2-token@example.com", ["admin"], audience=CLIENT_ID_AUD)
    assert client.get("/api/auth/me", headers=bearer(token)).json()["operator"] is not None


# ---------- 3. identity mapping ----------

def test_known_email_resolves_and_syncs_role_from_token(client, entra):
    op_id = _add_operator("sync-me@example.com", role="admin")
    token = mint("sync-me@example.com", ["viewer"])  # Entra demoted this person
    assert client.get("/api/operators", headers=bearer(token)).status_code == 200
    with SessionLocal() as db:
        assert db.get(Operator, op_id).role == "viewer"


def test_first_seen_admin_is_auto_provisioned(client, entra):
    token = mint("brand-new@example.com", ["admin"], name="Brand New")
    assert client.get("/api/operators", headers=bearer(token)).status_code == 200
    with SessionLocal() as db:
        row = db.scalar(select(Operator).where(Operator.email == "brand-new@example.com"))
        assert row is not None and row.role == "admin" and row.name == "Brand New"


def test_submitter_only_token_gets_no_operator_row_but_may_read(client, entra):
    token = mint("submitter-only@example.com", ["submitter"])
    assert client.get("/api/operators", headers=bearer(token)).status_code == 200
    with SessionLocal() as db:
        assert db.scalar(
            select(Operator).where(Operator.email == "submitter-only@example.com")
        ) is None


def test_submitter_only_token_cannot_perform_operator_actions(client, entra):
    victim = _add_operator("victim@example.com")
    token = mint("submitter-only2@example.com", ["submitter"])
    response = client.get(f"/api/operators/{victim}/subscriptions", headers=bearer(token))
    assert response.status_code == 403


# ---------- discovery + identity endpoints ----------

def test_auth_config_reports_off_by_default(client):
    assert client.get("/api/auth/config").json() == {"mode": "off"}


def test_auth_config_is_open_and_serves_ids_when_entra(client, entra, monkeypatch):
    monkeypatch.setattr(settings, "AZURE_TENANT_ID", "test-tenant")
    monkeypatch.setattr(settings, "AZURE_CONSOLE_CLIENT_ID", "console-id")
    monkeypatch.setattr(settings, "AZURE_INTAKE_CLIENT_ID", "intake-id")
    body = client.get("/api/auth/config").json()  # NO token — must stay open
    assert body["mode"] == "entra"
    assert body["tenantId"] == "test-tenant"
    assert body["audience"] == AUDIENCE
    assert body["clientIds"] == {"console": "console-id", "intake": "intake-id"}


def test_auth_me_returns_the_token_operator(client, entra):
    _add_operator("who-am-i@example.com", role="admin")
    token = mint("who-am-i@example.com", ["admin"])
    body = client.get("/api/auth/me", headers=bearer(token)).json()
    assert body["mode"] == "entra"
    assert body["operator"]["role"] == "admin"
    assert body["operator"]["name"] == "who-am-i"


def test_auth_me_is_null_for_submitter_only(client, entra):
    token = mint("just-submits@example.com", ["submitter"])
    body = client.get("/api/auth/me", headers=bearer(token)).json()
    assert body["operator"] is None


# ---------- 4. the override ----------

def test_token_identity_overrides_the_path_id(client, entra):
    me = _add_operator("me@example.com", role="viewer")
    other = _add_operator("other@example.com", role="viewer")
    # seed an app to mute
    from app.models import App

    with SessionLocal() as db:
        app_row = App(key="auth-test-app", name="Auth Test App",
                      owner="Auth Tests", repo="git://auth-test")
        db.add(app_row)
        db.commit()
        app_id = app_row.id

    token = mint("me@example.com", ["viewer"])
    response = client.put(
        f"/api/operators/{other}/subscriptions/{app_id}",
        json={"subscribed": False},
        headers=bearer(token),
    )
    assert response.status_code == 200
    with SessionLocal() as db:
        assert db.get(OperatorAppMute, (me, app_id)) is not None, "mute must land on the TOKEN identity"
        assert db.get(OperatorAppMute, (other, app_id)) is None, "client-sent id must be ignored"


def test_create_request_reporter_comes_from_the_token(client, entra):
    """A submitter-only token (no operator row) creates a request; the reporter
    fields are stamped from the TOKEN, not the body."""
    token = mint("real-submitter@example.com", ["submitter"], name="Real Submitter")
    response = client.post("/api/requests", headers=bearer(token), json={
        "title": "Identity test", "description": "who am I really",
        "type": "new", "reporter": "Spoofed Name", "reporter_initials": "XX",
    })
    assert response.status_code == 201
    body = response.json()
    assert body["reporter"] == "Real Submitter"
    assert body["reporter_initials"] == "RS"


def test_create_request_keeps_body_reporter_when_auth_off(client):
    response = client.post("/api/requests", json={
        "title": "Off-mode test", "description": "demo user path",
        "type": "new", "reporter": "Demo User", "reporter_initials": "DU",
    })
    assert response.status_code == 201
    assert response.json()["reporter"] == "Demo User"


def test_require_approver_uses_token_identity_not_body(client, entra, monkeypatch):
    """The admin wall judges the AUTHENTICATED operator: a viewer naming an
    admin's id in the body still gets 403."""
    from app.routers.operators import require_approver

    admin = _add_operator("boss@example.com", role="admin")
    viewer = _add_operator("watcher@example.com", role="viewer")

    reset = auth._current_operator_id.set(viewer)
    try:
        with SessionLocal() as db:
            with pytest.raises(HTTPException) as excinfo:
                require_approver(db, admin)  # body names the admin — ignored
            assert excinfo.value.status_code == 403
    finally:
        auth._current_operator_id.reset(reset)

    reset = auth._current_operator_id.set(admin)
    try:
        with SessionLocal() as db:
            assert require_approver(db, 999999).id == admin  # bogus body id — ignored
    finally:
        auth._current_operator_id.reset(reset)
