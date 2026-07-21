"""import_edits: pending ng-v0 sandbox edits (bridge piece 2)

Revision ID: a2f4c6e8b0d2
Revises: b7d9f1a3c5e8
Create Date: 2026-07-21
"""

from datetime import datetime, timezone

import sqlalchemy as sa
from sqlalchemy.dialects import mssql
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


revision = "a2f4c6e8b0d2"
down_revision = "b7d9f1a3c5e8"
branch_labels = None
depends_on = None


def _nvarchar(length: int):
    return sa.String(length).with_variant(mssql.NVARCHAR(length), "mssql")


def _nvarchar_max():
    return sa.Text().with_variant(mssql.NVARCHAR(None), "mssql")


def upgrade() -> None:
    op.create_table(
        "import_edits",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("request_id", sa.Integer(), nullable=False),
        sa.Column("round", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("base_sha", sa.String(length=40), nullable=False),
        sa.Column("head_sha", sa.String(length=40), nullable=False),
        sa.Column("temp_ref", sa.String(length=80), nullable=False),
        sa.Column("summary", _nvarchar_max(), nullable=False, server_default=""),
        sa.Column("versions", sa.JSON(), nullable=True),
        sa.Column("actor", _nvarchar(80), nullable=False),
        sa.Column(
            "status", sa.String(length=12), nullable=False, server_default="pending"
        ),
        sa.Column("gate_job", sa.String(length=63), nullable=True),
        sa.Column("gate_uid", sa.String(length=36), nullable=True),
        sa.Column("gate_tail", _nvarchar_max(), nullable=True),
        sa.Column("deadline_at", TZDateTime(), nullable=True),
        sa.Column("created_at", TZDateTime(), nullable=False),
        sa.Column("updated_at", TZDateTime(), nullable=False),
        sa.ForeignKeyConstraint(["request_id"], ["requests.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_import_edits_request_id"),
        "import_edits",
        ["request_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_import_edits_request_id"), table_name="import_edits")
    op.drop_table("import_edits")
