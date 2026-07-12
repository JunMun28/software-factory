"""Event-feed, comments, and inbox endpoints (ADR 0007, ADR 0008, ADR 0012).

Routes:
  GET  /api/events                      — event log with optional subject/request filter
  GET  /api/events/cursor               — current high-water mark for new pollers
  GET  /api/subjects/{key}/feed         — channel feed (keyset cursor, newest-first initial load)
  GET  /api/requests/{rid}/comments     — comments for a request
  POST /api/requests/{rid}/comments     — post a comment
  GET  /api/inbox                       — requests needing human attention
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..api_helpers import get_request, to_out
from ..db import get_db
from ..events import emit
from ..models import App, AuditEvent, Comment, ProgressEvent, Request
from ..schemas import CommentIn, CommentOut, EventOut, FeedPage, RequestOut
from .operators import resolve_operator

router = APIRouter()

# Firehose guard (ADR 0014): step-level kinds render only in the per-request
# trace; the channel feed stays milestone-level so app surfaces stay calm.
TRACE_ONLY_KINDS = ("step_summary", "steer_note", "verification")


# ---------- shared helpers (events-local, no side-effects) ----------

def serialize_events(rows) -> list[EventOut]:
    """rows: (ProgressEvent, ref, title) tuples from a single joined query — no N+1."""
    out = []
    for ev, ref, title in rows:
        o = EventOut.model_validate(ev, from_attributes=True)
        o.request_ref, o.request_title = ref, title
        out.append(o)
    return out


def joined_events(db: Session):
    return (
        db.query(ProgressEvent, Request.ref, Request.title)
        .outerjoin(Request, ProgressEvent.request_id == Request.id)
    )


# ---------- the two-axis feed (keyset cursor, ADR 0008) ----------

@router.get("/api/events/cursor")
def events_cursor(db: Session = Depends(get_db)):
    """Where 'now' is. New clients start polling from here instead of
    replaying the whole event log from id 0 (ADR 0013)."""
    return {"cursor": db.query(func.max(ProgressEvent.id)).scalar() or 0}


@router.get("/api/events", response_model=list[EventOut])
def events(after: int = 0, subject: str | None = None, request_id: int | None = None,
           limit: int = 200, db: Session = Depends(get_db)):
    q = joined_events(db).filter(ProgressEvent.id > after)
    if subject:
        a = db.query(App).filter(App.key == subject).first()
        if not a:
            raise HTTPException(404, "Unknown app")
        q = q.filter(ProgressEvent.subject_id == a.id)
    if request_id:
        q = q.filter(ProgressEvent.request_id == request_id)
    rows = q.order_by(ProgressEvent.id).limit(min(limit, 500)).all()
    return serialize_events(rows)


@router.get("/api/subjects/{key}/feed", response_model=FeedPage)
def subject_feed(key: str, after: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    """The channel feed: with no cursor, the LATEST `limit` items (ascending);
    with ?after=, only newer items. The cursor is the max event id either way."""
    a = db.query(App).filter(App.key == key).first()
    if not a:
        raise HTTPException(404, "Unknown app")
    limit = min(limit, 300)
    base = (joined_events(db)
            .filter(ProgressEvent.subject_id == a.id)
            .filter(ProgressEvent.kind.notin_(TRACE_ONLY_KINDS)))
    if after > 0:
        rows = base.filter(ProgressEvent.id > after).order_by(ProgressEvent.id).limit(limit).all()
    else:
        rows = list(reversed(base.order_by(ProgressEvent.id.desc()).limit(limit).all()))
    items = serialize_events(rows)
    cursor = items[-1].id if items else after
    return FeedPage(items=items, cursor=cursor)


@router.get("/api/requests/{rid}/trace", response_model=FeedPage)
def request_trace(rid: int, after: int = 0, limit: int = 200, db: Session = Depends(get_db)):
    """The per-request trace (ADR 0014): with no cursor, the LATEST `limit`
    items (ascending); with ?after=, only newer. Same keyset shape as the
    subject feed, so the poll seam is identical."""
    get_request(db, rid)  # 404 before reading the log
    limit = min(limit, 500)
    base = joined_events(db).filter(ProgressEvent.request_id == rid)
    if after > 0:
        rows = base.filter(ProgressEvent.id > after).order_by(ProgressEvent.id).limit(limit).all()
    else:
        rows = list(reversed(base.order_by(ProgressEvent.id.desc()).limit(limit).all()))
    items = serialize_events(rows)
    cursor = items[-1].id if items else after
    return FeedPage(items=items, cursor=cursor)


# ---------- comments ----------

@router.post("/api/requests/{rid}/comments", response_model=CommentOut, status_code=201)
def add_comment(rid: int, body: CommentIn, db: Session = Depends(get_db)):
    r = get_request(db, rid)
    operator = resolve_operator(db, body.operator_id)
    c = Comment(request=r, author=operator.name, initials=operator.initials, color=operator.hue, body=body.body)
    db.add(c)
    db.add(AuditEvent(request_id=r.id, actor=operator.name, action="commented"))
    db.flush()  # assign the comment id before the event references it
    # the comment also rides the one progress_event rail (ADR 0012) so feeds
    # update through the same keyset cursor as every other entry
    emit(db, r, "comment", body.body[:300], actor=operator.name, bot=False,
         payload={"comment_id": c.id, "initials": operator.initials, "color": operator.hue, "body": body.body})
    db.commit()
    return c


@router.get("/api/requests/{rid}/comments", response_model=list[CommentOut])
def list_comments(rid: int, db: Session = Depends(get_db)):
    return get_request(db, rid).comments


# ---------- needs-me inbox ----------

@router.get("/api/inbox", response_model=list[RequestOut])
def inbox(db: Session = Depends(get_db)):
    rows = (
        db.query(Request)
        .filter(or_(Request.gate.isnot(None), Request.needs_human.is_(True)))
        .filter(Request.status.notin_(("cancelled", "done")))  # a stale gate never resurrects dead work
        .order_by(Request.needs_human.desc(), Request.created_at.desc())
        .all()
    )
    return [to_out(r) for r in rows]
