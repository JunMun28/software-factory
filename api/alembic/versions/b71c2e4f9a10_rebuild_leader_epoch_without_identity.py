"""rebuild leader epoch without identity

Revision ID: b71c2e4f9a10
Revises: 482ab25da09c
Create Date: 2026-07-15 11:15:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b71c2e4f9a10"
down_revision: Union[str, Sequence[str], None] = "482ab25da09c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Recreate the singleton table so MSSQL does not render id as IDENTITY."""
    op.drop_table("leader_epochs")
    op.create_table(
        "leader_epochs",
        sa.Column("id", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("epoch", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute("INSERT INTO leader_epochs (id, epoch) VALUES (1, 0)")


def downgrade() -> None:
    """Restore the former integer-primary-key schema, including its seed row."""
    op.drop_table("leader_epochs")
    op.create_table(
        "leader_epochs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("epoch", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    if op.get_bind().dialect.name == "mssql":
        op.execute("SET IDENTITY_INSERT leader_epochs ON")
        op.execute("INSERT INTO leader_epochs (id, epoch) VALUES (1, 0)")
        op.execute("SET IDENTITY_INSERT leader_epochs OFF")
    else:
        op.execute("INSERT INTO leader_epochs (id, epoch) VALUES (1, 0)")
