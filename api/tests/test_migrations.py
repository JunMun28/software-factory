"""Alembic owns non-SQLite schema; SQLite keeps the fast create_all path."""
import subprocess
import tempfile


def test_alembic_upgrade_head_builds_full_schema_on_fresh_db():
    # a fresh SQLite file stands in for "empty database" — the point is that
    # the alembic history alone (no create_all) produces every table
    with tempfile.TemporaryDirectory() as tmp:
        url = f"sqlite:///{tmp}/mig.db"
        r = subprocess.run(
            ["uv", "run", "alembic", "upgrade", "head"],
            env={"FACTORY_DB_URL": url, "PATH": __import__("os").environ["PATH"]},
            capture_output=True, text=True, cwd=".",
        )
        assert r.returncode == 0, r.stderr
        from sqlalchemy import create_engine, inspect
        insp = inspect(create_engine(url))
        tables = set(insp.get_table_names())
        # spot-check the load-bearing tables
        assert {"requests", "progress_events"} <= tables, tables
