"""merge Plan C stack with reject-gate + harness lineage

Revision ID: 7a7baeeea188
Revises: e7a9c1d3b5f0, e7f9a1c3d5b7
Create Date: 2026-07-17 12:28:12.708719

"""
from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '7a7baeeea188'
down_revision: Union[str, Sequence[str], None] = ('e7a9c1d3b5f0', 'e7f9a1c3d5b7')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
