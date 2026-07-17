"""Tick-loop heartbeat — the one place the console learns the line is alive.

The tick loop (main.py) beats after every completed leader pass. /api/health
reports the age so the shell can say "tick stalled" instead of every run
silently going quiet (the failure mode a dead loop actually produces).
"""

import time

_last_beat: float | None = None


def beat() -> None:
    global _last_beat
    _last_beat = time.monotonic()


def age_seconds() -> float | None:
    """Seconds since the last completed tick pass; None until the first beat."""
    if _last_beat is None:
        return None
    return time.monotonic() - _last_beat


def reset() -> None:
    """Test seam: forget the last beat."""
    global _last_beat
    _last_beat = None
