"""Database setup — SQLAlchemy, SQLite locally (ADR 0007: DB-agnostic, swap-later seam)."""
from sqlalchemy import create_engine, event, select, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from . import settings

DB_URL = settings.DB_URL


def _engine_kwargs(db_url: str) -> dict:
    if db_url.startswith("sqlite"):
        return {"connect_args": {"check_same_thread": False}}
    # Azure SQL: the gateway kills idle connections (~30 min) and reconfigures
    # under you — pre-ping detects dead pooled connections, recycle beats the
    # gateway's idle timeout (spec §3.1, review F-D10). Twenty steady plus
    # twenty overflow connections match AnyIO's 40-thread default; the bounded
    # wait fails pressure promptly instead of pinning a request thread.
    return {
        "pool_pre_ping": True,
        "pool_recycle": 1800,
        "pool_size": 20,
        "max_overflow": 20,
        "pool_timeout": 10,
    }


engine = create_engine(DB_URL, **_engine_kwargs(DB_URL))

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


def _repair_duplicate_turn_orders(conn, table) -> int:
    """Renumber a duplicate legacy history in stable ``(order, id)`` order."""
    rows = conn.execute(
        select(table.c.id, table.c.request_id, table.c.order).order_by(
            table.c.request_id,
            table.c.order,
            table.c.id,
        )
    ).all()
    by_request: dict[int, list[tuple[int, int]]] = {}
    for turn_id, request_id, order in rows:
        by_request.setdefault(request_id, []).append((turn_id, order))

    repaired = 0
    for request_rows in by_request.values():
        orders = [order for _, order in request_rows]
        if len(set(orders)) == len(orders):
            continue
        for next_order, (turn_id, order) in enumerate(request_rows):
            if order == next_order:
                continue
            conn.execute(
                table.update().where(table.c.id == turn_id).values(order=next_order)
            )
            repaired += 1
    return repaired


def migrate() -> list[str]:
    """SQLite: create_all + PRAGMA differ (fast test/dev path).
    Anything else (Azure SQL): versioned Alembic migrations only —
    the schema now outlives deployments (spec §3.1).

    SQLite path: create_all never adds columns or indexes to existing tables, so
    diff every model against PRAGMA metadata and add whatever is missing. Generic
    on purpose: the next model change must not need a hand-written schema branch
    here to avoid 500ing existing DBs at runtime (ADR 0013).

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
        # NOTE(plan-008): Phase 1 databases can legitimately predate the order
        # uniqueness rule. Preserve every turn and its deterministic chronology
        # before creating the backstop indexes.
        repaired = sum(
            _repair_duplicate_turn_orders(conn, Base.metadata.tables[table_name])
            for table_name in ("interview_turns", "prototype_turns")
        )
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
            for index in sorted(table.indexes, key=lambda item: item.name or ""):
                if index.name is None:
                    continue
                have_indexes = {
                    row[1]
                    for row in conn.execute(text(f"PRAGMA index_list({table.name})"))
                }
                if index.name not in have_indexes:
                    index.create(bind=conn)
                    added.append(f"{table.name}.{index.name}")
        # NOTE(plan-008): older SQLite files may contain JSON text `null` from
        # JSON(none_as_null=False). Normalize it so pending-question CAS guards
        # see the same SQL NULL state as new databases and Azure SQL.
        normalized = conn.execute(
            text(
                "UPDATE requests SET pending_question = NULL "
                "WHERE pending_question = 'null'"
            )
        ).rowcount
        if added or normalized or repaired:
            conn.commit()
    return added
