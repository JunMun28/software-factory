"""Epoch-fenced compare-and-swap transition tests."""
import inspect
import uuid

import pytest
from helpers import approved_request
from sqlalchemy import select

from app import transitions
from app.db import SessionLocal, migrate
from app.leader import get_elector
from app.models import AuditEvent, Intent, Operator, ProgressEvent, Request
from app.transitions import (
    ANY,
    APPROVED,
    CANCELLED,
    DONE,
    DRAFT,
    FACTORY,
    GATE_APPROVE_MERGE,
    GATE_APPROVE_SPEC,
    HUMAN_OWNED,
    PENDING_APPROVAL,
    SENT_BACK,
    SUBMITTED,
    TABLE,
    Actor,
    IntentSpec,
    Loss,
    Win,
    apply,
    cas_status,
)


@pytest.fixture(scope="module", autouse=True)
def _restore_app_leadership(restore_app_leadership):
    yield


def _fresh_request(db):
    request = Request(
        ref=f"REQ-{uuid.uuid4().hex[:8]}",
        title="CAS transition fixture",
        description="Exercise status and epoch fencing.",
        type="enh",
        status="queued_for_pipeline",
    )
    db.add(request)
    db.commit()
    return request


def test_cas_moves_exactly_once(make_elector):
    migrate()
    elector = make_elector()
    elector.try_acquire()
    with SessionLocal() as db:
        request = _fresh_request(db)
        assert cas_status(
            db, request.id, "queued_for_pipeline", "running", elector.epoch
        ) is True
        db.commit()
        assert cas_status(
            db, request.id, "queued_for_pipeline", "running", elector.epoch
        ) is False
        db.rollback()


def test_stale_epoch_cannot_write(make_elector):
    migrate()
    elector = make_elector()
    elector.try_acquire()
    stale = elector.epoch
    elector.release()
    elector.try_acquire()
    with SessionLocal() as db:
        request = _fresh_request(db)
        assert cas_status(
            db, request.id, "queued_for_pipeline", "running", stale
        ) is False
        db.rollback()
        assert cas_status(
            db, request.id, "queued_for_pipeline", "running", elector.epoch
        ) is True
        db.commit()


def test_true_cas_is_not_durable_until_caller_commits(make_elector):
    """The regression pin for caller-owned transactions: this test FAILS if
    cas_status ever commits internally again (the write would survive the
    caller's rollback and the fence could be bypassed via committed intents)."""
    migrate()
    elector = make_elector()
    elector.try_acquire()
    with SessionLocal() as db:
        request = _fresh_request(db)
        req_id = request.id  # capture before rollback expires the instance
        assert cas_status(
            db, req_id, "queued_for_pipeline", "running", elector.epoch
        ) is True
        db.rollback()  # caller aborts — e.g. a sibling intent insert failed
    with SessionLocal() as db2:
        assert db2.get(Request, req_id).status == "queued_for_pipeline"


def test_cas_missing_row_returns_false(make_elector):
    migrate()
    elector = make_elector()
    elector.try_acquire()
    with SessionLocal() as db:
        assert cas_status(
            db, -1, "queued_for_pipeline", "running", elector.epoch
        ) is False
        db.rollback()


def _request(db, **cols):
    """A Request in an arbitrary lifecycle state — the unit-test fixture."""
    defaults = dict(
        ref=f"REQ-{uuid.uuid4().hex[:8]}",
        title="Transition fixture",
        description="Exercise the transition table.",
        type="enh",
        status="draft",
        stage="intake",
    )
    defaults.update(cols)
    request = Request(**defaults)
    db.add(request)
    db.commit()
    return request


def _events(db, rid, kind=None):
    q = select(ProgressEvent).where(ProgressEvent.request_id == rid)
    rows = list(db.scalars(q.order_by(ProgressEvent.id)))
    return [e for e in rows if kind is None or e.kind == kind]


