"""stage_jobs — one row per spawned Kubernetes Job (Plan B1, spec §3.4)

Revision ID: 7f2a9c4d1e88
Revises: b71c2e4f9a10
Create Date: 2026-07-15

"""
from datetime import datetime, timezone

import sqlalchemy as sa
from sqlalchemy.types import TypeDecorator

from alembic import op


class TZDateTime(TypeDecorator[datetime]):
    """Frozen migration copy: naive UTC in storage, aware UTC in Python."""

    impl = sa.DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("TZDateTime requires a timezone-aware datetime")
        return value.astimezone(timezone.utc).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

# revision identifiers, used by Alembic.
revision = "7f2a9c4d1e88"
down_revision = "b71c2e4f9a10"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "stage_jobs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("request_id", sa.Integer(), nullable=False),
        sa.Column("stage", sa.String(length=16), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("role", sa.String(length=8), nullable=False),
        sa.Column("job_name", sa.String(length=63), nullable=False),
        sa.Column("epoch", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(length=12), nullable=False, server_default="running"),
        sa.Column("envelope", sa.JSON(), nullable=True),
        sa.Column("logs_tail", sa.Text(), nullable=True),
        sa.Column("deadline_at", TZDateTime(), nullable=False),
        sa.Column("created_at", TZDateTime(), nullable=False),
        sa.Column("completed_at", TZDateTime(), nullable=True),
        sa.ForeignKeyConstraint(["request_id"], ["requests.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_stage_jobs_job_name"), "stage_jobs", ["job_name"], unique=False)
    op.create_index(op.f("ix_stage_jobs_request_id"), "stage_jobs", ["request_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_stage_jobs_request_id"), table_name="stage_jobs")
    op.drop_index(op.f("ix_stage_jobs_job_name"), table_name="stage_jobs")
    op.drop_table("stage_jobs")
