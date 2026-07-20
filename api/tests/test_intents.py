import json
import uuid

import pytest

import app.intents as intents
from app.db import SessionLocal, migrate
from app.models import Intent, Request
from app.transitions import cas_status


@pytest.fixture(scope="module", autouse=True)
def _restore_app_leadership(restore_app_leadership):
    yield


def test_begin_is_idempotent_by_key():
    migrate()
    key = f"req1:merge_pr:sha123-{uuid.uuid4().hex}"
    with SessionLocal() as db:
        first = intents.begin(db, key, "merge_pr", 1, {"sha": "sha123"})
        assert first is not None and first.status == "pending"
        db.commit()

    with SessionLocal() as db:
        dup = intents.begin(db, key, "merge_pr", 1, {"sha": "sha123"})
        assert dup is None  # caller must NOT repeat the external call
        intents.complete(db, key, {})


def test_duplicate_begin_preserves_sibling_writes(make_elector):
    migrate()
    key = f"req3:merge_pr:sha456-{uuid.uuid4().hex}"
    elector = make_elector()
    assert elector.try_acquire() is True

    with SessionLocal() as db:
        request = Request(
            ref=f"REQ-{uuid.uuid4().hex[:8]}",
            title="Intent transaction fixture",
            description="Exercise duplicate intent savepoint isolation.",
            type="enh",
            status="queued_for_pipeline",
        )
        db.add(request)
        db.commit()
        request_id = request.id

    with SessionLocal() as db:
        existing = intents.begin(db, key, "merge_pr", request_id, {})
        assert existing is not None
        db.commit()

    with SessionLocal() as db:
        assert cas_status(
            db, request_id, "queued_for_pipeline", "running", elector.epoch
        ) is True
        duplicate = intents.begin(db, key, "merge_pr", request_id, {})
        assert duplicate is None
        db.commit()

    with SessionLocal() as db:
        persisted = db.get(Request, request_id)
        assert persisted is not None
        assert persisted.status == "running"
        intents.complete(db, key, {})


def test_complete_and_recovery_scan():
    migrate()
    key = f"req2:trigger_build:sha9-{uuid.uuid4().hex}"
    with SessionLocal() as db:
        intents.begin(db, key, "trigger_build", 2, {})
        # scope to our own key: under FACTORY_TEST_USE_ENV_DB=1 (runbook step 8,
        # live Azure SQL) the table is shared and other suites' intents persist
        assert [i.key for i in intents.open_intents(db) if i.key == key] == [key]
        intents.complete(db, key, {"build": "b-1"})
        assert [i for i in intents.open_intents(db) if i.key == key] == []
        row = db.get(Intent, key)
        assert row is not None
        assert row.status == "done" and json.loads(row.outcome_json)["build"] == "b-1"

        with pytest.raises(ValueError, match="no intent 'missing:complete'"):
            intents.complete(db, "missing:complete", {})
        with pytest.raises(ValueError, match="no intent 'missing:fail'"):
            intents.fail(db, "missing:fail", {})


def test_kinds_cover_the_spec_side_effects():
    # spec §3.3's external side effects + Plan B1's job spawning
    assert set(intents.KINDS) == {
        "create_repo", "open_pr", "merge_pr", "trigger_build",
        "apply_deploy", "spawn_stage_job", "spawn_gate_job",
    }


def test_begin_rejects_unknown_kind():
    with SessionLocal() as db:
        with pytest.raises(ValueError):
            intents.begin(db, f"k-{uuid.uuid4().hex}", "mystery_kind", 1, {})
