from pathlib import Path

from sqlmodel import SQLModel, create_engine

DATABASE_PATH = Path(__file__).resolve().parent.parent / "app.db"
DATABASE_URL = f"sqlite:///{DATABASE_PATH}"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


def create_tables() -> None:
    """Create all tables defined on SQLModel metadata."""
    SQLModel.metadata.create_all(engine)
