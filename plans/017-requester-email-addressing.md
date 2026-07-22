# Plan 017: Address requester emails to an email address, not a display name

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5b9facb..HEAD -- api/app/notifications.py api/app/models.py api/app/routers/requests.py api/alembic/versions/`
> If any of those changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition. In particular, re-check the Alembic head
> before writing the new migration (Step 2).

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `5b9facb`, 2026-07-21

## Why this matters

Two requester-facing notifications exist — *"preview needs your review"* and
*"sandbox edit needs another pass"*. Both are addressed to `req.reporter`,
which is a **display name** like `"Jordan D."`, not an email address.

That is not a valid RFC 5322 `To:` header. The moment SMTP is actually
configured, every one of these emails is rejected by the SMTP server, and the
failure is swallowed by a `try/except Exception: log.exception(...)`. Nothing
in the product surfaces it.

Today it looks fine because `smtp_status()` returns `log-only` without
`SMTP_HOST`/`SMTP_FROM`, so the message is written to the log and never
delivered anywhere. This defect is invisible until the day someone turns real
email on — and on that day, the preview-acceptance gate quietly stops notifying
anyone. Requests then sit at the gate until `_sweep_preview_ttl`
(`api/app/kube_runner.py`) escalates them to an operator as a *timeout*, which
is a misleading diagnosis of a mail bug.

The information needed is already available and already discarded:
`current_identity()` returns `{name, email, initials}`, and the request
creation path stores only the name.

## Current state

### `api/app/notifications.py:85-103` — the display name used as `To:`

```python
def _notify_requester(req: Request, subject: str, body: str) -> None:
    """Send the requester-owned preview gate to the reporter, not operators."""
    link = (
        f"{_env('INTAKE_BASE_URL', 'http://localhost:4201').rstrip('/')}"
        f"/submit/{req.id}"
    )
    message = EmailMessage()
    message["From"] = _env("SMTP_FROM", "aires@localhost")
    message["To"] = req.reporter
    message["Subject"] = subject
    message.set_content(f"{body} {link}")
    try:
        send_email(message)
    except Exception:
        log.exception(
            "email delivery failed; preview gate state preserved (to=%s subject=%s)",
            req.reporter,
            subject,
        )
```

Its two callers are `notify_gate_raised` (`:106-113`, for the
`accept_preview` gate) and `notify_import_rejected` (`:128-137`).

Contrast `_notify` (`:61-82`), the operator path, which correctly uses
`operator.email` — and `_recipients` (`:45-58`) which even filters
`Operator.email.isnot(None), Operator.email != ""`. The requester path simply
has no email to use.

### `api/app/models.py:167-171` — reporter is a name

```python
    # Indexed: the per-user daily brain budget (Plan 008 Phase 0 / D6) anchors its
    # usage aggregate on this reporter identity (brain_calls join requests).
    reporter: Mapped[str] = mapped_column(
        human_string(80), default="Jordan D.", index=True
    )
    reporter_initials: Mapped[str] = mapped_column(String(4), default="JD")
```

**Important**: `reporter` is load-bearing beyond display — the per-user daily
brain budget joins on it. Do **not** repurpose or change it.

`human_string` is defined at `api/app/models.py:27-29`:

```python
def human_string(length: int):
    """Human text: portable String locally, explicit NVARCHAR on MSSQL."""
    return String(length).with_variant(mssql.NVARCHAR(length), "mssql")
```

`Operator.email` (`api/app/models.py:85`) is the precedent for an email
column: `mapped_column(human_string(200), unique=True)`.

### `api/app/routers/requests.py:769-784` — where the email is discarded

```python
def create_request(body: RequestCreate, db: Session = Depends(get_db)):
    # SEC-01: with the auth wall on, the reporter is WHO SIGNED IN — the body
    # fields degrade to untrusted UI state (same rule as operator override).
    identity = current_identity()
    reporter = identity["name"] if identity else body.reporter
    reporter_initials = identity["initials"] if identity else body.reporter_initials
    # persist-first (PRD hardening #4): the Request exists before anything else
    for attempt in (0, 1):
        r = Request(
            ref=next_ref(db), title=body.title or "(untitled request)", …
            reporter=reporter, reporter_initials=reporter_initials,
        )
```

`current_identity()` returns `{"name": …, "email": …, "initials": …}` — see
`api/app/auth.py:272-273`, which sets exactly those three keys. The email is
right there and thrown away.

### `api/app/notifications.py:35-42` — SMTP with no TLS

```python
    host = _env("SMTP_HOST")
    port = int(_env("SMTP_PORT", "25"))
    with smtplib.SMTP(host, port, timeout=10) as smtp:
        user = _env("SMTP_USER")
        password = _env("SMTP_PASSWORD")
        if user and password:
            smtp.login(user, password)
        smtp.send_message(message)
