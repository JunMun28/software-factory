"""Shared helpers for all API routers (ADR 0007).

These are stateless utilities extracted from the create_app closure in main.py
so each domain router can import them without circular dependencies.

The pipeline seam (set_pipeline / pipeline) replaces the closure variable
`claude_pipeline`; create_app calls set_pipeline once at startup, and every
router that fires the runner calls pipeline() inside the endpoint body
(never at import time, so there is no startup-ordering hazard).
"""

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

def to_out(r: Request, model=RequestOut, **extra):
    d = model.model_validate(r, from_attributes=True)
    d.app_name = r.app_name
    d.app_key = r.app.key if r.app else None
    d.repo = r.app.repo if r.app else None
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
