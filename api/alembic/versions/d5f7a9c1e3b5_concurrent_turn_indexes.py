"""concurrent intake turn indexes

Revision ID: d5f7a9c1e3b5
Revises: c3e5a7b9d1f4
Create Date: 2026-07-20
"""

import sqlalchemy as sa

from alembic import op

revision = "d5f7a9c1e3b5"
down_revision = "c3e5a7b9d1f4"
branch_labels = None
depends_on = None


def _repair_duplicate_turn_orders(table_name: str) -> None:
    table = sa.table(
        table_name,
        sa.column("id", sa.Integer()),
        sa.column("request_id", sa.Integer()),
        sa.column("order", sa.Integer()),
    )
    rows = op.get_bind().execute(
        sa.select(table.c.id, table.c.request_id, table.c.order).order_by(
            table.c.request_id,
            table.c.order,
            table.c.id,
        )
    ).all()
    by_request: dict[int, list[tuple[int, int]]] = {}
    for turn_id, request_id, order in rows:
        by_request.setdefault(request_id, []).append((turn_id, order))

    for request_rows in by_request.values():
        orders = [order for _, order in request_rows]
        if len(set(orders)) == len(orders):
            continue
        for next_order, (turn_id, order) in enumerate(request_rows):
            if order == next_order:
                continue
            op.get_bind().execute(
                sa.update(table).where(table.c.id == turn_id).values(order=next_order)
            )


def upgrade() -> None:
    # NOTE(plan-008): pending_question historically encoded Python None as
    # JSON text `null`; CAS needs one portable SQL NULL empty state.
    op.execute(
        sa.text(
            "UPDATE requests SET pending_question = NULL "
            "WHERE pending_question = 'null'"
        )
    )
    # NOTE(plan-008): retain every legacy turn in deterministic chronology before
    # the unique indexes are installed.
    _repair_duplicate_turn_orders("interview_turns")
    _repair_duplicate_turn_orders("prototype_turns")
    op.create_index(
        "uq_interview_turns_request_order",
        "interview_turns",
        ["request_id", "order"],
        unique=True,
    )
    op.create_index(
        "uq_prototype_turns_request_order",
        "prototype_turns",
        ["request_id", "order"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "uq_prototype_turns_request_order",
        table_name="prototype_turns",
    )
    op.drop_index(
        "uq_interview_turns_request_order",
        table_name="interview_turns",
    )
