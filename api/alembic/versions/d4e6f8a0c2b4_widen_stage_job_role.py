"""stage_jobs.role String(8)->String(16) — headroom for teardown/preview roles (C2a / OPERATE-02)

"teardown" is exactly 8 chars = zero headroom on VARCHAR(8); C1 adds
preview/replan roles. SQLite does not enforce length (fresh test DBs get 16 via
create_all), so this migration matters for MSSQL/Azure SQL where VARCHAR(8)
would truncate/reject the new role values.

Revision ID: d4e6f8a0c2b4
Revises: b2c4e6a8d0f1
Create Date: 2026-07-16
"""

import sqlalchemy as sa

from alembic import op

revision = "d4e6f8a0c2b4"
down_revision = "b2c4e6a8d0f1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # batch mode so a fresh SQLite dev/test DB can run upgrade head (SQLite has
    # no ALTER COLUMN TYPE); on MSSQL/Postgres this is a plain widening ALTER.
    with op.batch_alter_table("stage_jobs") as batch:
        batch.alter_column(
            "role",
            existing_type=sa.String(8),
            type_=sa.String(16),
            existing_nullable=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("stage_jobs") as batch:
        batch.alter_column(
            "role",
            existing_type=sa.String(16),
            type_=sa.String(8),
            existing_nullable=False,
        )
