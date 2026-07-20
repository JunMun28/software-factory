"""Index requests.reporter for the per-user daily brain budget (Plan 008 Phase 0)

The budget aggregate (brain_calls.budget_exhausted) sums today's brain_calls
owned by one reporter, joining brain_calls -> requests on the existing request_id
index and filtering requests.reporter. Indexing reporter anchors that per-user
scan so a polling user's budget check stays cheap.

Revision ID: b7d9f1a3c5e8
Revises: a8c0e2f4b6d8
Create Date: 2026-07-20
"""

from alembic import op

revision = "b7d9f1a3c5e8"
down_revision = "a8c0e2f4b6d8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        op.f("ix_requests_reporter"),
        "requests",
        ["reporter"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_requests_reporter"), table_name="requests")
