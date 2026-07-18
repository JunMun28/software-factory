from sqlmodel import Field, SQLModel


class Item(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str
    description: str


class ItemCreate(SQLModel):
    name: str
    description: str


class ItemRead(SQLModel):
    id: int
    name: str
    description: str