```

`smtp.login()` sends the credentials base64-encoded over a **cleartext**
socket. There is no `starttls()`.

### Alembic

Current head is `a2f4c6e8b0d2` (`api/alembic/versions/a2f4c6e8b0d2_import_edits.py:38-39`
— `revision = "a2f4c6e8b0d2"`, `down_revision = "b7d9f1a3c5e8"`). Verify this
is still the head before writing yours (Step 2).

Add-column exemplar — `api/alembic/versions/c9d1f3a5b7e2_operator_role.py`:

```python
"""operators.role — admin decides gates/rollbacks, viewer is read-only.

Revision ID: c9d1f3a5b7e2
Revises: b2c4e6a8d0f1
Create Date: 2026-07-16
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision = "c9d1f3a5b7e2"
down_revision = "b2c4e6a8d0f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "operators",
        sa.Column("role", sa.String(12), nullable=False, server_default="admin"),
    )


def downgrade() -> None:
    op.drop_column("operators", "role")
```

Note the MSSQL variant helper used by the newer migrations
(`a2f4c6e8b0d2_import_edits.py:44-46`):

```python
def _nvarchar(length: int):
    return sa.String(length).with_variant(mssql.NVARCHAR(length), "mssql")
```

The same code runs on SQLite **and** Azure SQL, so use that helper for a text
column.

### Conventions to match

- Comments explain **why**, and reference the plan/ADR that drove them.
- Tests: `api/tests/test_email_and_freshness.py` is the exemplar — it uses the
  `client` fixture and `monkeypatch`, e.g.
  `test_spec_gate_emails_exactly_subscribed_operators_with_dossier_link`,
  `test_unset_smtp_logs_email_and_health_reports_log_only`. It patches the
  transport rather than sending real mail.
- Backend commands are `uv run …` — **never** `pip`, never `python -m pytest`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Backend tests | `cd api && uv run pytest -q` | `N passed` |
| One test file | `cd api && uv run pytest -q tests/test_email_and_freshness.py` | all pass |
| Lint | `cd api && uv run ruff check .` | no errors |
| Alembic head | `cd api && uv run alembic heads` | exactly ONE head |
| Migration up | `cd api && uv run alembic upgrade head` | exit 0 |
| Full gate | `task verify` | `✓ VERIFY PASSED` |

**Do not point the test suite at a database you care about** — the suite
truncates. It defaults to a local throwaway SQLite; leave `FACTORY_DB_URL`
unset.

## Scope

**In scope** (the only files you should modify):
- `api/app/models.py` (add one column)
- `api/alembic/versions/<new>.py` (create)
- `api/app/routers/requests.py` (populate the column)
- `api/app/notifications.py` (address from it; add STARTTLS)
- `api/tests/test_email_and_freshness.py` (add tests)
- `api/tests/test_migrations.py` (**added 2026-07-22 after the first run stopped
  here** — see Step 2b. Bounded to one test's row construction; do not touch any
  other test in that file.)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):
- **`Request.reporter` itself.** It is indexed and joined by the per-user daily
  brain budget (`api/app/brain_calls.py`). Do not change its type, its default,
  or what is written to it. You are *adding* a sibling column.
- The operator notification path (`_notify` / `_recipients`) — already correct.
- `api/app/seed.py` — demo rows may keep their nameless reporters; a seeded
  request with no reporter email must simply skip the send (which your change
  makes it do).
- The intake SPA. No UI change is needed: under `FACTORY_AUTH=entra` the email
  comes from the token, and with auth off there is no email to collect. Do
  **not** add an email field to the submission form — that is a product
  decision, not a bug fix.
- `SMTP_*` configuration in any deploy manifest.
- **The working tree has uncommitted changes from other work** (files under
  `apps/intake/`, `mockups/`, `plans/009`–`011`). Do not stage or commit them.

## Git workflow

- Branch: `advisor/017-requester-email`
- Conventional commits, e.g.
  `fix(notify): address requester mail to an email, not a display name`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the column to the model

In `api/app/models.py`, directly below `reporter_initials` (`:171`):

```python
    # The reporter's DELIVERABLE address. `reporter` above is a display name
    # ("Jordan D.") and was being used as an RFC-5322 To:, so every
    # requester-owned notification was undeliverable the moment SMTP was real
    # (plans/017). Nullable: with auth off there is no identity to take an
    # email from, and seeded/demo rows have none — those simply skip the send.
    reporter_email: Mapped[str | None] = mapped_column(
        human_string(200), nullable=True
    )
```

**Verify**: `cd api && uv run python -c "from app.models import Request; print(Request.__table__.c.reporter_email.type)"`
prints a String/NVARCHAR type.

### Step 2: Write the migration

First confirm the head:

```
cd api && uv run alembic heads
```

Expect exactly one head. If more than one, STOP — a second head means someone
else added a migration and the branch needs merging first, which is not this
plan's job.

Create `api/alembic/versions/<rev>_reporter_email.py`, modelled on
`c9d1f3a5b7e2_operator_role.py`, with `down_revision` set to the head you just
read (`a2f4c6e8b0d2` unless it has moved). Pick a 12-hex-char revision id in
the style of the existing files.

```python
"""requests.reporter_email — the deliverable address behind the display name.

