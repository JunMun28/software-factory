"""Background generation of the intake request classification.

The model call can take up to 120s on a cold CLI. Instead of blocking the HTTP
handler on it, we persist a pending result and classify on a background thread;
the client polls until the durable result lands. Single-worker uvicorn (see
main.py), so an in-process registry + lock is enough — nothing here survives a
restart, and a dropped generation is simply re-kicked on the next poll.

No database Session remains open during the slow model call. The worker snapshots
the source description, closes its Session, calls the brain, then reopens a fresh
Session and writes only if that exact pending classification is still current.
"""

import logging
import threading
import uuid

from . import interview
from .db import SessionLocal
from .models import Request

log = logging.getLogger("factory.classify")

_lock = threading.Lock()
_inflight: set[int] = set()  # request ids with a classification running


def acquire(rid: int) -> bool:
    """Claim the single classification slot for a request."""
    with _lock:
        if rid in _inflight:
            return False
        _inflight.add(rid)
        return True


def release(rid: int) -> None:
    with _lock:
        _inflight.discard(rid)


def kick(rid: int, description: str) -> bool:
    """Persist a new pending classification and start its background worker.

    Returns False when the request does not exist.
    """
    generation_token = uuid.uuid4().hex
    with _lock:
        with SessionLocal() as db:
            request = db.get(Request, rid)
            if request is None:
                return False
            request.classification_result = {
                "status": "pending",
                "source_description": description,
                "generation_token": generation_token,
            }
            db.commit()
    # ensure_classification() acquires _lock through acquire(); call it only after
    # the pending-write critical section has ended.
    ensure_classification(rid)
    return True


def ensure_classification(rid: int) -> bool:
    """Re-kick a durable pending classification unless one is already in flight."""
    if not acquire(rid):
        return True
    started = False
    try:
        with _lock:
            with SessionLocal() as db:
                request = db.get(Request, rid)
                result = request.classification_result if request is not None else None
                if not result or result.get("status") != "pending":
                    return False
                description = str(result.get("source_description") or "")
                generation_token = result.get("generation_token")
                if not isinstance(generation_token, str) or not generation_token:
                    # A pending row created by an older process can still be resumed
                    # safely after deployment by assigning its generation identity here.
                    generation_token = uuid.uuid4().hex
                    request.classification_result = {
                        **result,
                        "generation_token": generation_token,
                    }
                    db.commit()
        threading.Thread(
            target=_generate,
            args=(rid, description, generation_token),
            daemon=True,
        ).start()
        started = True
        return True
    finally:
        if not started:
            release(rid)


def _generate(rid: int, source_description: str, generation_token: str) -> None:
    """Run the slow brain call with no open Session, then persist if still current."""
    try:
        try:
            classification = interview.get_brain().classify(source_description)
            result = {
                "status": "succeeded",
                "source_description": source_description,
                "type": classification["type"],
                "confidence": classification["confidence"],
            }
        except Exception:
            log.exception("classification failed for request %s", rid)
            result = {
                "status": "failed",
                "source_description": source_description,
            }

        with _lock:
            with SessionLocal() as db:
                request = db.get(Request, rid)
                current = request.classification_result if request is not None else None
                if (
                    not current
                    or current.get("status") != "pending"
                    or current.get("source_description") != source_description
                    or current.get("generation_token") != generation_token
                ):
                    return
                request.classification_result = result
                db.commit()
    except Exception:
        log.exception("could not persist classification for request %s", rid)
    finally:
        release(rid)
