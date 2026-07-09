"""Background generation + caching of the Review-step summary.

Mirrors interview_gen: the summary model call is slow, so it runs on a background
thread and is cached on the request (Request.summary), keyed on the answered-turn
count so it refreshes whenever the interview grows ("Add more detail"). Single-worker
uvicorn (main.py) → an in-process lock is enough; nothing here survives a restart and
a dropped generation is re-kicked on the next read. SYNC mode (shared with
interview_gen) generates inline for tests and the smoke lifecycle.
"""
import logging
import threading

from .db import SessionLocal
from .interview import answered_count, get_brain
from .models import Request

log = logging.getLogger("factory.interview")

_lock = threading.Lock()
_inflight: set[int] = set()  # request ids with a summary generation running


def _fresh(r: Request) -> bool:
    """The cached summary is still current for this interview (same answered count)."""
    s = r.summary
    return isinstance(s, dict) and s.get("at_turns") == answered_count(r) and bool(s.get("overview"))


def cached(r: Request) -> dict | None:
    """The stored summary if it's still current, else None."""
    return r.summary if _fresh(r) else None


def _write(db, r: Request, expected_turns: int) -> None:
    """Run the (slow) brain call and persist the summary — unless the interview moved
    under us, in which case the next read regenerates against the newer answer count."""
    data = get_brain().summarize(r)
    db.refresh(r)
    if answered_count(r) != expected_turns:
        return
    r.summary = {**data, "at_turns": expected_turns}  # reassign (not mutate) so JSON persists
    db.commit()


def generate_sync(r: Request, db) -> dict:
    """Inline generation (SYNC / deterministic path): write and return the summary."""
    _write(db, r, answered_count(r))
    return r.summary or get_brain().summarize(r)


def ensure_summary(rid: int) -> bool:
    """Start generating the summary on a background thread unless a fresh one exists or a
    generation is already in flight. Returns True if a summary is being generated now."""
    with _lock:
        if rid in _inflight:
            return True
        _inflight.add(rid)
    started = False
    try:
        with SessionLocal() as db:
            r = db.get(Request, rid)
            if r is None or _fresh(r):
                return False
            expected = answered_count(r)
        threading.Thread(target=_generate, args=(rid, expected), daemon=True).start()
        started = True
        return True
    finally:
        if not started:
            with _lock:
                _inflight.discard(rid)


def _generate(rid: int, expected_turns: int) -> None:
    try:
        with SessionLocal() as db:
            r = db.get(Request, rid)
            if r is not None:
                _write(db, r, expected_turns)
    except Exception:
        log.exception("summary generation failed for request %s", rid)
    finally:
        with _lock:
            _inflight.discard(rid)
