"""Background generation + caching of the Review-step summary.

Mirrors interview_gen: the summary model call is slow, so it runs on a background
thread and is cached on the request (Request.summary), keyed on the answered-turn
count so it refreshes whenever the interview grows ("Add more detail"). brain_calls
is the durable dedup source; the process-local lock is only a fast path. SYNC mode
(shared with interview_gen) generates inline for tests and the smoke lifecycle.
"""
import logging
import threading

from . import settings
from .brain_calls import (
    active_call,
    claim_call,
    finish_call,
    model_for_kind,
    prompt_fingerprint,
)
from .db import SessionLocal
from .interview import ScriptedBrain, answered_count, get_brain
from .models import Request

log = logging.getLogger("factory.interview")

_lock = threading.Lock()
_inflight: set[int] = set()  # process-local fast path; brain_calls is authoritative


def _fresh(r: Request) -> bool:
    """The cached summary is still current for this interview (same answered count)."""
    s = r.summary
    return isinstance(s, dict) and s.get("at_turns") == answered_count(r) and bool(s.get("overview"))


def cached(r: Request) -> dict | None:
    """The stored summary if it's still current, else None."""
    return r.summary if _fresh(r) else None


def _write(db, r: Request, expected_turns: int) -> dict:
    """Run the (slow) brain call and persist the summary — unless the interview moved
    under us, in which case the next read regenerates against the newer answer count.
    The caller's request session is closed before the model call."""
    rid = r.id
    _ = r.app, r.turns, r.attachments
    db.close()
    call_id = claim_call(
        request_id=rid,
        kind="summary",
        dedup_key=f"summary:{rid}:{expected_turns}:{prompt_fingerprint(r)}",
        model=model_for_kind("summary"),
        stale_after_seconds=settings.INTERVIEW_TIMEOUT + 30,
    )
    if call_id is None:
        return ScriptedBrain().summarize(r)
    succeeded = False
    try:
        with active_call(call_id):
            data = get_brain().summarize(r)
        summary = {**data, "at_turns": expected_turns}
        with SessionLocal() as write_db:
            current = write_db.get(Request, rid)
            if current is None:
                succeeded = True
                return data
            if answered_count(current) != expected_turns:
                _ = current.app, current.turns, current.attachments
            else:
                # reassign (not mutate) so JSON persists
                current.summary = summary
                write_db.commit()
                succeeded = True
                return summary
        # The first result is stale. Generate once against the newer snapshot and
        # persist it if that snapshot remains current; otherwise the failed claim
        # stays reclaimable by the next read.
        finish_call(call_id, success=True)
        call_id = None
        current_turns = answered_count(current)
        current_fingerprint = prompt_fingerprint(current)
        retry_id = claim_call(
            request_id=rid,
            kind="summary",
            dedup_key=f"summary:{rid}:{current_turns}:{current_fingerprint}",
            model=model_for_kind("summary"),
            stale_after_seconds=settings.INTERVIEW_TIMEOUT + 30,
        )
        if retry_id is None:
            return ScriptedBrain().summarize(current)
        retry_succeeded = False
        try:
            with active_call(retry_id):
                data = get_brain().summarize(current)
            summary = {**data, "at_turns": current_turns}
            with SessionLocal() as retry_db:
                latest = retry_db.get(Request, rid)
                if latest is None:
                    retry_succeeded = True
                    return data
                _ = latest.app, latest.turns, latest.attachments
                if (
                    answered_count(latest) == current_turns
                    and prompt_fingerprint(latest) == current_fingerprint
                ):
                    latest.summary = summary
                    retry_db.commit()
                    retry_succeeded = True
                    return summary
            return data
        finally:
            finish_call(retry_id, success=retry_succeeded)
    finally:
        if call_id is not None:
            finish_call(call_id, success=succeeded)


def generate_sync(r: Request, db) -> dict:
    """Inline generation (SYNC / deterministic path): write and return the summary."""
    return _write(db, r, answered_count(r))


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
    call_id: int | None = None
    succeeded = False
    try:
        with SessionLocal() as db:
            r = db.get(Request, rid)
            if r is None:
                return
            # The detached brain input must carry every relationship used to build
            # prompts or attachment workdirs after this short snapshot session closes.
            _ = r.app, r.turns, r.attachments
        call_id = claim_call(
            request_id=rid,
            kind="summary",
            dedup_key=f"summary:{rid}:{expected_turns}:{prompt_fingerprint(r)}",
            model=model_for_kind("summary"),
            stale_after_seconds=settings.INTERVIEW_TIMEOUT + 30,
        )
        if call_id is None:
            return
        with active_call(call_id):
            data = get_brain().summarize(r)
        with SessionLocal() as db:
            r = db.get(Request, rid)
            if r is None or answered_count(r) != expected_turns:
                succeeded = True
                return
            r.summary = {**data, "at_turns": expected_turns}
            db.commit()
        succeeded = True
    except Exception:
        log.exception("summary generation failed for request %s", rid)
    finally:
        if call_id is not None:
            try:
                finish_call(call_id, success=succeeded)
            except Exception:
                log.exception("could not finish summary claim for request %s", rid)
        with _lock:
            _inflight.discard(rid)
