from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session, select

from app.db import create_tables, engine
from app.models import Item, ItemCreate, ItemRead
from app.seed import seed_items


@asynccontextmanager
async def lifespan(_: FastAPI):
    create_tables()
    seed_items()
    yield


app = FastAPI(lifespan=lifespan)
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health")
def factory_health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/items", response_model=list[ItemRead])
def list_items() -> list[Item]:
    with Session(engine) as session:
        return list(session.exec(select(Item)).all())


@app.post("/api/items", response_model=ItemRead, status_code=201)
def create_item(payload: ItemCreate) -> Item:
    item = Item(name=payload.name, description=payload.description)
    with Session(engine) as session:
        session.add(item)
        session.commit()
        session.refresh(item)
        if item.id is None:
            raise HTTPException(status_code=500, detail="Failed to create item")
        return item


if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="frontend")
