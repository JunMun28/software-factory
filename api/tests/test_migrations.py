"""Alembic owns non-SQLite schema; SQLite keeps the fast create_all path."""
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

from sqlalchemy import create_engine
from sqlalchemy.dialects import mssql
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateTable

from app.models import LeaderEpoch, Operator


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
        assert {"requests", "progress_events", "leader_epochs"} <= tables, tables
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
