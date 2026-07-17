"""operators.role — admin decides gates/rollbacks, viewer is read-only.

Revision ID: c9d1f3a5b7e2
Revises: b2c4e6a8d0f1
Create Date: 2026-07-16
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision = "c9d1f3a5b7e2"
down_revision = "b2c4e6a8d0f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "operators",
        sa.Column("role", sa.String(12), nullable=False, server_default="admin"),
    )


def downgrade() -> None:
    op.drop_column("operators", "role")
