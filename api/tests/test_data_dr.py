"""C9 data durability, Unicode, migration-drift, and restore-drill proofs."""

import os
import sqlite3
import subprocess
import sys
from contextlib import closing, nullcontext
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine
from sqlalchemy.dialects import mssql

from app.db import Base, SessionLocal, migrate
from app.models import Request

API_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = API_DIR.parent
UNICODE_SAMPLE = 'Factory 😀 中文 “round-trip”'


@pytest.mark.parametrize(
    ("table", "column"),
    [
        ("apps", "name"),
        ("apps", "owner"),
        ("apps", "repo"),
        ("operators", "name"),
        ("operators", "email"),
        ("requests", "title"),
        ("requests", "description"),
        ("requests", "reach"),
        ("requests", "impact_value"),
        ("requests", "new_app_name"),
        ("requests", "bug_where"),
        ("requests", "extra_detail"),
        ("requests", "needs_human_reason"),
        ("requests", "reporter"),
        ("requests", "send_back_question"),
        ("requests", "send_back_response"),
        ("requests", "spec_open_note"),
        ("requests", "prototype_html"),
        ("interview_turns", "question"),
        ("interview_turns", "sub"),
        ("interview_turns", "answer"),
        ("prototype_turns", "instruction"),
        ("prototype_turns", "note"),
        ("prototype_turns", "html"),
        ("preview_feedback", "body"),
        ("preview_feedback", "author"),
        ("preview_feedback", "disposition_note"),
        ("spec_lines", "text"),
        ("acceptance_criteria", "text"),
        ("spec_snapshots", "spec_md"),
        ("progress_events", "actor"),
        ("progress_events", "title"),
        ("progress_events", "body"),
        ("comments", "author"),
        ("comments", "body"),
        ("attachments", "filename"),
        ("audit_events", "actor"),
        ("audit_events", "note"),
        ("intents", "payload_json"),
        ("intents", "outcome_json"),
        ("stage_jobs", "logs_tail"),
    ],
)
def test_human_text_compiles_to_a_unicode_mssql_type(table, column):
    compiled = str(Base.metadata.tables[table].c[column].type.compile(dialect=mssql.dialect()))

    assert compiled.startswith("NVARCHAR"), f"{table}.{column}: {compiled}"
    assert "NTEXT" not in compiled, f"{table}.{column}: {compiled}"


def _unicode_migration():
    path = API_DIR / "alembic" / "versions" / "e7f9a1c3d5b7_unicode_human_text.py"
    spec = spec_from_file_location("unicode_human_text_migration", path)
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_human_text_types_compile_to_nvarchar_not_ntext():
    migration = _unicode_migration()

    for table, columns in migration._COLUMNS.items():
        for name, _plain_type, unicode_type, _nullable in columns:
            compiled = str(unicode_type.compile(dialect=mssql.dialect()))
            assert compiled.startswith("NVARCHAR"), f"{table}.{name}: {compiled}"
            assert "NTEXT" not in compiled, f"{table}.{name}: {compiled}"


class _MigrationOps:
    """Fake alembic op. `unique_row` is what sys.indexes hands back on MSSQL:
    (index name, is_unique_constraint). None means the lookup found nothing."""

    def __init__(self, dialect_name, unique_row=("UQ__operators__email", True)):
        self.calls = []
        self.bind = SimpleNamespace(
            dialect=SimpleNamespace(name=dialect_name),
            execute=lambda _stmt: SimpleNamespace(first=lambda: unique_row),
        )

    def get_bind(self):
        return self.bind

    def batch_alter_table(self, table):
        self.calls.append(("batch", table))
        return nullcontext(self)

    def alter_column(self, table_or_column, column=None, **kwargs):
        self.calls.append(("alter", table_or_column, column, kwargs))

    def drop_constraint(self, name, table, **kwargs):
        self.calls.append(("drop_constraint", name, table, kwargs))

    def create_unique_constraint(self, name, table, columns):
        self.calls.append(("create_unique_constraint", name, table, columns))

    def drop_index(self, name, table_name=None):
        self.calls.append(("drop_index", name, table_name))

    def create_index(self, name, table, columns, unique=False):
        self.calls.append(("create_index", name, table, columns, unique))


