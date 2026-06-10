"""Database setup — SQLAlchemy, SQLite locally (ADR 0007: DB-agnostic, swap-later seam)."""
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from . import settings

DB_URL = settings.DB_URL

engine = create_engine(DB_URL, connect_args={"check_same_thread": False} if DB_URL.startswith("sqlite") else {})

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


def migrate() -> list[str]:
    """create_all never adds columns to existing tables, so diff every model
    against PRAGMA table_info and ALTER TABLE ADD COLUMN whatever is missing.
    Generic on purpose: the next model change must not need a hand-written
    branch here to avoid 500ing existing DBs at runtime (ADR 0013)."""
    Base.metadata.create_all(engine)
    added: list[str] = []
    if not DB_URL.startswith("sqlite"):
        return added
    with engine.connect() as conn:
        for table in Base.metadata.sorted_tables:
            have = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table.name})"))}
            for col in table.columns:
                if col.name not in have:
                    ddl = f"ALTER TABLE {table.name} ADD COLUMN {col.name} {col.type.compile(engine.dialect)}"
                    conn.execute(text(ddl))
                    added.append(f"{table.name}.{col.name}")
        if added:
            conn.commit()
    return added
