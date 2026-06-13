"""Shared helpers for all API routers (ADR 0007).

These are stateless utilities extracted from the create_app closure in main.py
so each domain router can import them without circular dependencies.

The pipeline seam (set_pipeline / pipeline) replaces the closure variable
`claude_pipeline`; create_app calls set_pipeline once at startup, and every
router that fires the runner calls pipeline() inside the endpoint body
(never at import time, so there is no startup-ordering hazard).
"""

import re

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .models import Request
from .schemas import RequestOut

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


def get_request(db: Session, rid: int) -> Request:
    r = db.get(Request, rid)
    if not r:
        raise HTTPException(404, "Request not found")
    return r


def next_ref(db: Session) -> str:
    last = db.query(Request).order_by(Request.id.desc()).first()
    try:
        n = max(2045, int(last.ref.split("-")[1]) + 1) if last else 2045
    except (IndexError, ValueError):  # tolerate non-standard refs left by manual cleanup
        n = 2045 + last.id
    return f"REQ-{n}"
