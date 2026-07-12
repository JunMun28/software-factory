"""Named console operators and the server-side actor-resolution seam."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Operator
from ..schemas import OperatorIn, OperatorOut

router = APIRouter()


def resolve_operator(db: Session, operator_id: int) -> Operator:
    operator = db.get(Operator, operator_id)
    if operator is None:
        raise HTTPException(404, f"Unknown operator id {operator_id}")
    return operator


@router.get("/api/operators", response_model=list[OperatorOut])
def list_operators(db: Session = Depends(get_db)):
    return db.scalars(select(Operator).order_by(Operator.name, Operator.id)).all()


@router.post("/api/operators", response_model=OperatorOut, status_code=201)
def create_operator(body: OperatorIn, db: Session = Depends(get_db)):
    if db.scalar(select(Operator).where(Operator.email == body.email.strip().lower())):
        raise HTTPException(409, "An operator with that email already exists")
    operator = Operator(
        name=body.name.strip(), initials=body.initials.strip().upper(),
        hue=body.hue.upper(), email=body.email.strip().lower(),
    )
    db.add(operator)
    db.commit()
    db.refresh(operator)
    return operator