def test_mssql_migration_drops_and_recreates_operator_email_unique(monkeypatch):
    migration = _unicode_migration()
    operations = _MigrationOps("mssql")
    # No sa.inspect stub on purpose. SQLAlchemy's MSSQL dialect does not
    # implement get_unique_constraints — the real Inspector raises
    # NotImplementedError — so a test that stubs one is testing a database
    # that does not exist. The MSSQL path must reach sys.indexes via the bind.
    monkeypatch.setattr(migration, "op", operations)
    monkeypatch.setattr(
        migration.sa,
        "inspect",
        lambda _bind: pytest.fail("MSSQL path must not use the inspector"),
    )

    migration.upgrade()

    drop_at = operations.calls.index(
        ("drop_constraint", "UQ__operators__email", "operators", {"type_": "unique"})
    )
    email_alter_at = next(
        i
        for i, call in enumerate(operations.calls)
        if call[:3] == ("alter", "operators", "email")
    )
    recreate_at = operations.calls.index(
        (
            "create_unique_constraint",
            "UQ__operators__email",
            "operators",
            ["email"],
        )
    )
    assert drop_at < email_alter_at < recreate_at
    assert not any(call[0] == "batch" for call in operations.calls)


def test_mssql_migration_uses_drop_index_for_a_plain_unique_index(monkeypatch):
    """is_unique_constraint = 0 means a bare unique index, and SQL Server wants
    DROP INDEX for it — ALTER TABLE DROP CONSTRAINT only works on constraints.
    Getting this backwards fails at DDL time, long after reflection looked fine."""
    migration = _unicode_migration()
    operations = _MigrationOps("mssql", unique_row=("ix_operators_email", False))
    monkeypatch.setattr(migration, "op", operations)

    migration.upgrade()

    drop_at = operations.calls.index(("drop_index", "ix_operators_email", "operators"))
    recreate_at = operations.calls.index(
        ("create_index", "ix_operators_email", "operators", ["email"], True)
    )
    email_alter_at = next(
        i
        for i, call in enumerate(operations.calls)
        if call[:3] == ("alter", "operators", "email")
    )
    assert drop_at < email_alter_at < recreate_at
    assert not any(call[0] == "drop_constraint" for call in operations.calls)


def test_mssql_migration_fails_loudly_when_the_unique_is_missing(monkeypatch):
    migration = _unicode_migration()
    operations = _MigrationOps("mssql", unique_row=None)
    monkeypatch.setattr(migration, "op", operations)

    with pytest.raises(RuntimeError, match="operators.email UNIQUE"):
        migration.upgrade()


def test_unicode_migration_downgrade_rejects_lossy_conversion():
    migration = _unicode_migration()

    with pytest.raises(RuntimeError, match="lossy|one-way"):
        migration.downgrade()


def test_unicode_text_round_trips_byte_for_byte():
    migrate()
    with SessionLocal() as db:
        request = Request(
            ref="REQ-UNICODE",
            title=UNICODE_SAMPLE,
            description=UNICODE_SAMPLE,
            extra_detail=UNICODE_SAMPLE,
            type="enh",
        )
        db.add(request)
        db.commit()
        request_id = request.id

    with SessionLocal() as db:
        loaded = db.get(Request, request_id)
        assert loaded is not None
        assert loaded.title.encode() == UNICODE_SAMPLE.encode()
        assert loaded.description.encode() == UNICODE_SAMPLE.encode()
        assert loaded.extra_detail is not None
        assert loaded.extra_detail.encode() == UNICODE_SAMPLE.encode()


