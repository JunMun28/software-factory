"""Background generation of the intake Prototype step (new-app only).

Mirrors interview_gen / summary_gen: a prototype revision is a slow model call (a full
hi-fi HTML document), so it runs on a background thread and the API reports `thinking`
until the new revision lands. Single-worker uvicorn → an in-process lock is enough;
nothing here survives a restart and a dropped generation is re-kicked on the next
read/stream. SYNC (shared with interview_gen) resolves inline for tests and the smoke
lifecycle.

A "pending" PrototypeTurn (mode='pending', html=None) marks work owed: the auto first
draft (instruction=None) or a user edit instruction. Resolving it calls the brain and
fills the turn's mode/note/html, updating the Request's denormalized prototype_html/status
cache (current prototype = latest turn with non-null html).
"""
import logging
import threading

from sqlalchemy import func, select

from .db import SessionLocal
from .interview import get_brain
from .interview_gen import SYNC
from .models import PrototypeTurn, Request

log = logging.getLogger("factory.prototype")

_lock = threading.Lock()
_inflight: set[int] = set()  # request ids with a revision generation running
_seed_lock = threading.Lock()  # serializes the first-draft seed so it's created exactly once


def acquire(rid: int) -> bool:
    """Claim the single generation slot for a request; False if one is already in flight.
    The SSE stream worker and the background resolver share this slot."""
    with _lock:
        if rid in _inflight:
            return False
        _inflight.add(rid)
        return True


def release(rid: int) -> None:
    with _lock:
        _inflight.discard(rid)


def pending_turn(r: Request) -> PrototypeTurn | None:
    """The oldest unresolved turn (a revision is still owed), if any. Oldest-first so a queued
    first draft resolves before a follow-up edit (the edit then sees the drafted html)."""
    return next((t for t in r.prototype_turns if t.mode == "pending"), None)


def is_thinking(r: Request) -> bool:
    """A pending turn exists → a revision is (or should be) generating; the client polls/streams."""
    return pending_turn(r) is not None


def seed_first_draft(db, r: Request) -> None:
    """On first entry to the step (no turns yet, not skipped), seed the auto first-draft
    pending turn so there is always something to generate and react to (design D4).
    Prototype is new-app only — never seed for other request types. Serialized under
    `_seed_lock` with a fresh DB count re-check, so two concurrent callers (a poll `?gen=`
    racing the SSE worker) can't both seed a first-draft turn."""
    if r.type != "new" or r.prototype_status == "skipped":
        return
    if r.prototype_turns or r.prototype_html is not None:
        return  # clearly already seeded — no lock needed
    with _seed_lock:
        n = db.scalar(select(func.count(PrototypeTurn.id)).where(PrototypeTurn.request_id == r.id))
        if n:  # another caller seeded (or a turn exists) while we waited — bail
            db.refresh(r)
            return
        db.add(PrototypeTurn(request=r, order=0, instruction=None, mode="pending"))
        db.commit()
        db.refresh(r)


def apply_revision(db, r: Request, turn: PrototypeTurn, rev: dict) -> None:
    """Write the brain's result onto a pending turn and refresh the Request cache. A revision
    with html advances status none→draft (first) or →edited; a chat turn changes neither."""
    turn.mode = rev.get("mode") or "rewrite"
    turn.note = rev.get("note")
    turn.html = rev.get("html")
    if turn.html:
        r.prototype_html = turn.html
        r.prototype_status = "draft" if r.prototype_status == "none" else "edited"
    db.commit()


def _persist_revision(
    rid: int,
    turn_id: int,
    prototype_status: str,
    current_html: str | None,
    rev: dict,
) -> None:
    """Apply a generated revision only while its complete input snapshot is current."""
    with SessionLocal() as db:
        r = db.get(Request, rid)
        turn = db.get(PrototypeTurn, turn_id)
        oldest_pending = pending_turn(r) if r is not None else None
        # NOTE(plan-008): The approved plan says to preserve an existing
        # don't-clobber guard, but this path did not have one. Re-check the request
        # snapshot and original oldest pending turn so skip, restore, or a newer
        # resolution always wins.
        if (
            r is None
            or turn is None
            or turn.request_id != rid
            or turn.mode != "pending"
            or oldest_pending is None
            or oldest_pending.id != turn_id
            or r.prototype_status != prototype_status
            or r.prototype_html != current_html
        ):
            return
        apply_revision(db, r, turn, rev)


def _resolve_sync(db, r: Request) -> None:
    """Resolve the pending turn inline under the single generation slot (SYNC / poll fallback)."""
    if acquire(r.id):
        try:
            db.refresh(r)
            _ = r.app, r.turns, r.attachments
            turn = pending_turn(r)
            if turn is not None:
                rid = r.id
                turn_id = turn.id
                instruction = turn.instruction
                annotation = turn.annotation
                current_html = r.prototype_html
                prototype_status = r.prototype_status
                db.close()
                rev = get_brain().generate_prototype(
                    r,
                    instruction=instruction,
                    annotation=annotation,
                    current_html=current_html,
                )
                _persist_revision(rid, turn_id, prototype_status, current_html, rev)
        finally:
            release(r.id)


def ensure(db, r: Request) -> bool:
    """Seed a first draft if needed, then resolve any pending turn. Returns True if a revision is
    being generated in the background now (report `thinking`). SYNC resolves inline → False. Used
    by the GET poll path — the SSE stream is the streaming alternative (see queue_or_resolve)."""
    if r.prototype_status == "skipped":
        return False
    seed_first_draft(db, r)
    if pending_turn(r) is None:
        return False
    if SYNC:
        _resolve_sync(db, r)
        return False
    return _kick(r.id)


def queue_or_resolve(db, r: Request) -> bool:
    """After a POST records a pending edit turn: SYNC resolves inline (tests/smoke); async leaves
    the turn for the SSE stream to generate (so the edit's prose streams) and reports `thinking`."""
    if pending_turn(r) is None:
        return False
    if SYNC:
        _resolve_sync(db, r)
        return False
    return True  # a pending turn awaits the stream


def _kick(rid: int) -> bool:
    """Start background resolution of the pending turn unless one is already in flight."""
    if not acquire(rid):
        return True
    started = False
    try:
        with SessionLocal() as db:
            r = db.get(Request, rid)
            if r is None or pending_turn(r) is None:
                return False
        threading.Thread(target=_generate, args=(rid,), daemon=True).start()
        started = True
        return True
    finally:
        if not started:
            release(rid)


def _generate(rid: int) -> None:
    try:
        with SessionLocal() as db:
            r = db.get(Request, rid)
            if r is None:
                return
            # The detached brain input must carry every relationship used to build
            # prompts or attachment workdirs after this short snapshot session closes.
            _ = r.app, r.turns, r.attachments
            turn = pending_turn(r)
            if turn is None:
                return
            turn_id = turn.id
            instruction = turn.instruction
            annotation = turn.annotation
            current_html = r.prototype_html
            prototype_status = r.prototype_status
        rev = get_brain().generate_prototype(
            r,
            instruction=instruction,
            annotation=annotation,
            current_html=current_html,
        )
        _persist_revision(rid, turn_id, prototype_status, current_html, rev)
    except Exception:
        log.exception("prototype generation failed for request %s", rid)
    finally:
        release(rid)
