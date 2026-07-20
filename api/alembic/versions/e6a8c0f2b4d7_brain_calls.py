"""brain_calls claims and API usage telemetry (Plan 008 Phase 3)

Revision ID: e6a8c0f2b4d7
Revises: d5f7a9c1e3b5
Create Date: 2026-07-20
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


revision = "e6a8c0f2b4d7"
down_revision = "d5f7a9c1e3b5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "brain_calls",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("request_id", sa.Integer(), nullable=True),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("dedup_key", sa.String(length=128), nullable=True),
        sa.Column("model", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("tokens_in", sa.Integer(), nullable=True),
        sa.Column("tokens_out", sa.Integer(), nullable=True),
        sa.Column("ttft_ms", sa.Integer(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("created_at", TZDateTime(), nullable=False),
        sa.Column("finished_at", TZDateTime(), nullable=True),
        sa.ForeignKeyConstraint(["request_id"], ["requests.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_brain_calls_request_id"),
        "brain_calls",
        ["request_id"],
        unique=False,
    )
    op.create_index(
        "uq_brain_calls_dedup_key",
        "brain_calls",
        ["dedup_key"],
        unique=True,
        sqlite_where=sa.text("dedup_key IS NOT NULL"),
        mssql_where=sa.text("dedup_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_brain_calls_dedup_key", table_name="brain_calls")
    op.drop_index(op.f("ix_brain_calls_request_id"), table_name="brain_calls")
    op.drop_table("brain_calls")