def _audits(db, rid, action):
    return list(db.scalars(select(AuditEvent).where(
        AuditEvent.request_id == rid, AuditEvent.action == action)))


RILEY = Actor(name="Riley Test", operator_id=None)

# (name, starting columns, params, expected columns after Win, expected audit action)
ROW_CASES = [
    ("submit_claim", dict(status=DRAFT), {},
     dict(status=PENDING_APPROVAL), None),
    ("release_submit_claim", dict(status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC), {},
     dict(status=DRAFT, gate=None), None),
    ("raise_spec_gate", dict(status=PENDING_APPROVAL), {},
     dict(stage="spec", status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC), None),
    ("approve_spec", dict(status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC), {"repo": "micron/x"},
     dict(status=APPROVED, stage="architecture", gate=None, sim_step=0, stage2_fired=True), "approved"),
    ("claim_merge", dict(status=APPROVED, stage="review", gate=GATE_APPROVE_MERGE), {},
     dict(gate=None, status=APPROVED), "merge_claimed"),
    ("finish_done", dict(status=APPROVED, stage="review"),
     {"merge_note": "PR merged to main", "deploy_title": "Deployed — test"},
     dict(status=DONE, stage="done", gate=None), None),
    ("send_back", dict(status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC), {"note": "why?"},
     dict(status=SENT_BACK, gate=None, needs_human=False, send_back_question="why?", send_back_rounds=1),
     "sent_back"),
    ("respond", dict(status=SENT_BACK), {"note": "because"},
     dict(status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC, send_back_response="because"), "responded"),
    ("cancel", dict(status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC), {},
     dict(status=CANCELLED, gate=None, needs_human=False), "cancelled"),
    ("retry_spec", dict(status=APPROVED, stage="spec", gate=None,
                        needs_human=True, needs_human_reason="x"), {},
     dict(needs_human=False, needs_human_reason=None, status=PENDING_APPROVAL,
          gate=GATE_APPROVE_SPEC, sim_step=0), "retried"),
    ("retry_pipeline", dict(status=APPROVED, stage="build", gate=GATE_APPROVE_MERGE,
                            needs_human=True, needs_human_reason="x"), {},
     dict(needs_human=False, needs_human_reason=None, status=APPROVED,
          gate=None, sim_step=0), "retried"),
    ("take_over", dict(status=APPROVED, stage="build", needs_human=True), {},
     dict(status=HUMAN_OWNED, needs_human=False, gate=None), "taken_over"),
    ("send_back_to_stage", dict(status=APPROVED, stage="review", needs_human=True),
     {"stage": "build", "reason": "redo tests"},
     dict(stage="build", status=APPROVED, needs_human=False, sim_step=0), "sent_back_to_stage"),
    ("escalate", dict(status=APPROVED, stage="build"), {"reason": "runner stalled"},
     dict(needs_human=True, needs_human_reason="runner stalled"), None),
    ("raise_merge_gate", dict(status=APPROVED, stage="review"), {},
     dict(gate=GATE_APPROVE_MERGE, status=APPROVED), None),
    ("advance_stage", dict(status=APPROVED, stage="architecture"),
     {"stage": "build", "announce": True},
     dict(stage="build", sim_step=0), None),
]


@pytest.mark.parametrize("name,start,params,expected,audit_action",
                         ROW_CASES, ids=[c[0] for c in ROW_CASES])
def test_every_row_wins_from_its_precondition_state(name, start, params, expected, audit_action):
    migrate()
    with SessionLocal() as db:
        req = _request(db, **start)
        res = apply(db, req, name, actor=RILEY, params=params)
        assert isinstance(res, Win), f"{name}: {res}"
        db.commit()
        for col, want in expected.items():
            assert getattr(req, col) == want, f"{name}.{col}"
        if audit_action:
            assert len(_audits(db, req.id, audit_action)) == 1
        res.notify()  # must never raise (no-op when the row has no notification)


