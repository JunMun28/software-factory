"""Add append-only acceptance criteria and immutable spec snapshots.

Revision ID: a1b2c3d4e5f6
Revises: f6a8c0e2b4d6
"""

import sqlalchemy as sa

from alembic import op

revision = "a1b2c3d4e5f6"
down_revision = "f6a8c0e2b4d6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "acceptance_criteria",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("request_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("code", sa.String(length=12), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("prov", sa.String(length=20), nullable=True),
        sa.Column(
            "assume", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("source_order", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["request_id"], ["requests.id"]),
        sa.UniqueConstraint(
            "request_id", "version", "code", name="uq_ac_req_ver_code"
        ),
    )
    op.create_index(
        op.f("ix_acceptance_criteria_request_id"),
        "acceptance_criteria",
        ["request_id"],
    )
    op.create_table(
        "spec_snapshots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("request_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("spec_md", sa.Text(), nullable=False),
        sa.Column("criteria_json", sa.JSON(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["request_id"], ["requests.id"]),
        sa.UniqueConstraint("request_id", "version", name="uq_snapshot_req_ver"),
    )
    op.create_index(
        op.f("ix_spec_snapshots_request_id"),
        "spec_snapshots",
        ["request_id"],
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_spec_snapshots_request_id"), table_name="spec_snapshots"
    )
    op.drop_table("spec_snapshots")
    op.drop_index(
        op.f("ix_acceptance_criteria_request_id"),
        table_name="acceptance_criteria",
    )
    op.drop_table("acceptance_criteria")
