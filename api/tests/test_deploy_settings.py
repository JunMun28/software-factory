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
