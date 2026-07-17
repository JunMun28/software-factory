"""Harness lineage + human gate feedback (self-harness analysis 2026-07-16).

stage_jobs.harness_version — content digest of the prompt pack + policy knobs
an attempt ran under (harness.py); requests.pending_feedback — a human's
gate-reject reason waiting to be injected into the next agent attempt.

Revision ID: e7a9c1d3b5f0
Revises: c9d1f3a5b7e2
Create Date: 2026-07-16
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision = "e7a9c1d3b5f0"
down_revision = "c9d1f3a5b7e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "stage_jobs",
        sa.Column("harness_version", sa.String(16), nullable=True),
    )
    op.add_column(
        "requests",
        sa.Column("pending_feedback", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("requests", "pending_feedback")
    op.drop_column("stage_jobs", "harness_version")
