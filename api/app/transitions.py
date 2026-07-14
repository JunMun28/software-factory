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
    """Move one request only when its status and the leader epoch still match."""
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
    db.commit()
    return result.rowcount == 1
