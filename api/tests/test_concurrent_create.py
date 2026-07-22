"""Many people filing a request at the same moment.

Ref allocation is read-then-write against a UNIQUE column, so simultaneous creates
genuinely collide. There WAS a retry, but a single one that recomputed the identical
number — every loser collided again. Measured against a live server 2026-07-22: eight
concurrent creates returned two HTTP 500s. A 500 here loses somebody's request.
"""
import threading

from app.api_helpers import next_ref
from app.db import SessionLocal
from app.models import Request


def test_a_burst_of_creates_all_succeed(client):
    """The regression itself, through the real endpoint."""
    codes: list[int] = []
    lock = threading.Lock()

    def create(i: int) -> None:
        # Record the outcome even when the call raises, or a thread that dies takes its
        # own evidence with it and the assertion below passes on the survivors.
        try:
            code = client.post("/api/requests", json={
                "type": "new", "title": f"burst {i}", "description": "filed at the same moment",
                "reporter": f"User {i}", "reporter_initials": "U",
            }).status_code
        except Exception as exc:  # noqa: BLE001 — the failure IS the result here
            code = repr(exc)
        with lock:
            codes.append(code)

    threads = [threading.Thread(target=create, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(codes) == 8, f"lost {8 - len(codes)} results"
    assert set(codes) == {201}, f"expected every create to succeed, got {sorted(map(str, codes))}"


def test_refs_stay_unique_across_a_burst(client):
    refs = [client.post("/api/requests", json={
        "type": "new", "title": f"seq {i}", "description": "d",
        "reporter": "Solo", "reporter_initials": "S",
    }).json()["ref"] for i in range(6)]
    assert len(set(refs)) == len(refs)


def test_spread_widens_the_candidate_window():
    """What makes a retry converge: without a spread every loser recomputes the same
    number and collides again on the next pass."""
    with SessionLocal() as db:
        db.add(Request(ref="REQ-9000", title="t", description="d", type="new"))
        db.commit()
        try:
            dense = {next_ref(db) for _ in range(20)}
            assert dense == {"REQ-9001"}, "attempt 0 must stay dense and predictable"

            spread = {next_ref(db, spread=15) for _ in range(40)}
            assert len(spread) > 1, "a retry that cannot diverge is not a retry"
            assert all(9001 <= int(r.split("-")[1]) <= 9016 for r in spread)
        finally:
            db.query(Request).filter(Request.ref == "REQ-9000").delete()
            db.commit()
