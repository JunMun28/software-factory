from types import SimpleNamespace

from app.routers import requests as requests_router


class _Clock:
    def __init__(self):
        self.now = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class _Queue:
    def __init__(self):
        self.events: list[dict] = []

    def put_nowait(self, event: dict) -> None:
        self.events.append(event)


class _Loop:
    def call_soon_threadsafe(self, callback, event: dict) -> None:
        callback(event)


def _run_waiter(monkeypatch, *, timeout: int, ready_after: int | None):
    clock = _Clock()
    queue = _Queue()
    session_calls = 0
    operations: list[str] = []
    reads = 0

    class FakeDb:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def expire_all(self) -> None:
            operations.append("expire")

        def get(self, model, rid: int):
            nonlocal reads
            assert model is requests_router.Request
            assert rid == 41
            operations.append("get")
            reads += 1
            return SimpleNamespace(ready=ready_after is not None and reads >= ready_after)

        def rollback(self) -> None:
            operations.append("rollback")

    def session_local():
        nonlocal session_calls
        session_calls += 1
        return FakeDb()

    monkeypatch.setattr(requests_router, "SessionLocal", session_local)
    monkeypatch.setattr(requests_router.time, "monotonic", clock.monotonic)
    monkeypatch.setattr(requests_router.time, "sleep", clock.sleep)

    requests_router._sse_worker(
        41,
        queue,
        _Loop(),
        acquire=lambda rid: False,
        release=lambda rid: (_ for _ in ()).throw(AssertionError("slot was not acquired")),
        timeout=timeout,
        resolved=lambda request: request.ready,
        resolve=lambda db, request: None,
        build_state=lambda db, request: SimpleNamespace(
            model_dump=lambda mode: {"ready": request.ready}
        ),
    )

    return clock, queue, session_calls, operations


def test_waiter_reuses_one_session_and_caps_exponential_backoff(monkeypatch):
    clock, queue, session_calls, operations = _run_waiter(
        monkeypatch, timeout=7, ready_after=None
    )

    assert clock.sleeps == [1.0, 2.0, 4.0, 5.0]
    assert sum(clock.sleeps) == 12.0
    assert session_calls == 1
    assert operations == [
        "expire", "get", "rollback",
        "expire", "get", "rollback",
        "expire", "get", "rollback",
        "expire", "get", "rollback",
    ]
    assert queue.events == [{"type": "state", "state": None}]


def test_waiter_emits_result_after_backoff_rereads(monkeypatch):
    clock, queue, session_calls, operations = _run_waiter(
        monkeypatch, timeout=20, ready_after=3
    )

    assert clock.sleeps == [1.0, 2.0, 4.0]
    assert session_calls == 1
    assert operations == [
        "expire", "get", "rollback",
        "expire", "get", "rollback",
        "expire", "get",
    ]
    assert queue.events == [{"type": "state", "state": {"ready": True}}]


def test_waiter_never_sleeps_a_negative_duration_at_deadline(monkeypatch):
    readings = iter([0.0, 11.9, 12.1])
    last_reading = 12.1
    sleeps: list[float] = []
    queue = _Queue()

    class FakeDb:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def expire_all(self):
            pass

        def get(self, model, rid):
            return SimpleNamespace(ready=False)

        def rollback(self):
            pass

    def monotonic():
        return next(readings, last_reading)

    def sleep(seconds: float):
        assert seconds >= 0
        sleeps.append(seconds)

    monkeypatch.setattr(requests_router, "SessionLocal", FakeDb)
    monkeypatch.setattr(requests_router.time, "monotonic", monotonic)
    monkeypatch.setattr(requests_router.time, "sleep", sleep)

    requests_router._sse_worker(
        41,
        queue,
        _Loop(),
        acquire=lambda rid: False,
        release=lambda rid: None,
        timeout=7,
        resolved=lambda request: request.ready,
        resolve=lambda db, request: None,
        build_state=lambda db, request: None,
    )

    assert len(sleeps) == 1
    assert 0 < sleeps[0] <= 0.1
    assert queue.events == [{"type": "state", "state": None}]
