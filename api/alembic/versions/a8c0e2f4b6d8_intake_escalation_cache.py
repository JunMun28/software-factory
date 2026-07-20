"""Cache optional intake team-routing proposals.

Revision ID: a8c0e2f4b6d8
Revises: f7b9d1e3c5a7
Create Date: 2026-07-20
"""

import sqlalchemy as sa

from alembic import op

revision = "a8c0e2f4b6d8"
down_revision = "f7b9d1e3c5a7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "requests",
        sa.Column("intake_escalation", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("requests", "intake_escalation")
