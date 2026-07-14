import json

import app.intents as intents
from app.db import SessionLocal, migrate
from app.models import Intent


def test_begin_is_idempotent_by_key():
    migrate()
    with SessionLocal() as db:
        first = intents.begin(db, "req1:merge_pr:sha123", "merge_pr", 1, {"sha": "sha123"})
        assert first is not None and first.status == "pending"
        dup = intents.begin(db, "req1:merge_pr:sha123", "merge_pr", 1, {"sha": "sha123"})
        assert dup is None  # caller must NOT repeat the external call


def test_complete_and_recovery_scan():
    migrate()
    with SessionLocal() as db:
        intents.begin(db, "req2:trigger_build:sha9", "trigger_build", 2, {})
        assert [i.key for i in intents.open_intents(db)] == ["req2:trigger_build:sha9"]
        intents.complete(db, "req2:trigger_build:sha9", {"build": "b-1"})
        assert intents.open_intents(db) == []
        row = db.get(Intent, "req2:trigger_build:sha9")
        assert row is not None
        assert row.status == "done" and json.loads(row.outcome_json)["build"] == "b-1"