def test_every_row_guards_composite_state():
    assert transitions.TABLE is TABLE
    assert SUBMITTED in TABLE["submit_claim"].pre.status_in
    for name, row in TABLE.items():
        pre = row.pre
        assert (pre.status_in or pre.status_not_in or pre.gate is not ANY
                or pre.needs_human is not None), f"{name} has no composite-state guard"


def test_expected_stage_is_a_first_class_precondition():
    assert "expected_stage" in inspect.signature(apply).parameters
    migrate()
    with SessionLocal() as db:
        req = _request(db, status=APPROVED, stage="build", needs_human=False)
        res = apply(db, req, "advance_stage", actor=FACTORY,
                    params={"stage": "review"}, expected_stage="architecture")

        assert isinstance(res, Loss)
        assert req.stage == "build"


def test_loss_resolves_winner_conflict_and_self_replay():
    migrate()
    with SessionLocal() as db:
        req = _request(db, status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC)
        assert isinstance(apply(db, req, "cancel", actor=RILEY), Win)
        db.commit()
        # a different operator's approve loses with the winner identified
        loser = Actor(name="Morgan Test", operator_id=None)
        res = apply(db, req, "approve_spec", actor=loser, params={"repo": "micron/x"})
        assert isinstance(res, Loss)
        assert res.replay is False
        assert res.winner is not None and res.winner.action == "cancelled"
        assert res.resulting_state == CANCELLED
        assert res.detail == "Cannot approve from status 'cancelled'"
        # the winner replaying their own cancel is idempotent
        res2 = apply(db, req, "cancel", actor=RILEY)
        assert isinstance(res2, Loss) and res2.replay is True
        assert len(_audits(db, req.id, "cancelled")) == 1


def test_loss_with_no_decisive_winner_keeps_the_fallback_detail():
    migrate()
    with SessionLocal() as db:
        req = _request(db, status=DRAFT)  # never acted on
        res = apply(db, req, "retry_pipeline", actor=RILEY)
        assert isinstance(res, Loss)
        assert res.winner is None
        assert res.detail == "Request is not escalated"


def test_loss_rolls_back_callers_staged_session_writes():
    migrate()
    with SessionLocal() as db:
        req = _request(db, status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC)
        original_title = req.title
        winner = Actor(name="Winning Operator", operator_id=None)
        assert isinstance(apply(db, req, "cancel", actor=winner), Win)
        db.commit()

        req.title = "staged but not committed"
        loser = Actor(name="Losing Operator", operator_id=None)
        res = apply(db, req, "approve_spec", actor=loser, params={"repo": "micron/x"})

        assert isinstance(res, Loss) and res.winner is not None
        assert res.winner.action == "cancelled"
        assert req.title == original_title


def test_win_preserves_callers_staged_request_write():
    migrate()
    with SessionLocal() as db:
        req = _request(db, status=PENDING_APPROVAL)
        rid = req.id
        req.spec_open_note = "Staged before the transition"

        assert isinstance(apply(db, req, "raise_spec_gate", actor=RILEY), Win)
        db.commit()

    with SessionLocal() as db2:
        assert db2.get(Request, rid).spec_open_note == "Staged before the transition"


def test_resolve_loss_replays_for_same_non_none_operator_id():
    migrate()
    with SessionLocal() as db:
        operator = Operator(
            name="Riley",
            initials="RT",
            hue="#123456",
            email=f"riley-{uuid.uuid4().hex[:8]}@example.com",
        )
        db.add(operator)
        db.commit()
        req = _request(db, status=PENDING_APPROVAL)
        winner = Actor(name="Riley Before Rename", operator_id=operator.id)
        assert isinstance(apply(db, req, "cancel", actor=winner), Win)
        db.commit()

        replayer = Actor(name="Riley After Rename", operator_id=operator.id)
        res = transitions.resolve_loss(db, req, "cancel", replayer)

        assert isinstance(res, Loss)
        assert res.replay is True
        assert res.winner is not None and res.winner.operator_id == operator.id


