"""Shared helpers for all API routers (ADR 0007).

These are stateless utilities extracted from the create_app closure in main.py
so each domain router can import them without circular dependencies.

The pipeline seam (set_pipeline / pipeline) replaces the closure variable
`agent_pipeline`; create_app calls set_pipeline once at startup, and every
router that fires the runner calls pipeline() inside the endpoint body
(never at import time, so there is no startup-ordering hazard).
"""

import random
import re

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from .models import Request
from .schemas import ConflictOut, RequestDetail, RequestOut

# ---------- pipeline seam ----------
_pipeline = None


def set_pipeline(p) -> None:
    global _pipeline
    _pipeline = p


def pipeline():
    return _pipeline


# ---------- stateless ORM helpers ----------

def prospective_repo(r: Request) -> str:
    """The repo Approve will create for an app-less request — the ONE
    derivation shared by the gate event and the UI confirmation dialog,
    so the admin always confirms exactly the name that gets recorded.

    Slugged to a GitHub-safe name: lowercase, any run of disallowed characters
    collapsed to a single dash, separators stripped from both ends (also after
    the 30-char clamp), with an 'app' fallback. A title with a '/' or other
    punctuation must never produce a nested path or an empty/malformed name."""
    name = (r.new_app_name or r.title or "").lower()
    slug = re.sub(r"[^a-z0-9._-]+", "-", name).strip("-._")[:30].strip("-._")
    return f"micron/{slug or 'app'}"


def to_out(r: Request, model=RequestOut, **extra):
    d = model.model_validate(r, from_attributes=True)
    d.app_name = r.app_name
    d.app_key = r.app.key if r.app else None
    d.repo = r.app.repo if r.app else None
    d.prospective_repo = None if r.app else prospective_repo(r)
    for k, v in extra.items():
        setattr(d, k, v)
    return d


def conflict_response(r: Request, loss) -> RequestDetail | JSONResponse:
    """Map a transitions.Loss to ADR 0006 HTTP semantics: the winner's own replay
    is an idempotent 200; a known other winner is a structured ConflictOut 409;
    a consumed precondition with no decisive winner is a plain 409."""
    if loss.replay:
        return to_out(r, RequestDetail)
    if loss.winner is None:
        raise HTTPException(409, loss.detail)
    conflict = ConflictOut(
        detail=f"Already acted on by {loss.winner.actor}",
        acted_by=loss.winner.actor,
        acted_at=loss.winner.created_at,
        resulting_state=loss.resulting_state,
    )
    return JSONResponse(status_code=409, content=conflict.model_dump(mode="json"))


def get_request(db: Session, rid: int) -> Request:
    r = db.get(Request, rid)
    if not r:
        raise HTTPException(404, "Request not found")
    return r


def next_ref(db: Session, spread: int = 0) -> str:
    """The next REQ-nnnn. Read-then-write, so concurrent creates CAN pick the same
    number; `requests.ref` is UNIQUE, so the loser's insert fails and the caller retries.

    `spread` is what makes a retry converge. Without it every loser recomputes the
    identical number and collides again on the next pass — measured 2026-07-22, eight
    simultaneous creates produced two HTTP 500s because a single dead-on retry was no
    retry at all. Widening the window each attempt scatters the herd instead. Gaps in
    the sequence are fine: a ref identifies a request, it does not count them."""
    last = db.query(Request).order_by(Request.id.desc()).first()
    try:
        n = max(2045, int(last.ref.split("-")[1]) + 1) if last else 2045
    except (IndexError, ValueError):  # tolerate non-standard refs left by manual cleanup
        n = 2045 + last.id
    if spread:
        n += random.randint(0, spread)
    return f"REQ-{n}"
