"""Intent log around external side effects (spec §3.3).

The caller composes ``begin()`` with ``cas_status()`` and progress events in
one transaction, committing on success or rolling back on failure. Neither
``begin()`` nor ``cas_status()`` commits. Duplicate intent inserts are isolated
with a savepoint so they do not roll back sibling writes in the caller's
transaction. After the external call returns, ``complete()`` or ``fail()``
records its outcome and commits independently.
"""

import json
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import Intent

# The declared vocabulary of external side effects (spec §3.3 + §5). A kind
# outside this tuple is a programming error, not data — fail loudly at begin().
CREATE_REPO = "create_repo"
OPEN_PR = "open_pr"
MERGE_PR = "merge_pr"
TRIGGER_BUILD = "trigger_build"
APPLY_DEPLOY = "apply_deploy"
SPAWN_STAGE_JOB = "spawn_stage_job"
SPAWN_GATE_JOB = "spawn_gate_job"
KINDS = (
    CREATE_REPO,
    OPEN_PR,
    MERGE_PR,
    TRIGGER_BUILD,
    APPLY_DEPLOY,
    SPAWN_STAGE_JOB,
    SPAWN_GATE_JOB,
)


def begin(db: Session, key: str, kind: str, request_id: int, payload: dict) -> Intent | None:
    if kind not in KINDS:
        raise ValueError(f"unknown intent kind {kind!r} — declare it in intents.KINDS")
    row = Intent(key=key, kind=kind, request_id=request_id, payload_json=json.dumps(payload))
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        return None
    return row


def complete(db: Session, key: str, outcome: dict) -> None:
    row = db.get(Intent, key)
    if row is None:
        raise ValueError(f"no intent {key!r}")
    row.status = "done"
    row.outcome_json = json.dumps(outcome)
    row.completed_at = datetime.now(timezone.utc)
    db.commit()


def fail(db: Session, key: str, outcome: dict) -> None:
    row = db.get(Intent, key)
    if row is None:
        raise ValueError(f"no intent {key!r}")
    row.status = "failed"
    row.outcome_json = json.dumps(outcome)
    row.completed_at = datetime.now(timezone.utc)
    db.commit()


def open_intents(db: Session) -> list[Intent]:
    return list(
        db.execute(
            select(Intent)
            .where(Intent.status == "pending")
            .order_by(Intent.created_at, Intent.key)
        ).scalars()
    )
