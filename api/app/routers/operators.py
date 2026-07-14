"""Named console operators and the server-side actor-resolution seam."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import App, Operator, OperatorAppMute
from ..revision import bump_revision
from ..schemas import AppSubscriptionIn, AppSubscriptionOut, OperatorIn, OperatorOut

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
    bump_revision()
    return operator


@router.get(
    "/api/operators/{operator_id}/subscriptions",
    response_model=list[AppSubscriptionOut],
)
def list_subscriptions(operator_id: int, db: Session = Depends(get_db)):
    resolve_operator(db, operator_id)
    muted = set(
        db.scalars(
            select(OperatorAppMute.app_id).where(OperatorAppMute.operator_id == operator_id)
        ).all()
    )
    return [
        AppSubscriptionOut(
            app_id=app.id,
            key=app.key,
            name=app.name,
            subscribed=app.id not in muted,
        )
        for app in db.scalars(select(App).order_by(App.id)).all()
    ]


@router.put(
    "/api/operators/{operator_id}/subscriptions/{app_id}",
    response_model=AppSubscriptionOut,
)
def update_subscription(
    operator_id: int,
    app_id: int,
    body: AppSubscriptionIn,
    db: Session = Depends(get_db),
):
    resolve_operator(db, operator_id)
    app = db.get(App, app_id)
    if app is None:
        raise HTTPException(404, f"Unknown app id {app_id}")
    mute = db.get(OperatorAppMute, (operator_id, app_id))
    changed = False
    if body.subscribed and mute is not None:
        db.delete(mute)
        changed = True
    elif not body.subscribed and mute is None:
        db.add(OperatorAppMute(operator_id=operator_id, app_id=app_id))
        changed = True
    if changed:
        db.commit()
        bump_revision()
    return AppSubscriptionOut(
        app_id=app.id,
        key=app.key,
        name=app.name,
        subscribed=body.subscribed,
    )
