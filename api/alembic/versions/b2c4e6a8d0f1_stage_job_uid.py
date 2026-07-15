"""stage_jobs.job_uid — same-name recreate disambiguation (Plan B2 task 1)

Revision ID: b2c4e6a8d0f1
Revises: 7f2a9c4d1e88
Create Date: 2026-07-15
"""

import sqlalchemy as sa

from alembic import op

revision = "b2c4e6a8d0f1"
down_revision = "7f2a9c4d1e88"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("stage_jobs", sa.Column("job_uid", sa.String(36), nullable=True))


def downgrade() -> None:
    op.drop_column("stage_jobs", "job_uid")
