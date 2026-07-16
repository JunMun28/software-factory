"""B3 env gates (Plan B3): build/deploy is OFF unless git backbone + registry +
switch are ALL set — any one missing keeps B2 semantics exactly. Plus the
begin_deploy transition: approved/review -> approved/deploy, finish_done still
closes from deploy."""
import uuid

import pytest

from app import settings, transitions
from app.db import SessionLocal, migrate
from app.models import Request


@pytest.fixture(autouse=True)
def _restore_settings(monkeypatch):
    # monkeypatch.setattr restores module attributes after each test — no reload
    # needed, so downstream tests keep the process-start settings values.
    yield


def test_deploy_disabled_by_default():
    # the test process never sets the three envs — the shipped default is OFF
    assert settings.app_deploy_enabled() is False


def test_deploy_requires_all_three(monkeypatch):
    monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
    monkeypatch.setattr(settings, "REGISTRY", "sf-registry:5000")
    monkeypatch.setattr(settings, "APP_DEPLOY", True)
    assert settings.app_deploy_enabled() is True
    for missing in ("GIT_REMOTE_BASE", "REGISTRY", "APP_DEPLOY"):
        monkeypatch.setattr(settings, missing, "" if missing != "APP_DEPLOY" else False)
        assert settings.app_deploy_enabled() is False
        monkeypatch.setattr(settings, "GIT_REMOTE_BASE", "git://api:9418")
        monkeypatch.setattr(settings, "REGISTRY", "sf-registry:5000")
        monkeypatch.setattr(settings, "APP_DEPLOY", True)


def _operator(db):
    from app.models import Operator
    op = db.get(Operator, 1)
    if op is None:
        op = Operator(id=1, name="Ada", initials="AL", hue="violet", email="ada@sf.local")
        db.add(op)
        db.commit()
    return op


def _request(db, **cols):
    defaults = dict(
        ref=f"REQ-{uuid.uuid4().hex[:8]}",
        title="deploy transition fixture",
        description="begin_deploy moves review -> deploy; finish_done closes it.",
        type="enh",
        status=transitions.APPROVED,
        stage="review",
    )
    defaults.update(cols)
    request = Request(**defaults)
    db.add(request)
    db.commit()
    return request


def test_begin_deploy_then_finish_done(restore_app_leadership):
    migrate()
    with SessionLocal() as db:
        req = _request(db)
        res = transitions.apply(db, req, "begin_deploy",
                                actor=transitions.FACTORY, params={"sha": "a" * 40})
        assert isinstance(res, transitions.Win)
        db.commit()
        db.refresh(req)
        assert (req.status, req.stage, req.gate) == (transitions.APPROVED, "deploy", None)

        res = transitions.apply(db, req, "finish_done", actor=transitions.Actor(name="Ada"),
                                params={"merge_note": "PR merged to main",
                                        "deploy_title": "Deployed — live",
                                        "payload_extra": {"url": "http://x/health"}})
        assert isinstance(res, transitions.Win)
        db.commit()
        db.refresh(req)
        assert (req.status, req.stage) == (transitions.DONE, "done")


def test_begin_deploy_loses_on_closed_request(restore_app_leadership):
    migrate()
    with SessionLocal() as db:
        req = _request(db, status=transitions.CANCELLED)
        res = transitions.apply(db, req, "begin_deploy", actor=transitions.FACTORY)
        assert isinstance(res, transitions.Loss)


def test_raise_deploy_gate_holds_at_deploy_stage(restore_app_leadership, make_elector):
    migrate()
    make_elector()
    with SessionLocal() as db:
        req = _request(db)
        res = transitions.apply(db, req, "raise_deploy_gate",
                                actor=transitions.FACTORY, params={"sha": "a" * 40},
                                epoch=transitions.get_elector().epoch
                                if hasattr(transitions, "get_elector") else None)
        assert isinstance(res, transitions.Win)
        db.commit()
        db.refresh(req)
        assert req.gate == transitions.GATE_APPROVE_DEPLOY
        assert req.stage == "deploy" and req.status == transitions.APPROVED


def test_claim_then_begin_deploy_releases_and_records_approver(restore_app_leadership):
    migrate()
    with SessionLocal() as db:
        _operator(db)
        req = _request(db, stage="deploy", gate=transitions.GATE_APPROVE_DEPLOY)
        actor = transitions.Actor(name="Ada", operator_id=1)
        assert isinstance(transitions.apply(db, req, "claim_deploy", actor=actor),
                          transitions.Win)
        assert isinstance(transitions.apply(db, req, "begin_deploy", actor=actor,
                                            params={}), transitions.Win)
        db.commit()
        db.refresh(req)
        assert req.gate is None and req.stage == "deploy"
        from sqlalchemy import select

        from app.models import AuditEvent
        row = db.scalar(select(AuditEvent).where(
            AuditEvent.request_id == req.id, AuditEvent.action == "deploy_claimed"))
        assert row is not None and row.operator_id == 1
        # the release milestone names the approver
        from app.models import ProgressEvent
        ev = db.scalar(select(ProgressEvent).where(
            ProgressEvent.request_id == req.id,
            ProgressEvent.kind == "milestone_summary").order_by(ProgressEvent.id.desc()))
        assert "Deploy approved by Ada" in ev.title


def test_deploy_gate_replay_is_a_replay_loss(restore_app_leadership):
    migrate()
    with SessionLocal() as db:
        _operator(db)
        req = _request(db, stage="deploy", gate=transitions.GATE_APPROVE_DEPLOY)
        actor = transitions.Actor(name="Ada", operator_id=1)
        transitions.apply(db, req, "claim_deploy", actor=actor)
        db.commit()
        loss = transitions.apply(db, req, "claim_deploy", actor=actor)
        assert isinstance(loss, transitions.Loss) and loss.replay is True
