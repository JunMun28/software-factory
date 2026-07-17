"""Entra ID bearer-token auth for the API (SEC-01; azure-entra-setup runbook).

Env-gated: FACTORY_AUTH=off (default) is a byte-for-byte no-op — dev, kind, and
CI need no tenant. FACTORY_AUTH=entra turns the wall on: every request except
GET /api/health and CORS preflight must carry a Bearer JWT issued by the tenant
(AZURE_TENANT_ID), validated against the tenant JWKS (signature, issuer,
audience, expiry). No client secret exists anywhere in this design — SPAs use
auth-code+PKCE and this API verifies with the tenant's PUBLIC keys.

Identity mapping (the models.py seam — Operator.email is unique and its
comment reserves exactly this): token email -> Operator row. The token's
`roles` claim (Entra app roles: admin/viewer/submitter, assigned per-user in
the portal) is the SOURCE OF TRUTH and is synced onto Operator.role at request
time, so every existing role check keeps working unchanged. A first-time
admin/viewer sign-in auto-provisions the Operator row — the Entra app-role
assignment IS the grant (only a tenant admin can assign roles), and it solves
the fresh-prod bootstrap where SEED_DEMO=0 leaves the operators table empty.
Submitter-only users get no Operator row: intake endpoints work with just a
valid token; operator actions 403.

When the wall is on, the authenticated identity OVERRIDES any operator_id in
a request body or path — the body value degrades to untrusted UI state. The
override lives in ONE place (effective_operator_id), consumed by the two
operator-resolution chokepoints in routers/operators.py.

Implemented as pure ASGI middleware (not BaseHTTPMiddleware) so the contextvar
set here is visible in the endpoint, including sync endpoints in the
threadpool — anyio copies the caller's context into worker threads.
"""
from __future__ import annotations

import logging
import threading
import time
from contextvars import ContextVar

import httpx
import jwt as pyjwt
from fastapi import HTTPException
from sqlalchemy import select
from starlette.responses import JSONResponse

from . import settings
from .db import SessionLocal
from .models import Operator

log = logging.getLogger("factory")

# The authenticated Operator id for THIS request; None = no operator identity
# (auth off, or a submitter-only token). Set by the middleware, read via
# effective_operator_id().
_current_operator_id: ContextVar[int | None] = ContextVar("sf_operator_id", default=None)

# liveness must stay probe-able, and the SPAs must be able to DISCOVER auth
# config (tenant + client ids — public identifiers) before they hold a token.
_OPEN_PATHS = {"/api/health", "/api/auth/config"}
_JWKS_TTL = 3600.0  # seconds; unknown-kid triggers one early refresh (key rotation)

# Deterministic avatar palette for auto-provisioned operators (schemas.py hue
# pattern #RRGGBB; seeds use the same purple-adjacent range).
_HUES = ["#7C5CFC", "#6E5A8A", "#2E7D6B", "#B0632E", "#3E6FA8", "#A84E6F"]


class AuthError(Exception):
    """Token missing, malformed, or failed validation — maps to 401."""


class _JwksCache:
    """Tenant signing keys, fetched lazily and cached for _JWKS_TTL. Thread-safe:
    the tick loop is single-threaded but uvicorn serves requests concurrently."""

    def __init__(self) -> None:
        self._keys: dict[str, object] = {}
        self._fetched_at = 0.0
        self._lock = threading.Lock()

    def signing_key(self, kid: str):
        with self._lock:
            stale = (time.monotonic() - self._fetched_at) > _JWKS_TTL
            if kid not in self._keys and (stale or not self._keys):
                self._refresh()
            key = self._keys.get(kid)
        if key is None:
            raise AuthError(f"unknown signing key {kid[:12]}")
        return key

    def _refresh(self) -> None:
        url = settings.AUTH_JWKS_URL
        if not url:
            raise AuthError("FACTORY_AUTH=entra but AZURE_TENANT_ID is not configured")
        try:
            data = fetch_jwks(url)
        except Exception as exc:  # network/JSON failure -> 401, never a crash
            raise AuthError(f"JWKS fetch failed: {exc}") from exc
        keys = {}
        for entry in data.get("keys", []):
            if entry.get("kid"):
                keys[entry["kid"]] = pyjwt.PyJWK(entry).key
        self._keys = keys
        self._fetched_at = time.monotonic()


def fetch_jwks(url: str) -> dict:
    """Module-level seam so tests can point validation at a locally generated
    keyset without a network."""
    response = httpx.get(url, timeout=10)
    response.raise_for_status()
    return response.json()


