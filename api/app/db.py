"""Database setup — SQLAlchemy, SQLite locally (ADR 0007: DB-agnostic, swap-later seam)."""
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from . import settings

DB_URL = settings.DB_URL

if DB_URL.startswith("sqlite"):
    engine = create_engine(DB_URL, connect_args={"check_same_thread": False})
else:
    # Azure SQL: the gateway kills idle connections (~30 min) and reconfigures
    # under you — pre-ping detects dead pooled connections, recycle beats the
    # gateway's idle timeout (spec §3.1, review F-D10)
    engine = create_engine(DB_URL, pool_pre_ping=True, pool_recycle=1800)

if DB_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):
        # WAL lets the many poll readers proceed while a pipeline thread commits;
        # busy_timeout queues writers instead of raising "database is locked";
        # SQLite leaves foreign keys OFF unless asked (ADR 0013)
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _default_literal(col) -> str | None:
    """SQL literal for a column's python-side scalar default, if it has one."""
    d = col.default
    if d is None or not getattr(d, "is_scalar", False):
        return None
    v = d.arg
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    return None


def migrate() -> list[str]:
    """SQLite: create_all + PRAGMA differ (fast test/dev path).
    Anything else (Azure SQL): versioned Alembic migrations only —
    the schema now outlives deployments (spec §3.1).

    SQLite path: create_all never adds columns to existing tables, so diff
    every model against PRAGMA table_info and ALTER TABLE ADD COLUMN whatever
    is missing. Generic on purpose: the next model change must not need a
    hand-written branch here to avoid 500ing existing DBs at runtime (ADR 0013).

    Columns with a scalar default carry it into the DDL, so pre-existing rows
    take the model's default instead of NULL — a new NOT NULL column must
    never make the response models choke on old rows."""
    if not DB_URL.startswith("sqlite"):
        from pathlib import Path

        from alembic.config import Config

        from alembic import command
        cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
        command.upgrade(cfg, "head")
        return []
    Base.metadata.create_all(engine)
    added: list[str] = []
    with engine.connect() as conn:
        for table in Base.metadata.sorted_tables:
            have = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table.name})"))}
            for col in table.columns:
                if col.name not in have:
                    ddl = f"ALTER TABLE {table.name} ADD COLUMN {col.name} {col.type.compile(engine.dialect)}"
                    lit = _default_literal(col)
                    if lit is not None:
                        ddl += f" DEFAULT {lit}" if col.nullable else f" NOT NULL DEFAULT {lit}"
                    conn.execute(text(ddl))
                    added.append(f"{table.name}.{col.name}")
        if added:
            conn.commit()
    return added
