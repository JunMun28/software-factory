"""Record intake-question tool round counts.

Revision ID: f7b9d1e3c5a7
Revises: e6a8c0f2b4d7
Create Date: 2026-07-20
"""

import sqlalchemy as sa

from alembic import op

revision = "f7b9d1e3c5a7"
down_revision = "e6a8c0f2b4d7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "brain_calls",
        sa.Column("tool_rounds", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("brain_calls", "tool_rounds")