Revision ID: <rev>
Revises: a2f4c6e8b0d2
Create Date: <today>
"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import mssql

from alembic import op

revision = "<rev>"
down_revision = "a2f4c6e8b0d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _nvarchar(length: int):
    return sa.String(length).with_variant(mssql.NVARCHAR(length), "mssql")


def upgrade() -> None:
    # Nullable with no server_default: existing rows have no known address, and
    # backfilling from `reporter` would write display names into an email
    # column — the exact bug this migration exists to fix.
    op.add_column("requests", sa.Column("reporter_email", _nvarchar(200), nullable=True))


def downgrade() -> None:
    op.drop_column("requests", "reporter_email")
```

Deliberately **no backfill**. `reporter` holds names, not addresses; copying it
across would recreate the defect in a new column.

**Verify**:
- `cd api && uv run alembic heads` → exactly one head, and it is your new
  revision.
- `cd api && uv run alembic upgrade head` → exit 0.
- The migration matches the model:
  `cd api && uv run pytest -q tests/test_migrations.py` → passes. (That file
  is the existing model/Alembic parity guard.)

### Step 2b: Un-break `test_migrations.py` (added after the first run stopped here)

The first execution of this plan stopped at Step 2 with a real, reproducible
failure that the plan had not anticipated:

```
tests/test_migrations.py::test_turn_order_migration_repairs_legacy_duplicates_before_indexing
sqlalchemy.exc.OperationalError: table requests has no column named reporter_email
```

**This is a pre-existing landmine in that test, not a defect in your column.**
The test (`api/tests/test_migrations.py:104-145`) pins a temp SQLite database to
an OLD revision (`alembic upgrade c3e5a7b9d1f4`, line 109) and then builds its
legacy row with the **live ORM class** (line 119,
`Request(ref="REQ-LEGACY", ...)`). SQLAlchemy's INSERT includes every mapped
column, so the statement references `reporter_email`, which does not exist at
that pinned revision.

Why it never fired before: `Request` has 16 nullable non-JSON columns, and all
of them predate the pinned revision. The nullable columns added *since* are all
JSON-typed, and SQLAlchemy omits unset JSON columns from an auto-INSERT. Yours
is the first plain-typed nullable column added to `Request` since that pin — so
it is the first to trip a trap that was always there. The next person to add
one would have hit exactly this.

**The fix**: build the legacy rows from the **reflected** (pinned) schema rather
than the live ORM model. Reflection reads the database as it actually is at that
revision, which is what a migration test pinning an old revision should always
have done — and it makes the test immune to every future model change.

In `test_turn_order_migration_repairs_legacy_duplicates_before_indexing` only,
replace the ORM construction (the `Request(...)` / `request.turns.extend([...])`
/ `request.prototype_turns.extend([...])` / `db.add` / `db.flush` / `db.commit`
block, roughly lines 117-137) with reflected-table inserts:

```python
        from sqlalchemy import MetaData, Table, insert

        db_engine = create_engine(url)
        # Reflect the PINNED schema — never the live ORM models. This test
        # deliberately runs against an old revision, so any column added to the
        # models since then would not exist here; building rows from the ORM
        # made the test break on the next unrelated model change (plans/017).
        meta = MetaData()
        requests_t = Table("requests", meta, autoload_with=db_engine)
        turns_t = Table("interview_turns", meta, autoload_with=db_engine)
        proto_t = Table("prototype_turns", meta, autoload_with=db_engine)

        with db_engine.begin() as conn:
            rid = conn.execute(
                insert(requests_t).values(
                    ref="REQ-LEGACY", title="Legacy", description="", type="new",
                )
            ).inserted_primary_key[0]
            conn.execute(insert(turns_t), [
                {"request_id": rid, "order": 0, "question": "Q1", "answer": "A1"},
                {"request_id": rid, "order": 0, "question": "Q1 duplicate", "answer": "A2"},
                {"request_id": rid, "order": 1, "question": "Q2", "answer": "A3"},
            ])
            conn.execute(insert(proto_t), [
                {"request_id": rid, "order": 0, "instruction": "First", "mode": "pending"},
                {"request_id": rid, "order": 0, "instruction": "Second", "mode": "pending"},
                {"request_id": rid, "order": 1, "instruction": "Third", "mode": "pending"},
            ])
        db_engine.dispose()
