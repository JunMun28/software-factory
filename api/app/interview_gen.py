"""Background pre-generation of the next intake interview question.

The per-question model call is slow (60-120s on a cold CLI). Instead of blocking
the HTTP handler on it, we generate the pending question on a background thread so
the wait overlaps the submitter's read/type time; the API reports `thinking` until
it lands and the client polls. Single-worker uvicorn (see main.py), so an
in-process registry + lock is enough — nothing here survives a restart, and a
dropped generation is simply re-kicked on the next poll. WAL mode lets these poll
reads proceed while the background thread commits (db.py).

`SYNC` (env FACTORY_INTERVIEW_PREGEN=sync) runs generation inline in the request
path instead — deterministic and thread-free, for tests and the smoke lifecycle.
"""
import logging
import os
import threading

from .db import SessionLocal
from .interview import answered_count, get_brain, pending_payload, question_ceiling
from .models import Request

log = logging.getLogger("factory.interview")

SYNC = os.environ.get("FACTORY_INTERVIEW_PREGEN", "async").lower() == "sync"

_lock = threading.Lock()
_inflight: set[int] = set()  # request ids with a generation running


def acquire(rid: int) -> bool:
    """Claim the single generation slot for a request; False if one is already in
    flight. The SSE stream and the background pre-gen share this slot so a request
    is never generated twice concurrently."""
    with _lock:
        if rid in _inflight:
            return False
        _inflight.add(rid)
        return True


def release(rid: int) -> None:
    with _lock:
        _inflight.discard(rid)


def ensure_next_question(rid: int) -> bool:
    """Start generating the request's next question on a background thread unless one
    is already pending or in flight. Returns True if generation is now in flight
    (the caller should report `thinking`)."""
    if not acquire(rid):
        return True
    started = False
    try:
        with SessionLocal() as db:
            r = db.get(Request, rid)
            if r is None or r.pending_question is not None or answered_count(r) >= question_ceiling(r):
                return False
            answered_at_start = answered_count(r)
        threading.Thread(target=_generate, args=(rid, answered_at_start), daemon=True).start()
        started = True
        return True
    finally:
        if not started:
            release(rid)


def _generate(rid: int, answered_at_start: int) -> None:
    """Run the (slow) brain call and persist the next question — unless the state
    moved under us. Runs on a background thread; own DB session."""
    try:
        with SessionLocal() as db:
            r = db.get(Request, rid)
            if r is None:
                return
            payload = pending_payload(get_brain().next_question(r))  # the slow model call
            db.refresh(r)
            # never clobber newer state: the submitter may have advanced a turn, or a
            # racing generation may already have written the pending question
            if answered_count(r) != answered_at_start or r.pending_question is not None:
                return
            r.pending_question = payload
            db.commit()
    except Exception:
        log.exception("interview pre-generation failed for request %s", rid)
    finally:
        release(rid)