def test_alembic_head_has_no_model_schema_drift(tmp_path):
    db_path = tmp_path / "migrated.db"
    db_url = f"sqlite:///{db_path}"
    env = os.environ.copy()
    env["FACTORY_DB_URL"] = db_url
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=API_DIR,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    engine = create_engine(db_url)
    try:
        with engine.connect() as connection:
            context = MigrationContext.configure(
                connection,
                opts={"compare_type": True, "compare_server_default": False},
            )
            assert context.get_current_revision() == ScriptDirectory.from_config(
                _alembic_config()
            ).get_current_head()
            assert compare_metadata(context, Base.metadata) == []
    finally:
        engine.dispose()


def _alembic_config():
    from alembic.config import Config

    return Config(str(API_DIR / "alembic.ini"))


def _write_drill_db(path: Path, value: str) -> None:
    with closing(sqlite3.connect(path)) as db:
        db.execute("CREATE TABLE drill_rows (value TEXT NOT NULL)")
        db.execute("INSERT INTO drill_rows VALUES (?)", (value,))
        db.commit()


def test_sqlite_backup_restore_drill_preserves_rows(tmp_path):
    live = tmp_path / "factory.db"
    backups = tmp_path / "backups"
    _write_drill_db(live, UNICODE_SAMPLE)

    backup_script = REPO_DIR / "scripts" / "backup-db.sh"
    restore_script = REPO_DIR / "scripts" / "restore-db.sh"
    assert backup_script.exists()
    assert restore_script.exists()

    subprocess.run(
        ["bash", str(backup_script), str(live), str(backups)],
        check=True,
        capture_output=True,
        text=True,
    )
    backup = next(backups.glob("factory-*.db"))

    live.write_bytes(b"deliberately corrupted by the C9 restore drill")
    env = os.environ.copy()
    env["RESTORE_CONFIRMED"] = "1"
    subprocess.run(
        ["bash", str(restore_script), str(backup), str(live)],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    with closing(sqlite3.connect(live)) as db:
        rows = db.execute("SELECT value FROM drill_rows").fetchall()
    assert rows == [(UNICODE_SAMPLE,)]


def test_restore_refuses_an_active_wal_without_force(tmp_path):
    live = tmp_path / "factory.db"
    backup = tmp_path / "backup.db"
    _write_drill_db(backup, "backup")

    active = sqlite3.connect(live)
    try:
        active.execute("PRAGMA journal_mode=WAL")
        active.execute("CREATE TABLE drill_rows (value TEXT NOT NULL)")
        active.execute("INSERT INTO drill_rows VALUES ('live')")
        active.commit()
        wal = Path(f"{live}-wal")
        assert wal.exists()

        result = subprocess.run(
            ["bash", str(REPO_DIR / "scripts" / "restore-db.sh"), str(backup), str(live)],
            env={**os.environ, "RESTORE_CONFIRMED": "1"},
            capture_output=True,
            text=True,
        )

        assert result.returncode == 2
        assert "--force" in result.stderr
        assert active.execute("SELECT value FROM drill_rows").fetchall() == [("live",)]
        assert wal.exists()
    finally:
        active.close()


def test_restore_rolls_back_when_swap_fails_after_move_aside(tmp_path):
    live = tmp_path / "factory.db"
    backup = tmp_path / "backup.db"
    _write_drill_db(live, "original")
    _write_drill_db(backup, "restored")

    result = subprocess.run(
        ["bash", str(REPO_DIR / "scripts" / "restore-db.sh"), str(backup), str(live)],
        env={
            **os.environ,
            "RESTORE_CONFIRMED": "1",
            "RESTORE_FAILPOINT": "after_move_aside",
        },
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "rolling back" in result.stderr
    with closing(sqlite3.connect(live)) as db:
        assert db.execute("SELECT value FROM drill_rows").fetchall() == [("original",)]
    assert not list(tmp_path.glob(".*.restore-*"))