```

Notes:
- Keep `rid` — the rest of the test uses it.
- If any of those `values(...)` omits a column that is NOT NULL at the pinned
  revision, the insert will fail with a clear error naming the column; add it
  with a sensible literal. Do not add columns speculatively.
- `order` is a SQL reserved word; passing it as a dict key to
  `insert(table)` is safe because SQLAlchemy quotes identifiers.
- Change **only** this one test. The other four tests in the file must not be
  touched, and their behaviour must not change.

**Verify**:
- `cd api && uv run pytest -q tests/test_migrations.py` → **5 passed**.
- `cd api && uv run pytest -q` → full backend suite green.

If the reflected-insert approach fails for a reason you cannot resolve in two
attempts, STOP and report — do not fall back to advancing the pinned revision
(that would silently destroy what the test proves) and do not change
`reporter_email`'s type to dodge the INSERT (that would corrupt the column's
production semantics for an email field).

### Step 3: Populate it at request creation

In `api/app/routers/requests.py`, in `create_request` (~:769):

```python
    identity = current_identity()
    reporter = identity["name"] if identity else body.reporter
    reporter_initials = identity["initials"] if identity else body.reporter_initials
    # The address to actually mail (plans/017). Only the token can supply one —
    # with auth off there is nothing trustworthy to use, and requester mail is
    # skipped rather than sent to a display name.
    reporter_email = identity["email"] if identity else None
```

and add `reporter_email=reporter_email,` to the `Request(...)` construction
alongside `reporter=reporter`.

Then check for **other** creation paths:

```
grep -rn "reporter=" api/app --include=*.py | grep -v "reporter_initials"
```

If a second place constructs a `Request` with a reporter (other than
`api/app/seed.py`, which is out of scope), set `reporter_email` there the same
way. Report any you find.

**Verify**: `cd api && uv run pytest -q tests/test_api.py` → passes.

### Step 4: Address the notification from the new column

In `api/app/notifications.py`, rewrite `_notify_requester`:

```python
def _notify_requester(req: Request, subject: str, body: str) -> None:
    """Send the requester-owned preview gate to the reporter, not operators.

    Addressed from `reporter_email`, NOT `reporter` — the latter is a display
    name ("Jordan D.") and an invalid RFC-5322 To:, so every one of these was
    silently rejected once SMTP was configured (plans/017). No address means no
    send: a warning, not a broken message.
    """
    to = (req.reporter_email or "").strip()
    if not to:
        log.warning(
            "no reporter email on %s — skipping requester notification (subject=%s)",
            req.ref,
            subject,
        )
        return
    link = (
        f"{_env('INTAKE_BASE_URL', 'http://localhost:4201').rstrip('/')}"
        f"/submit/{req.id}"
    )
    message = EmailMessage()
    message["From"] = _env("SMTP_FROM", "aires@localhost")
    message["To"] = to
    message["Subject"] = subject
    message.set_content(f"{body} {link}")
    try:
        send_email(message)
    except Exception:
        log.exception(
            "email delivery failed; preview gate state preserved (to=%s subject=%s)",
            to,
            subject,
        )
```

The early return must **not** change any gate state — it does not, because
this function is called for its side effect only and both callers ignore its
return. Confirm that by reading `notify_gate_raised` and
`notify_import_rejected`.

**Verify**: `cd api && uv run pytest -q tests/test_email_and_freshness.py` →
passes (some tests may need updating in Step 6).

### Step 5: Encrypt the SMTP login

In `send_email` (`api/app/notifications.py:35-42`):

```python
    host = _env("SMTP_HOST")
    port = int(_env("SMTP_PORT", "25"))
    with smtplib.SMTP(host, port, timeout=10) as smtp:
        user = _env("SMTP_USER")
        password = _env("SMTP_PASSWORD")
        if user and password:
            # Never send AUTH credentials over a cleartext socket. Servers that
            # do not offer STARTTLS raise, which is the correct outcome — a
            # misconfigured relay should fail loudly, not leak the password.
            smtp.starttls()
            smtp.login(user, password)
        smtp.send_message(message)
