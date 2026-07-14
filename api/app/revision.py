"""Process-local freshness signal for mutations outside progress_event.

The API intentionally runs as one uvicorn worker, so a guarded database row or
cross-process counter would add machinery without improving the contract.
"""

_revision = 0


def current_revision() -> int:
    return _revision


def bump_revision() -> int:
    global _revision
    _revision += 1
    return _revision
