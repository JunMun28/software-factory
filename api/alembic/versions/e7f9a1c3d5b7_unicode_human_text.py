"""Store human and user text as NVARCHAR on MSSQL.

This is the dev/fresh-database migration path. A large live Azure SQL database
needs the separately reviewed online shadow-copy/validate/swap cutover runbook.
The revision is intentionally one-way because converting NVARCHAR data back to
VARCHAR/TEXT could lose characters.

Revision ID: e7f9a1c3d5b7
Revises: a1b2c3d4e5f6
Create Date: 2026-07-17
"""

import sqlalchemy as sa
from sqlalchemy.dialects import mssql

from alembic import op

revision = "e7f9a1c3d5b7"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


# (column name, old type, Unicode type, nullable). Short codes and enum-like
# columns intentionally stay VARCHAR; these are the fields that can contain
# human names, prose, filenames, generated HTML/log text, or JSON with prose.


def _nvarchar(length: int):
    return sa.String(length).with_variant(mssql.NVARCHAR(length), "mssql")


def _nvarchar_max():
    return sa.Text().with_variant(mssql.NVARCHAR(None), "mssql")


_COLUMNS = {
    "apps": [
        ("name", sa.String(120), _nvarchar(120), False),
        ("owner", sa.String(120), _nvarchar(120), False),
        ("repo", sa.String(200), _nvarchar(200), False),
    ],
    "operators": [
        ("name", sa.String(120), _nvarchar(120), False),
        ("email", sa.String(200), _nvarchar(200), False),
    ],
    "requests": [
        ("title", sa.String(200), _nvarchar(200), False),
        ("description", sa.Text(), _nvarchar_max(), False),
        ("reach", sa.String(120), _nvarchar(120), True),
        ("impact_value", sa.String(120), _nvarchar(120), True),
        ("new_app_name", sa.String(120), _nvarchar(120), True),
        ("bug_where", sa.String(200), _nvarchar(200), True),
        ("extra_detail", sa.Text(), _nvarchar_max(), True),
        ("needs_human_reason", sa.String(300), _nvarchar(300), True),
        ("reporter", sa.String(80), _nvarchar(80), False),
        ("send_back_question", sa.Text(), _nvarchar_max(), True),
        ("send_back_response", sa.Text(), _nvarchar_max(), True),
        ("spec_open_note", sa.Text(), _nvarchar_max(), True),
        ("prototype_html", sa.Text(), _nvarchar_max(), True),
    ],
    "interview_turns": [
        ("question", sa.Text(), _nvarchar_max(), False),
        ("sub", sa.Text(), _nvarchar_max(), True),
        ("answer", sa.Text(), _nvarchar_max(), True),
    ],
    "prototype_turns": [
        ("instruction", sa.Text(), _nvarchar_max(), True),
        ("note", sa.Text(), _nvarchar_max(), True),
        ("html", sa.Text(), _nvarchar_max(), True),
    ],
    "preview_feedback": [
        ("body", sa.Text(), _nvarchar_max(), False),
        ("author", sa.String(80), _nvarchar(80), False),
        ("disposition_note", sa.Text(), _nvarchar_max(), True),
    ],
    "spec_lines": [("text", sa.Text(), _nvarchar_max(), False)],
    "acceptance_criteria": [("text", sa.Text(), _nvarchar_max(), False)],
    "spec_snapshots": [("spec_md", sa.Text(), _nvarchar_max(), False)],
    "progress_events": [
        ("actor", sa.String(80), _nvarchar(80), False),
        ("title", sa.String(300), _nvarchar(300), False),
        ("body", sa.Text(), _nvarchar_max(), True),
    ],
    "comments": [
        ("author", sa.String(80), _nvarchar(80), False),
        ("body", sa.Text(), _nvarchar_max(), False),
    ],
    "attachments": [("filename", sa.String(255), _nvarchar(255), False)],
    "audit_events": [
        ("actor", sa.String(80), _nvarchar(80), False),
        ("note", sa.Text(), _nvarchar_max(), True),
    ],
    "intents": [
        ("payload_json", sa.Text(), _nvarchar_max(), False),
        ("outcome_json", sa.Text(), _nvarchar_max(), False),
    ],
    "stage_jobs": [("logs_tail", sa.Text(), _nvarchar_max(), True)],
}


def _operator_email_unique() -> tuple[str, str]:
    inspector = sa.inspect(op.get_bind())
    for constraint in inspector.get_unique_constraints("operators"):
        if constraint.get("column_names") == ["email"] and constraint.get("name"):
            return "constraint", constraint["name"]
    for index in getattr(inspector, "get_indexes", lambda _table: [])("operators"):
        if (
            index.get("unique")
            and index.get("column_names") == ["email"]
            and index.get("name")
        ):
            return "index", index["name"]
    raise RuntimeError("operators.email UNIQUE index/constraint was not found")


def _alter_sqlite() -> None:
    for table, columns in _COLUMNS.items():
        with op.batch_alter_table(table) as batch:
            for name, plain_type, unicode_type, nullable in columns:
                batch.alter_column(
                    name,
                    existing_type=plain_type,
                    type_=unicode_type,
                    existing_nullable=nullable,
                )


def _alter_mssql() -> None:
    unique_kind, unique_name = _operator_email_unique()
    if unique_kind == "constraint":
        op.drop_constraint(unique_name, "operators", type_="unique")
    else:
        op.drop_index(unique_name, table_name="operators")

    for table, columns in _COLUMNS.items():
        for name, plain_type, unicode_type, nullable in columns:
            op.alter_column(
                table,
                name,
                existing_type=plain_type,
                type_=unicode_type,
                existing_nullable=nullable,
            )

    if unique_kind == "constraint":
        op.create_unique_constraint(unique_name, "operators", ["email"])
    else:
        op.create_index(unique_name, "operators", ["email"], unique=True)


def upgrade() -> None:
    if op.get_bind().dialect.name == "mssql":
        _alter_mssql()
    else:
        _alter_sqlite()


def downgrade() -> None:
    raise RuntimeError(
        "one-way migration: downgrading NVARCHAR human text would be lossy"
    )
