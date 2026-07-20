"""Add durable request classification results.

Revision ID: c3e5a7b9d1f4
Revises: 7a7baeeea188
Create Date: 2026-07-20
"""

import sqlalchemy as sa

from alembic import op

revision = "c3e5a7b9d1f4"
down_revision = "7a7baeeea188"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "requests",
        sa.Column("classification_result", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("requests", "classification_result")