def test_resolve_loss_conflicts_for_different_non_none_operator_id():
    migrate()
    with SessionLocal() as db:
        winner = Operator(name="Winner", initials="WI", hue="#123456",
                          email=f"winner-{uuid.uuid4().hex[:8]}@example.com")
        replayer = Operator(name="Replayer", initials="RE", hue="#654321",
                            email=f"replayer-{uuid.uuid4().hex[:8]}@example.com")
        db.add_all([winner, replayer])
        db.commit()
        req = _request(db, status=PENDING_APPROVAL)
        assert isinstance(apply(db, req, "cancel", actor=Actor(
            name=winner.name, operator_id=winner.id)), Win)
        db.commit()

        res = transitions.resolve_loss(db, req, "cancel", Actor(
            name=replayer.name, operator_id=replayer.id))

        assert isinstance(res, Loss)
        assert res.replay is False


def test_race_pair_cancel_vs_approve_both_orders():
    migrate()
    with SessionLocal() as db:
        # approve first: cancel still wins afterwards (cancelling approved work is legal)
        a = _request(db, status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC)
        assert isinstance(apply(db, a, "approve_spec", actor=RILEY, params={"repo": "r"}), Win)
        db.commit()
        assert isinstance(apply(db, a, "cancel", actor=RILEY), Win)
        db.commit()
        assert a.status == CANCELLED
        # cancel first: approve loses
        b = _request(db, status=PENDING_APPROVAL, gate=GATE_APPROVE_SPEC)
        assert isinstance(apply(db, b, "cancel", actor=RILEY), Win)
        db.commit()
        assert isinstance(apply(db, b, "approve_spec", actor=RILEY, params={"repo": "r"}), Loss)


def test_release_submit_claim_loses_after_cancel_wins():
    migrate()
    assert "release_submit_claim" in TABLE
    with SessionLocal() as db:
        req = _request(db, status=PENDING_APPROVAL)
        assert isinstance(apply(db, req, "cancel", actor=RILEY), Win)
        db.commit()

        res = apply(db, req, "release_submit_claim", actor=RILEY)

        assert isinstance(res, Loss)
        assert req.status == CANCELLED


def test_race_pair_retry_vs_stale_escalate(make_elector):
    """After a human Retry, a deposed runner's escalate must be fenced out."""
    migrate()
    elector = make_elector()
    elector.try_acquire()
    stale = elector.epoch
    with SessionLocal() as db:
        req = _request(db, status=APPROVED, stage="build", needs_human=True)
        assert isinstance(
            apply(db, req, "retry_pipeline", actor=RILEY), Win)
        db.commit()
        elector.release()
        elector.try_acquire()  # new leadership term — `stale` is now behind
        res = apply(db, req, "escalate", actor=FACTORY,
                    params={"reason": "late"}, epoch=stale)
        assert isinstance(res, Loss)
        assert res.detail == (
            f"fenced: stale leader epoch (mine={stale}, current={elector.epoch})"
        )
        assert req.needs_human is False
        res2 = apply(db, req, "escalate", actor=FACTORY,
                     params={"reason": "fresh"}, epoch=elector.epoch)
        assert isinstance(res2, Win)
        db.commit()
        assert req.needs_human is True


def test_http_transitions_are_not_epoch_fenced(make_elector):
    """A human Cancel is valid from any replica: epoch=None skips the fence."""
    migrate()
    elector = make_elector()
    elector.try_acquire()
    elector.release()
    elector.try_acquire()  # churn the table epoch
    with SessionLocal() as db:
        req = _request(db, status=PENDING_APPROVAL)
        res = apply(db, req, "cancel", actor=RILEY)  # no epoch passed
        assert isinstance(res, Win)
        db.commit()
        assert req.status == CANCELLED


