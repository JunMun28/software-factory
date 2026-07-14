"""Compare-and-swap state transitions guarded by the leader epoch."""
from sqlalchemy import text
from sqlalchemy.orm import Session


def cas_status(
    db: Session,
    request_id: int,
    expected: str,
    new: str,
    epoch: int,
) -> bool:
    """Move one request only when its status and the leader epoch still match.

    The caller owns the transaction: commit on ``True`` and roll back on
    ``False`` so intent rows, event appends, and this CAS land atomically or not
    at all. Because sessions use ``expire_on_commit=False``, callers must call
    ``db.refresh(obj)`` to see the new status on already-loaded objects.
    """
    # Under MSSQL READ COMMITTED/RCSI, a stale leader's in-flight statement can
    # commit just after an epoch bump. The status CAS still serializes conflicting
    # transitions; revisit with UPDLOCK/HOLDLOCK once cas_status carries production traffic.
    result = db.execute(
        text(
            "UPDATE requests SET status = :new "
            "WHERE id = :rid AND status = :expected "
            "AND EXISTS (SELECT 1 FROM leader_epochs "
            "WHERE id = 1 AND epoch = :epoch)"
        ),
        {
            "new": new,
            "rid": request_id,
            "expected": expected,
            "epoch": epoch,
        },
    )
    return result.rowcount == 1
