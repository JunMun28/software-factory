from sqlmodel import Session, select

from app.db import create_tables, engine
from app.models import Item

SEED_ITEMS = [
    {"name": "Welcome", "description": "Your Golden Template is ready."},
    {"name": "Angular", "description": "Standalone, zoneless frontend with spartan/ui."},
    {"name": "FastAPI", "description": "SQLite-backed API served under /api."},
]


def seed_items() -> None:
    """Insert example items when the table is empty (idempotent)."""
    create_tables()
    with Session(engine) as session:
        existing = session.exec(select(Item)).first()
        if existing is not None:
            return
        for row in SEED_ITEMS:
            session.add(Item(**row))
        session.commit()


if __name__ == "__main__":
    seed_items()
    print("Seed complete.")
