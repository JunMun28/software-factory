"""Background pre-generation of the next intake interview question.

The per-question model call is slow (60-120s on a cold CLI). Instead of blocking
the HTTP handler on it, we generate the pending question on a background thread so
the wait overlaps the submitter's read/type time; the API reports `thinking` until
it lands and the client polls. A brain_calls dedup row is the durable generation
claim; the process-local registry remains only a fast path. WAL mode lets poll
reads proceed while the background thread commits (db.py).

`SYNC` (env FACTORY_INTERVIEW_PREGEN=sync) runs generation inline in the request
path instead — deterministic and thread-free, for tests and the smoke lifecycle.
"""
import logging
import os
import threading

from sqlalchemy import func, or_, select, update

from . import brain_streams
from .agent_brain import META_MARKER
from .brain_calls import (
    active_call,
    claim_call,
    finish_call,
    model_for_kind,
    prompt_fingerprint,
)
from .db import SessionLocal
from .interview import answered_count, get_brain, pending_payload, question_ceiling
from .models import InterviewTurn, Request

log = logging.getLogger("factory.interview")

SYNC = os.environ.get("FACTORY_INTERVIEW_PREGEN", "async").lower() == "sync"

_lock = threading.Lock()
_inflight: set[int] = set()  # process-local fast path; brain_calls is authoritative


def _answered_turn_count(rid: int):
    return (
        select(func.count(InterviewTurn.id))
        .where(
            InterviewTurn.request_id == rid,
            or_(InterviewTurn.answer.is_not(None), InterviewTurn.skipped),
        )
        .scalar_subquery()
    )


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
            type_at_start = r.type
            ceiling_at_start = r.reopen_ceiling
        call_id = claim_call(
            request_id=rid,
            kind="question",
            dedup_key=(
                f"question:{rid}:{answered_at_start}:{prompt_fingerprint(r)}"
            ),
            model=model_for_kind("question"),
        )
        if call_id is None:
            return
        relay = brain_streams.prose_relay("interview", rid, META_MARKER)
        with active_call(call_id):
            try:
                q = brain_streams.invoke_with_delta(
                    get_brain().next_question,
                    r,
                    on_delta=relay.feed,
                )
            finally:
                relay.finish()
        payload = pending_payload(q)
        with SessionLocal() as db:
            answered_now = _answered_turn_count(rid)
            ceiling_matches = (
                Request.reopen_ceiling.is_(None)
                if ceiling_at_start is None
                else Request.reopen_ceiling == ceiling_at_start
            )
            # NOTE(plan-008): one conditional write closes the old refresh/check
            # gap. A stale generation is normal work to discard, not an error.
            result = db.execute(
                update(Request)
                .where(
                    Request.id == rid,
                    Request.pending_question.is_(None),
                    answered_now == answered_at_start,
                    Request.type == type_at_start,
                    ceiling_matches,
                )
                .values(pending_question=payload)
                .execution_options(synchronize_session=False)
            )
            if result.rowcount == 1:
                db.commit()
            else:
                db.rollback()
        succeeded = True
    except Exception:
        log.exception("interview pre-generation failed for request %s", rid)
    finally:
        if call_id is not None:
            try:
                finish_call(call_id, success=succeeded)
            except Exception:
                log.exception("could not finish interview brain claim for request %s", rid)
        release(rid)
