"""Alembic owns non-SQLite schema; SQLite keeps the fast create_all path."""
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

from sqlalchemy import create_engine, inspect, select
from sqlalchemy.dialects import mssql
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateIndex, CreateTable

from app import interview_gen
from app.models import InterviewTurn, LeaderEpoch, Operator, PrototypeTurn, Request
from app.routers.requests import _answered_turn_count


def test_alembic_upgrade_head_builds_full_schema_on_fresh_db():
    ddl = str(CreateTable(LeaderEpoch.__table__).compile(dialect=mssql.dialect()))
    assert LeaderEpoch.__table__.c.id.autoincrement is False
    assert "IDENTITY" not in ddl.upper()

    # a fresh SQLite file stands in for "empty database" — the point is that
    # the alembic history alone (no create_all) produces every table
    with tempfile.TemporaryDirectory() as tmp:
        url = f"sqlite:///{tmp}/mig.db"
        r = subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            env={**os.environ, "FACTORY_DB_URL": url},
            capture_output=True, text=True, cwd=".",
        )
        assert r.returncode == 0, r.stderr
        from sqlalchemy import create_engine, inspect
        insp = inspect(create_engine(url))
        tables = set(insp.get_table_names())
        # spot-check the load-bearing tables
        assert {
            "requests",
            "progress_events",
            "leader_epochs",
            "stage_jobs",
            "acceptance_criteria",
            "spec_snapshots",
            "brain_calls",
        } <= tables, tables
        assert "tool_rounds" in {
            column["name"] for column in insp.get_columns("brain_calls")
        }
        assert "intake_escalation" in {
            column["name"] for column in insp.get_columns("requests")
        }
        with create_engine(url).connect() as conn:
            assert conn.exec_driver_sql("SELECT id, epoch FROM leader_epochs").one() == (1, 0)


def test_datetime_round_trip_is_aware_utc():
    # SQLite reproduces MSSQL's offset-naive result; the ORM contract must repair both.
    expected = datetime(2026, 7, 15, 8, 30, tzinfo=timezone.utc)
    with tempfile.TemporaryDirectory() as tmp:
        engine = create_engine(f"sqlite:///{tmp}/tz.db")
        Operator.__table__.create(engine)
        with Session(engine) as db:
            row = Operator(
                name="Timezone Probe",
                initials="TZ",
                hue="#000000",
                email="timezone.probe@example.com",
                created_at=expected,
            )
            db.add(row)
            db.commit()
            row_id = row.id

        with Session(engine) as db:
            loaded = db.get(Operator, row_id)
            assert loaded is not None
            assert loaded.created_at == expected
            assert loaded.created_at.tzinfo is timezone.utc


def test_turn_order_unique_indexes_quote_reserved_order_on_mssql():
    expected = {
        InterviewTurn: "uq_interview_turns_request_order",
        PrototypeTurn: "uq_prototype_turns_request_order",
    }
    for model, name in expected.items():
        index = next(item for item in model.__table__.indexes if item.name == name)
        ddl = str(CreateIndex(index).compile(dialect=mssql.dialect()))
        assert "CREATE UNIQUE INDEX" in ddl
        assert "(request_id, [order])" in ddl


def test_answered_count_cas_uses_mssql_boolean_equality():
    for count_expression in (
        _answered_turn_count(7),
        interview_gen._answered_turn_count(7),
    ):
        statement = select(Request.id).where(count_expression == 1)
        ddl = str(statement.compile(dialect=mssql.dialect()))
        assert "interview_turns.skipped = 1" in ddl
        assert "interview_turns.skipped IS 1" not in ddl


def test_turn_order_migration_repairs_legacy_duplicates_before_indexing():
    with tempfile.TemporaryDirectory() as tmp:
        url = f"sqlite:///{tmp}/legacy-turns.db"
        env = {**os.environ, "FACTORY_DB_URL": url}
        before = subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "c3e5a7b9d1f4"],
            env=env,
            capture_output=True,
            text=True,
            cwd=".",
        )
        assert before.returncode == 0, before.stderr

        db_engine = create_engine(url)
        with Session(db_engine) as db:
            request = Request(ref="REQ-LEGACY", title="Legacy", description="", type="new")
            request.turns.extend(
                [
                    InterviewTurn(order=0, question="Q1", answer="A1"),
                    InterviewTurn(order=0, question="Q1 duplicate", answer="A2"),
                    InterviewTurn(order=1, question="Q2", answer="A3"),
                ]
            )
            request.prototype_turns.extend(
                [
                    PrototypeTurn(order=0, instruction="First", mode="pending"),
                    PrototypeTurn(order=0, instruction="Second", mode="pending"),
                    PrototypeTurn(order=1, instruction="Third", mode="pending"),
                ]
            )
            db.add(request)
            db.flush()
            rid = request.id
            db.commit()
        db_engine.dispose()

        after = subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            env=env,
            capture_output=True,
            text=True,
            cwd=".",
        )
        assert after.returncode == 0, after.stderr

        db_engine = create_engine(url)
        with Session(db_engine) as db:
            assert list(
                db.scalars(
                    select(InterviewTurn.order)
                    .where(InterviewTurn.request_id == rid)
                    .order_by(InterviewTurn.id)
                )
            ) == [0, 1, 2]
            assert list(
                db.scalars(
                    select(PrototypeTurn.order)
                    .where(PrototypeTurn.request_id == rid)
                    .order_by(PrototypeTurn.id)
                )
            ) == [0, 1, 2]
        indexes = inspect(db_engine)
        for table, name in {
            "interview_turns": "uq_interview_turns_request_order",
            "prototype_turns": "uq_prototype_turns_request_order",
        }.items():
            index = next(item for item in indexes.get_indexes(table) if item["name"] == name)
            assert index["unique"] == 1