def test_apply_is_not_durable_until_caller_commits():
    """The regression pin: apply() must never commit internally."""
    migrate()
    with SessionLocal() as db:
        req = _request(db, status=PENDING_APPROVAL)
        rid = req.id
        assert isinstance(apply(db, req, "cancel", actor=RILEY), Win)
        db.rollback()
    with SessionLocal() as db2:
        assert db2.get(Request, rid).status == PENDING_APPROVAL
        assert _audits(db2, rid, "cancelled") == []
        assert _events(db2, rid, "recovery_action") == []


def test_apply_emits_the_rows_events():
    migrate()
    with SessionLocal() as db:
        req = _request(db, status=PENDING_APPROVAL)
        apply(db, req, "cancel", actor=RILEY)
        db.commit()
        evs = _events(db, req.id, "recovery_action")
        assert len(evs) == 1
        assert evs[0].title == "Request cancelled by Riley Test"
        assert evs[0].actor == "Riley Test" and evs[0].bot is False
        assert evs[0].payload == {"Ref": req.ref}


def test_apply_attaches_intent_in_same_transaction():
    migrate()
    with SessionLocal() as db:
        req = _request(db, status=PENDING_APPROVAL)
        key = f"cancel:{req.id}:{uuid.uuid4().hex[:6]}"
        res = apply(db, req, "cancel", actor=RILEY,
                    intent=IntentSpec(key=key, kind="open_pr", payload={"why": "test"}))
        assert isinstance(res, Win) and res.intent is not None
        db.commit()
        assert db.get(Intent, key).status == "pending"


def test_win_notify_fires_after_commit(monkeypatch):
    migrate()
    pinged = []
    monkeypatch.setattr("app.notifications.notify_escalation",
                        lambda db, req: pinged.append(req.id))
    with SessionLocal() as db:
        req = _request(db, status=APPROVED, stage="build")
        res = apply(db, req, "escalate", actor=FACTORY, params={"reason": "stall"})
        assert isinstance(res, Win)
        assert pinged == [], "notification must not fire inside apply()"
        db.commit()
        res.notify()
        assert pinged == [req.id]


# ---------- apply_committed (Plan B1 task 1) ----------

@pytest.fixture
def app_leader_for_apply_committed():
    """Give these machine-caller tests the current app leadership epoch."""
    elector = get_elector()
    was_leader = elector.verify()
    if not was_leader:
        assert elector.try_acquire() is True
    try:
        yield
    finally:
        if was_leader and not elector.verify():
            assert elector.try_acquire() is True
        elif not was_leader:
            elector.release()


@pytest.mark.usefixtures("app_leader_for_apply_committed")
def test_apply_committed_commits_win_and_fires_notify(client, monkeypatch):
    calls: list[int] = []
    monkeypatch.setattr("app.notifications.notify_escalation",
                        lambda db, req: calls.append(req.id))
    d = approved_request(client, title="apply_committed win")
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        res = transitions.apply_committed(
            db, req, "escalate", actor=transitions.FACTORY,
            params={"reason": "helper witness"}, epoch=get_elector().epoch)
        assert isinstance(res, transitions.Win)
    with SessionLocal() as db:  # durable: a FRESH session sees the committed state
        assert db.get(Request, d["id"]).needs_human is True
    assert calls == [d["id"]]  # notify fired exactly once, after the commit


@pytest.mark.usefixtures("app_leader_for_apply_committed")
def test_apply_committed_returns_loss_untouched(client):
    d = approved_request(client, title="apply_committed loss")
    client.post(f"/api/requests/{d['id']}/cancel", json={"operator_id": 1})
    with SessionLocal() as db:
        req = db.get(Request, d["id"])
        res = transitions.apply_committed(
            db, req, "escalate", actor=transitions.FACTORY,
            params={"reason": "should lose"}, epoch=get_elector().epoch)
        assert isinstance(res, transitions.Loss)
        assert req.needs_human is False  # rolled back, nothing leaked
