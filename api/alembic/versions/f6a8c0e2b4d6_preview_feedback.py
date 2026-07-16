"""preview feedback and round counter (C1)

Revision ID: f6a8c0e2b4d6
Revises: d4e6f8a0c2b4
Create Date: 2026-07-16
"""

import sqlalchemy as sa

from alembic import op

revision = "f6a8c0e2b4d6"
down_revision = "d4e6f8a0c2b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("requests") as batch:
        batch.add_column(
            sa.Column(
                "preview_round", sa.Integer(), nullable=False, server_default="0"
            )
        )
    op.create_table(
        "preview_feedback",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("request_id", sa.Integer(), nullable=False),
        sa.Column("round", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("page_path", sa.String(length=300), nullable=True),
        sa.Column("annotation", sa.JSON(), nullable=True),
        sa.Column("attachment_id", sa.Integer(), nullable=True),
        sa.Column("author", sa.String(length=80), nullable=False),
        sa.Column(
            "disposition", sa.String(length=10), nullable=False, server_default="open"
        ),
        sa.Column("disposition_note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["attachment_id"], ["attachments.id"]),
        sa.ForeignKeyConstraint(["request_id"], ["requests.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_preview_feedback_request_id"),
        "preview_feedback",
        ["request_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_preview_feedback_request_id"), table_name="preview_feedback"
    )
    op.drop_table("preview_feedback")
    with op.batch_alter_table("requests") as batch:
        batch.drop_column("preview_round")