```

Guard it behind `if user and password:` exactly as written — an unauthenticated
relay (the common local/dev case) keeps working untouched, and only the
credential path gains TLS.

**Verify**: `cd api && uv run pytest -q` → full backend suite passes.

### Step 6: Tests

Add to `api/tests/test_email_and_freshness.py`, following the file's existing
style (the `client` fixture + `monkeypatch`, patching the transport):

1. **`test_requester_email_is_addressed_to_the_email_not_the_name`** — a
   Request with `reporter="Jordan D."` and `reporter_email="jordan@example.com"`
   raised to the `accept_preview` gate produces a message whose `To:` is the
   address. Assert `"Jordan D."` does **not** appear in `To:`.
2. **`test_requester_notification_is_skipped_without_an_email`** — same, with
   `reporter_email=None`: no message is sent, and a warning is logged. Use
   `caplog`, as `test_unset_smtp_logs_email_and_health_reports_log_only`
   already does.
3. **`test_import_rejected_notification_uses_the_reporter_email`** — the second
   caller, `notify_import_rejected`, takes the same path.
4. **Operator mail is unaffected** — assert an existing operator-path test
   still passes untouched (no new test needed if one already covers it; say
   which one in your report).

To capture messages, patch `notifications.send_email` with a recorder — check
how the existing tests in that file do it and match them exactly rather than
inventing a new mechanism.

**Verify**: `cd api && uv run pytest -q tests/test_email_and_freshness.py` →
all pass, including 3 new tests.

### Step 7: Full gate and index

**Verify**:
- `cd api && uv run ruff check .` → no errors.
- `task verify` → `✓ VERIFY PASSED`.
- `grep -n "017" plans/README.md` → your row.

## Test plan

- 3 new tests in `api/tests/test_email_and_freshness.py`: addressed-to-email,
  skipped-without-email (with the warning), and the import-rejected caller.
- Structural pattern: `test_spec_gate_emails_exactly_subscribed_operators_with_dossier_link`
  for the gate-raises-mail shape, and
  `test_unset_smtp_logs_email_and_health_reports_log_only` for the `caplog`
  shape.
- Regression: `tests/test_migrations.py` proves the new column and the
  migration agree; the full `uv run pytest -q` proves nothing else regressed.
- Test 1 must be seen to fail before Step 4.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd api && uv run pytest -q` exits 0
- [ ] `cd api && uv run ruff check .` exits 0
- [ ] `cd api && uv run alembic heads` prints exactly one head, and it is the new revision
- [ ] `cd api && uv run alembic upgrade head` exits 0
- [ ] `grep -n 'message\["To"\] = req.reporter$' api/app/notifications.py` returns nothing
- [ ] `grep -n "reporter_email" api/app/notifications.py api/app/models.py api/app/routers/requests.py` returns a hit in all three
- [ ] `grep -n "starttls" api/app/notifications.py` returns the call
- [ ] `task verify` exits 0
- [ ] 3 new tests exist and pass
- [ ] `git status --porcelain` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `uv run alembic heads` shows more than one head before you start.
- You find yourself needing to change `Request.reporter` — it is indexed and
  joined by the brain-budget aggregate; touching it is out of scope and risky.
- A creation path other than `create_request` and `api/app/seed.py` builds a
  `Request` with a reporter (Step 3's grep) and it is not obvious where the
  email should come from.
- Adding `starttls()` breaks an existing test that asserts on the SMTP call
  sequence — report it rather than removing the TLS call.
- You are tempted to backfill `reporter_email` from `reporter`. Do not: it
  would write display names into an email column.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

For whoever owns this next:

- **What a reviewer should scrutinise**: that `reporter` is untouched (the
  brain-budget join depends on it), that no backfill was added, and that the
  skip path logs rather than silently returning.
- **The gap this leaves open by design**: with `FACTORY_AUTH=off` there is no
  identity, so `reporter_email` is always NULL and requester notifications are
  always skipped — with a warning per skip. That is correct behaviour for an
  unauthenticated local profile, but it means the preview-acceptance gate has
  no email path at all in that mode. If requester mail is ever needed without
  Entra, the intake form must collect an address, and that is a product
  decision.
- **Related, deliberately not fixed here**: `_notify_requester` is called from
  the tick thread via `transitions.apply_committed` → `Win.notify()`, and
  `send_email` opens a synchronous SMTP connection with a 10-second timeout
  per recipient. A slow relay therefore stalls the whole factory heartbeat.
  Moving notification onto a bounded background sender is a separate,
  worthwhile change.