_jwks = _JwksCache()


def validate_token(token: str) -> dict:
    """Full validation: RS256 signature against the tenant JWKS + issuer +
    audience + expiry, all required. Returns the claims dict."""
    try:
        kid = pyjwt.get_unverified_header(token).get("kid", "")
    except pyjwt.InvalidTokenError as exc:
        raise AuthError(f"malformed token: {exc}") from exc
    key = _jwks.signing_key(kid)
    try:
        return pyjwt.decode(
            token,
            key=key,
            algorithms=["RS256"],
            audience=settings.AZURE_API_AUDIENCE,
            issuer=settings.AUTH_ISSUER,
            options={"require": ["exp", "iss", "aud"]},
        )
    except pyjwt.InvalidTokenError as exc:
        raise AuthError(f"token rejected: {exc}") from exc


def _claim_email(claims: dict) -> str:
    return (claims.get("preferred_username") or claims.get("email") or "").strip().lower()


def _claim_role(claims: dict) -> str | None:
    """Console role from the token's app roles; admin outranks viewer.
    submitter alone confers no operator identity."""
    roles = set(claims.get("roles") or [])
    if "admin" in roles:
        return "admin"
    if "viewer" in roles:
        return "viewer"
    return None


def _initials(name: str, email: str) -> str:
    parts = [w for w in name.split() if w]
    if parts:
        return "".join(w[0] for w in parts[:4]).upper()
    return email[:2].upper() or "??"


def _resolve_operator(claims: dict) -> int | None:
    """Map validated claims onto the Operator table: sync role, auto-provision
    first-seen admins/viewers. Returns the operator id, or None for
    submitter-only tokens (valid caller, no console identity)."""
    email = _claim_email(claims)
    role = _claim_role(claims)
    if not email:
        return None
    with SessionLocal() as db:
        operator = db.scalar(select(Operator).where(Operator.email == email))
        if operator is None:
            if role is None:
                return None  # submitter-only: no row, intake still works
            name = (claims.get("name") or email.split("@")[0]).strip()
            operator = Operator(
                name=name,
                initials=_initials(name, email),
                hue=_HUES[hash(email) % len(_HUES)],
                email=email,
                role=role,
            )
            db.add(operator)
            db.commit()
            db.refresh(operator)
            log.info("auth: auto-provisioned operator %s (%s) as %s", name, email, role)
            return operator.id
        if role is not None and operator.role != role:
            # Entra is the source of truth; keep the row in step so every
            # existing role check (require_approver) stays correct.
            operator.role = role
            db.commit()
        return operator.id


def current_operator_id() -> int | None:
    """The authenticated Operator id for this request, or None (auth off, or a
    submitter-only token). For /api/auth/me and any read-only identity use."""
    return _current_operator_id.get()


def effective_operator_id(fallback: int | None) -> int | None:
    """THE override seam. Auth off -> the caller-supplied id (today's
    behavior). Auth on -> the authenticated identity, always; a token with no
    operator role may not perform operator actions."""
    if settings.auth_mode() != "entra":
        return fallback
    operator_id = _current_operator_id.get()
    if operator_id is None:
        raise HTTPException(403, "Your account has no console role — ask an admin to assign one")
    return operator_id


class EntraAuthMiddleware:
    """Pure ASGI wall. Sits INSIDE CORSMiddleware (added earlier in create_app,
    hence outermost) so preflight is answered by CORS; OPTIONS is skipped here
    as belt and braces."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or settings.auth_mode() != "entra":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        if scope.get("method") == "OPTIONS" or path in _OPEN_PATHS:
            await self.app(scope, receive, send)
            return

        token = ""
        for name, value in scope.get("headers", []):
            if name == b"authorization":
                header = value.decode("latin-1")
                if header.lower().startswith("bearer "):
                    token = header[7:].strip()
                break
        if not token:
            await self._reject(scope, receive, send, "Missing bearer token")
            return
        try:
            claims = validate_token(token)
        except AuthError as exc:
            await self._reject(scope, receive, send, str(exc))
            return

        reset = _current_operator_id.set(_resolve_operator(claims))
        try:
            await self.app(scope, receive, send)
        finally:
            _current_operator_id.reset(reset)

    @staticmethod
    async def _reject(scope, receive, send, detail: str) -> None:
        response = JSONResponse(
            {"detail": detail}, status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        )
        await response(scope, receive, send)
