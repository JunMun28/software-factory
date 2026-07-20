"""Tiny process-local pub/sub for live intake generation deltas."""

import inspect
import logging
import threading
from collections.abc import Callable

log = logging.getLogger("factory.brain")
DeltaPush = Callable[[dict], None]

_lock = threading.Lock()
_subscribers: dict[tuple[str, int], set[DeltaPush]] = {}


def subscribe(kind: str, rid: int, push: DeltaPush) -> Callable[[], None]:
    """Register a stream callback and return an idempotent unsubscribe function."""
    key = (kind, rid)
    with _lock:
        _subscribers.setdefault(key, set()).add(push)

    def unsubscribe() -> None:
        with _lock:
            callbacks = _subscribers.get(key)
            if callbacks is None:
                return
            callbacks.discard(push)
            if not callbacks:
                _subscribers.pop(key, None)

    return unsubscribe


def publish_delta(kind: str, rid: int, text: str) -> None:
    if not text:
        return
    with _lock:
        callbacks = tuple(_subscribers.get((kind, rid), ()))
    event = {"type": "delta", "text": text}
    for callback in callbacks:
        try:
            callback(event)
        except Exception:
            # A dropped SSE listener must never cancel the provider generation.
            log.exception("brain delta listener failed for %s request %s", kind, rid)


def invoke_with_delta(method, *args, on_delta=None, **kwargs):
    """Pass the optional stream hook only to brains that expose the new argument."""
    if on_delta is not None and "on_delta" in inspect.signature(method).parameters:
        kwargs["on_delta"] = on_delta
    return method(*args, **kwargs)


class ProseRelay:
    """Relay prose while retaining any suffix that could begin the metadata marker."""

    def __init__(self, kind: str, rid: int, marker: str):
        self.kind = kind
        self.rid = rid
        self.marker = marker
        self.buffer = ""
        self.stopped = False

    def feed(self, text: str) -> None:
        if self.stopped or not text:
            return
        self.buffer += text
        marker_at = self.buffer.find(self.marker)
        if marker_at >= 0:
            publish_delta(self.kind, self.rid, self.buffer[:marker_at])
            self.buffer = ""
            self.stopped = True
            return

        keep = 0
        upper = min(len(self.buffer), len(self.marker) - 1)
        for size in range(upper, 0, -1):
            if self.buffer.endswith(self.marker[:size]):
                keep = size
                break
        safe = self.buffer[:-keep] if keep else self.buffer
        publish_delta(self.kind, self.rid, safe)
        self.buffer = self.buffer[-keep:] if keep else ""

    def finish(self) -> None:
        if not self.stopped:
            publish_delta(self.kind, self.rid, self.buffer)
        self.buffer = ""


def prose_relay(kind: str, rid: int, marker: str) -> ProseRelay:
    return ProseRelay(kind, rid, marker)
