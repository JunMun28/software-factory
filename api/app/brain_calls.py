"""Durable intake-brain generation claims and cheap per-call telemetry."""

import hashlib
import json
import logging
import threading
from contextlib import contextmanager
from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from .db import SessionLocal
from .models import BrainCall, utcnow

log = logging.getLogger("factory.brain")
_active = threading.local()


def model_for_kind(kind: str) -> str:
    """Label a generation claim with the transport/model it is expected to use."""
    from . import settings
    from .agent_exec import agent_cli, brain_mode

    if brain_mode() == "api":
        return {
            "classify": settings.CLASSIFY_MODEL,
            "question": settings.QUESTION_MODEL,
            "summary": settings.SUMMARY_MODEL,
            "prototype": settings.API_PROTOTYPE_MODEL,
            "spec": settings.SPEC_MODEL,
        }.get(kind, "api")
    if brain_mode() == "agent":
        return f"cli:{agent_cli()}"
    return "scripted"


# NOTE(plan-008): the plan's readable key examples identify only a turn. Appending
# this digest preserves re-kick behavior when another prompt input changes in-place.
def prompt_fingerprint(request, *, extra=None) -> str:
    """Stable identity for every input that can change an intake prompt.

    The simple ``kind:request:turn`` prefix stays operator-readable; this suffix
    prevents a completed claim from suppressing legitimate regeneration when a
    type, request field, attachment, or prototype snapshot changes at the same turn.
    Provider output/cache fields are deliberately excluded.
    """
    payload = {
        "type": request.type,
        "app": request.app_name,
        "title": request.title,
        "description": request.description,
        "bug_where": request.bug_where,
        "reach": request.reach,
        "impact_metric": request.impact_metric,
        "impact_value": request.impact_value,
        "reopen_ceiling": request.reopen_ceiling,
        "turns": [
            {
                "question": turn.question,
                "answer": turn.answer,
                "skipped": turn.skipped,
            }
            for turn in request.turns
        ],
        "attachments": sorted(
            (attachment.filename, attachment.mime, attachment.kind, attachment.stored)
            for attachment in request.attachments
        ),
        "extra": extra,
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def claim_call(*, request_id: int | None, kind: str, dedup_key: str, model: str) -> int | None:
    """Insert-first idempotent generation claim.

    A live/successful row owns its globally namespaced key. A failed row is
    deleted and may be inserted again so the existing poll re-kick UX survives.
    """
    key = dedup_key.strip().lower()
    for _attempt in range(2):
        with SessionLocal() as db:
            row = BrainCall(
                request_id=request_id,
                kind=kind,
                dedup_key=key,
                model=model,
                status="running",
            )
            db.add(row)
            try:
                db.commit()
                return row.id
            except IntegrityError:
                db.rollback()
                existing = db.scalar(
                    select(BrainCall).where(BrainCall.dedup_key == key)
                )
                if existing is None or existing.status != "failed":
                    return None
                removed = db.execute(
                    delete(BrainCall).where(
                        BrainCall.id == existing.id,
                        BrainCall.status == "failed",
                    )
                )
                db.commit()
                if removed.rowcount != 1:
                    return None
    return None


def finish_call(call_id: int, *, success: bool) -> None:
    """Finish a generation claim after its authoritative state write."""
    with SessionLocal() as db:
        row = db.get(BrainCall, call_id)
        if row is None:
            return
        if success:
            if row.status != "fallback":
                row.status = "ok"
        else:
            row.status = "failed"
        row.finished_at = utcnow()
        db.commit()


@contextmanager
def active_call(call_id: int):
    """Let ApiBrain attach provider metrics to the generator's claim row."""
    previous = getattr(_active, "call_id", None)
    _active.call_id = call_id
    try:
        yield
    finally:
        _active.call_id = previous


@contextmanager
def independent_call():
    """Record a second provider attempt as its own telemetry row.

    Most API calls enrich the durable generation-claim row. A transport-level
    retry within that generation is still a distinct billed call, so it must not
    overwrite the first attempt's token and latency measurements.
    """
    previous = getattr(_active, "call_id", None)
    _active.call_id = None
    try:
        yield
    finally:
        _active.call_id = previous


def record_api_call(
    *,
    request_id: int | None,
    kind: str,
    model: str,
    status: str,
    tokens_in: int | None,
    tokens_out: int | None,
    ttft_ms: int | None,
    duration_ms: int | None,
    created_at: datetime,
) -> None:
    """Write provider telemetry without ever turning enrichment into a blocker."""
    try:
        active_id = getattr(_active, "call_id", None)
        with SessionLocal() as db:
            if active_id is not None:
                row = db.get(BrainCall, active_id)
                if row is None:
                    return
                row.model = model
                row.tokens_in = tokens_in
                row.tokens_out = tokens_out
                row.ttft_ms = ttft_ms
                row.duration_ms = duration_ms
                if status == "fallback":
                    row.status = "fallback"
            else:
                db.add(
                    BrainCall(
                        request_id=request_id,
                        kind=kind,
                        dedup_key=None,
                        model=model,
                        status=status,
                        tokens_in=tokens_in,
                        tokens_out=tokens_out,
                        ttft_ms=ttft_ms,
                        duration_ms=duration_ms,
                        created_at=created_at,
                        finished_at=utcnow(),
                    )
                )
            db.commit()
    except Exception:
        log.exception("could not record %s brain telemetry", kind)
