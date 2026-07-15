# Plan A: Database Backbone — Azure SQL, Alembic, Leader Election, Intent Log

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the factory's control plane run on Azure SQL (MSSQL) with versioned migrations, hardened leader election (fencing epochs), and an intent log — while every existing test keeps passing on SQLite.

**Architecture:** The DB stays behind `FACTORY_DB_URL` (dialect-agnostic, ADR 0007). SQLite remains the fast local/test default; `mssql+pyodbc` is the production dialect, exercised in CI by a SQL Server service container and in dev against a real Azure SQL DB. Leadership = `sp_getapplock` on a dedicated non-pooled connection + a monotonic epoch; every state-mutating write is a compare-and-swap guarded by expected status AND current epoch. External side effects go through an intent log written in the same transaction as the state change.

**Tech Stack:** SQLAlchemy 2, Alembic, pyodbc + MS ODBC Driver 18, pytest, uv.

**Spec:** `docs/superpowers/specs/2026-07-14-openshift-kubernetes-architecture-design.md` §3.

## Global Constraints

- Python deps via `uv add` / `uv run` only — never pip (AGENTS.md §5).
- SQLAlchemy 2 style — explicit `select()`, no `Query` object.
- `progress_event` rows are append-only — never UPDATE/DELETE (ADR 0008).
- All existing tests must stay green on SQLite: `cd api && uv run pytest -q`.
- `task verify` green before merge.
- On SQLite (single process) the leader module must degrade to "always leader" so tests and local sim mode run unchanged.
- Working directory for all commands: `api/` unless stated.

---

### Task 1: Alembic scaffolding + baseline migration

**Files:**
- Create: `api/alembic.ini`, `api/alembic/env.py`, `api/alembic/versions/` (baseline revision)
- Modify: `api/pyproject.toml` (dep), `api/app/db.py:53-79` (`migrate()`)
- Test: `api/tests/test_migrations.py`

**Interfaces:**
- Produces: `app.db.migrate()` keeps its signature (`() -> list[str]`) but on non-SQLite URLs runs `alembic upgrade head` instead of the PRAGMA differ. Task 2+ rely on `alembic upgrade head` bringing an empty MSSQL DB to full schema.

- [ ] **Step 1: Add alembic**

```bash
cd api && uv add alembic
```

- [ ] **Step 2: Write the failing test**

```python
# api/tests/test_migrations.py
"""Alembic owns non-SQLite schema; SQLite keeps the fast create_all path."""
import subprocess
import tempfile


def test_alembic_upgrade_head_builds_full_schema_on_fresh_db():
    # a fresh SQLite file stands in for "empty database" — the point is that
    # the alembic history alone (no create_all) produces every table
    with tempfile.TemporaryDirectory() as tmp:
        url = f"sqlite:///{tmp}/mig.db"
        r = subprocess.run(
            ["uv", "run", "alembic", "upgrade", "head"],
            env={"FACTORY_DB_URL": url, "PATH": __import__("os").environ["PATH"]},
            capture_output=True, text=True, cwd=".",
        )
        assert r.returncode == 0, r.stderr
        from sqlalchemy import create_engine, inspect
        insp = inspect(create_engine(url))
        tables = set(insp.get_table_names())
        # spot-check the load-bearing tables
        assert {"request", "progress_event"} <= tables, tables
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_migrations.py -v`
Expected: FAIL (`alembic` config not found / nonzero returncode).

- [ ] **Step 4: Initialize alembic wired to the app**

```bash
cd api && uv run alembic init alembic
```

Then replace `api/alembic/env.py` body so it reads the app's URL and metadata:

```python
# api/alembic/env.py
from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine

from app import settings
from app.db import Base
import app.models  # noqa: F401  — registers every table on Base.metadata

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(url=settings.DB_URL, target_metadata=target_metadata,
                      literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(settings.DB_URL)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

In `api/alembic.ini` leave `sqlalchemy.url` blank (env.py supplies it) and set `script_location = alembic`.

- [ ] **Step 5: Generate the baseline revision**

```bash
cd api && FACTORY_DB_URL=sqlite:///$(mktemp -d)/base.db uv run alembic revision --autogenerate -m "baseline: full schema from models"
```

Open the generated file under `api/alembic/versions/` and check every table from `app/models.py` is present (autogenerate against an empty DB emits the full schema).

- [ ] **Step 6: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_migrations.py -v`
Expected: PASS

- [ ] **Step 7: Route non-SQLite startup through alembic**

In `api/app/db.py`, change `migrate()` so the PRAGMA differ stays SQLite-only and real databases use alembic:

```python
def migrate() -> list[str]:
    """SQLite: create_all + PRAGMA differ (fast test/dev path).
    Anything else (Azure SQL): versioned Alembic migrations only —
    the schema now outlives deployments (spec §3.1)."""
    if not DB_URL.startswith("sqlite"):
        from alembic import command
        from alembic.config import Config
        from pathlib import Path
        cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
        command.upgrade(cfg, "head")
        return []
    Base.metadata.create_all(engine)
    added: list[str] = []
    with engine.connect() as conn:
        # ... existing PRAGMA-differ body unchanged from here down ...
```

(Keep the existing differ body; only the early-return branch changes.)

- [ ] **Step 8: Full suite + commit**

Run: `cd api && uv run pytest -q` — Expected: all pass.

```bash
git add api/alembic.ini api/alembic api/tests/test_migrations.py api/app/db.py api/pyproject.toml api/uv.lock
git commit -m "feat(db): alembic migrations own non-sqlite schema (spec §3.1)"
```

---

### Task 2: MSSQL dialect support + CI job against SQL Server

**Files:**
- Modify: `api/pyproject.toml` (pyodbc), `api/app/db.py:9` (engine kwargs), `api/app/models.py` (bounded strings on indexed columns)
- Modify: `.github/workflows/ci.yml` (new job)
- Test: dialect smoke = the whole existing suite under `FACTORY_DB_URL=mssql+pyodbc://...` in CI

**Interfaces:**
- Consumes: Task 1's alembic head.
- Produces: `create_engine` settings later tasks inherit: `pool_pre_ping=True`, `pool_recycle=1800` for non-SQLite. CI job name `test-mssql` that later tasks' features are automatically exercised by.

- [ ] **Step 1: Add pyodbc**

```bash
cd api && uv add pyodbc
```

- [ ] **Step 2: Engine settings for a network database**

In `api/app/db.py` replace the `create_engine` line:

```python
if DB_URL.startswith("sqlite"):
    engine = create_engine(DB_URL, connect_args={"check_same_thread": False})
else:
    # Azure SQL: the gateway kills idle connections (~30 min) and reconfigures
    # under you — pre-ping detects dead pooled connections, recycle beats the
    # gateway's idle timeout (spec §3.1, review F-D10)
    engine = create_engine(DB_URL, pool_pre_ping=True, pool_recycle=1800)
```

- [ ] **Step 3: Bound every indexed/PK String column**

MSSQL cannot index `VARCHAR(max)`. In `api/app/models.py`, for each `String` column that is a primary key, unique, indexed, or in a foreign key, add an explicit length (pattern: `String(64)` for ids/refs/status enums, `String(255)` for names/titles). Grep to find them:

Run: `grep -n "String)" api/app/models.py` and `grep -n "String," api/app/models.py`
For each hit that is `primary_key=True`, `index=True`, `unique=True`, or `ForeignKey`-referenced, change `String` → `String(64)` (ids/status) or `String(255)` (human text). Unindexed free-text columns (`Text` or plain `String`) stay as they are.

- [ ] **Step 4: Regenerate nothing — verify SQLite still green**

Run: `cd api && uv run pytest -q`
Expected: all pass (SQLAlchemy treats `String(n)` identically on SQLite).

- [ ] **Step 5: CI job with a real SQL Server**

Append to `.github/workflows/ci.yml` jobs:

```yaml
  test-mssql:
    runs-on: ubuntu-latest
    services:
      mssql:
        image: mcr.microsoft.com/mssql/server:2022-latest
        env:
          ACCEPT_EULA: "Y"
          MSSQL_SA_PASSWORD: "Factory-CI-Passw0rd"
        ports: ["1433:1433"]
        options: >-
          --health-cmd "/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P Factory-CI-Passw0rd -Q 'SELECT 1' || exit 1"
          --health-interval 10s --health-timeout 5s --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
      - name: Install ODBC driver 18
        run: |
          curl -sSL -O https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb
          sudo dpkg -i packages-microsoft-prod.deb
          sudo apt-get update && sudo ACCEPT_EULA=Y apt-get install -y msodbcsql18
      - name: Create database
        run: docker exec $(docker ps -q --filter ancestor=mcr.microsoft.com/mssql/server:2022-latest) /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P Factory-CI-Passw0rd -Q "CREATE DATABASE factory"
      - name: Run suite against MSSQL
        working-directory: api
        env:
          FACTORY_DB_URL: "mssql+pyodbc://sa:Factory-CI-Passw0rd@localhost:1433/factory?driver=ODBC+Driver+18+for+SQL+Server&TrustServerCertificate=yes"
        run: |
          uv sync
          uv run alembic upgrade head
          uv run pytest -q
```

- [ ] **Step 6: Fix what MSSQL CI finds**

Push a branch and read the `test-mssql` job. Expected first-run failures and their fixes:
- `PRAGMA` errors → a test or module assumed SQLite; guard with `DB_URL.startswith("sqlite")`.
- `VARCHAR(max)` index errors → a `String` you missed in Step 3.
- Boolean/int coercion asserts → compare with `bool(...)` in the test, not `is 1`.
- The per-test DB isolation problem: `conftest.py` points at one DB per session; on MSSQL the session-scoped client reuses it — if cross-test bleed appears, add to `api/tests/conftest.py` a session-start cleanup:

```python
# after creating the app, wipe rows (schema stays):
from app.db import Base, engine
from sqlalchemy import delete
import sqlalchemy as sa
def _truncate_all():
    with engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            conn.execute(delete(table))
```

Call `_truncate_all()` once in the `client` fixture before `yield` when `FACTORY_DB_URL` is not SQLite.

- [ ] **Step 7: Commit**

```bash
git add api/app/db.py api/app/models.py api/pyproject.toml api/uv.lock .github/workflows/ci.yml api/tests/conftest.py
git commit -m "feat(db): mssql dialect support + CI suite against SQL Server (spec §3.1)"
```

---

### Task 3: Leader election with fencing epoch

**Files:**
- Create: `api/app/leader.py`
- Create: `api/alembic/versions/xxxx_leader_epoch.py` (via autogenerate)
- Modify: `api/app/models.py` (LeaderEpoch model)
- Test: `api/tests/test_leader.py`

**Interfaces:**
- Produces (used by Tasks 4–5 and Plan B):
  - `leader.LeaderElector(engine)` with `.try_acquire() -> bool`, `.is_leader() -> bool`, `.epoch -> int`, `.release() -> None`, `.verify() -> bool` (re-checks the lock is still held; on loss flips `is_leader` False).
  - Module-level `leader.get_elector() -> LeaderElector` singleton.
  - SQLite behavior: `try_acquire()` always True, epoch increments per acquire, `verify()` always True.

- [ ] **Step 1: LeaderEpoch model**

Append to `api/app/models.py`:

```python
class LeaderEpoch(Base):
    """Single-row fencing counter (spec §3.2). Every state-mutating write is
    guarded by `AND epoch = :mine` — a stalled ex-leader that resumes after
    losing sp_getapplock cannot advance anything."""
    __tablename__ = "leader_epoch"
    id: Mapped[int] = mapped_column(primary_key=True)  # always 1
    epoch: Mapped[int] = mapped_column(nullable=False, default=0)
```

(Match the file's existing `Mapped`/`mapped_column` import style.)

- [ ] **Step 2: Autogenerate the migration**

```bash
cd api && FACTORY_DB_URL=sqlite:///$(mktemp -d)/m.db sh -c 'uv run alembic upgrade head && uv run alembic revision --autogenerate -m "leader_epoch table"'
```

- [ ] **Step 3: Write the failing tests**

```python
# api/tests/test_leader.py
"""Leader election: sqlite = always-leader with real epochs; the fencing
contract (stale epoch loses) is dialect-independent and tested here."""
from app.db import SessionLocal, engine, migrate
from app.leader import LeaderElector
from app.models import LeaderEpoch
from sqlalchemy import select


def test_sqlite_acquire_is_leader_and_bumps_epoch():
    migrate()
    e1 = LeaderElector(engine)
    assert e1.try_acquire() is True
    assert e1.is_leader() is True
    first = e1.epoch
    e1.release()
    e2 = LeaderElector(engine)
    assert e2.try_acquire() is True
    assert e2.epoch == first + 1  # every acquisition is a new fencing epoch


def test_epoch_row_is_singleton():
    migrate()
    e = LeaderElector(engine)
    e.try_acquire()
    with SessionLocal() as db:
        rows = db.execute(select(LeaderEpoch)).scalars().all()
    assert len(rows) == 1 and rows[0].id == 1
    e.release()


def test_verify_true_while_held():
    migrate()
    e = LeaderElector(engine)
    e.try_acquire()
    assert e.verify() is True
    e.release()
    assert e.is_leader() is False
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_leader.py -v`
Expected: FAIL — `ModuleNotFoundError: app.leader`.

- [ ] **Step 5: Implement `api/app/leader.py`**

```python
"""Leadership: exactly one process runs the tick loop + orchestration.

MSSQL: sp_getapplock (Session owner) on a DEDICATED non-pooled connection —
the lock lives and dies with that connection, so it must never come from the
pool (spec §3.2, review F-D1). SQLite: single process by definition (AGENTS.md
"single uvicorn worker"), so acquisition always succeeds; the epoch mechanics
stay identical so the fencing contract is exercised by every test run.
"""
import threading

from sqlalchemy import text
from sqlalchemy.engine import Engine

_LOCK_NAME = "sf_leader"


class LeaderElector:
    def __init__(self, engine: Engine):
        self._engine = engine
        self._sqlite = engine.url.get_backend_name() == "sqlite"
        self._conn = None          # dedicated raw connection (mssql only)
        self._leader = False
        self.epoch: int = 0
        self._guard = threading.Lock()

    def try_acquire(self) -> bool:
        with self._guard:
            if self._leader:
                return True
            if self._sqlite:
                self._leader = True
            else:
                # non-pooled: engine.connect() would borrow from the pool and
                # a recycle would silently drop the lock
                self._conn = self._engine.pool._creator()  # raw DBAPI conn
                cur = self._conn.cursor()
                cur.execute(
                    "DECLARE @r int; "
                    "EXEC @r = sp_getapplock @Resource=?, @LockMode='Exclusive', "
                    "@LockOwner='Session', @LockTimeout=0; SELECT @r",
                    (_LOCK_NAME,),
                )
                got = cur.fetchone()[0] >= 0
                cur.close()
                if not got:
                    self._conn.close()
                    self._conn = None
                    return False
                self._leader = True
            self.epoch = self._bump_epoch()
            return True

    def _bump_epoch(self) -> int:
        with self._engine.begin() as conn:
            conn.execute(text(
                "UPDATE leader_epoch SET epoch = epoch + 1 WHERE id = 1"))
            row = conn.execute(text(
                "SELECT epoch FROM leader_epoch WHERE id = 1")).first()
            if row is None:
                conn.execute(text(
                    "INSERT INTO leader_epoch (id, epoch) VALUES (1, 1)"))
                return 1
            return row[0]

    def verify(self) -> bool:
        """Re-check we still hold the lock. Called by the tick loop each pass."""
        with self._guard:
            if not self._leader:
                return False
            if self._sqlite:
                return True
            try:
                cur = self._conn.cursor()
                cur.execute(
                    "SELECT APPLOCK_MODE('public', ?, 'Session')", (_LOCK_NAME,))
                mode = cur.fetchone()[0]
                cur.close()
                if mode != "Exclusive":
                    self._demote()
                    return False
                return True
            except Exception:
                self._demote()
                return False

    def _demote(self):
        self._leader = False
        if self._conn is not None:
            try:
                self._conn.close()
            finally:
                self._conn = None

    def is_leader(self) -> bool:
        return self._leader

    def release(self) -> None:
        with self._guard:
            self._demote()


_elector: LeaderElector | None = None


def get_elector() -> LeaderElector:
    global _elector
    if _elector is None:
        from .db import engine
        _elector = LeaderElector(engine)
    return _elector
```

Note the epoch-row bootstrap: the UPDATE-then-INSERT order keeps it race-free enough for a table only the leader touches; the alembic migration may instead seed the row — if so, add `op.execute("INSERT INTO leader_epoch (id, epoch) VALUES (1, 0)")` to the migration and drop the INSERT fallback.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_leader.py -v` — Expected: PASS.
Also: `uv run pytest -q` — full suite still green.

- [ ] **Step 7: Commit**

```bash
git add api/app/leader.py api/app/models.py api/alembic/versions api/tests/test_leader.py
git commit -m "feat(db): leader election with fencing epoch (spec §3.2)"
```

---

### Task 4: CAS transitions guarded by status + epoch

**Files:**
- Create: `api/app/transitions.py`
- Test: `api/tests/test_transitions.py`

**Interfaces:**
- Consumes: `leader.get_elector().epoch`.
- Produces: `transitions.cas_status(db, request_id: str, expected: str, new: str, epoch: int) -> bool` — True iff exactly one row moved. All orchestration state changes in Plan B MUST go through this.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_transitions.py
"""The fencing contract: a write with a stale epoch is a no-op, a write with
a stale expected-status is a no-op — regardless of dialect."""
from app.db import SessionLocal, migrate
from app.leader import LeaderElector
from app.db import engine
from app.transitions import cas_status
from tests.helpers import make_request  # existing test factory; if the helper
# has a different name, use whatever tests/test_hardening.py uses to create a
# Request row and note it in implementation-notes.md


def _fresh_request(db):
    return make_request(db, status="queued_for_pipeline")


def test_cas_moves_exactly_once():
    migrate()
    e = LeaderElector(engine); e.try_acquire()
    with SessionLocal() as db:
        req = _fresh_request(db)
        assert cas_status(db, req.id, "queued_for_pipeline", "running", e.epoch) is True
        # second identical CAS: expected no longer matches
        assert cas_status(db, req.id, "queued_for_pipeline", "running", e.epoch) is False


def test_stale_epoch_cannot_write():
    migrate()
    e = LeaderElector(engine); e.try_acquire()
    stale = e.epoch
    e.release(); e.try_acquire()          # epoch bumped — old leader is fenced
    with SessionLocal() as db:
        req = _fresh_request(db)
        assert cas_status(db, req.id, "queued_for_pipeline", "running", stale) is False
        assert cas_status(db, req.id, "queued_for_pipeline", "running", e.epoch) is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_transitions.py -v`
Expected: FAIL — `ModuleNotFoundError: app.transitions`.

- [ ] **Step 3: Implement**

```python
# api/app/transitions.py
"""Compare-and-swap state transitions (spec §3.2).

One statement checks three things atomically: the row exists, its status is
what the caller last read, and the caller's fencing epoch is still current.
A stalled ex-leader (stale epoch) or a raced transition (stale status) writes
nothing and gets False — never a partial update.
"""
from sqlalchemy import text
from sqlalchemy.orm import Session


def cas_status(db: Session, request_id: str, expected: str, new: str, epoch: int) -> bool:
    result = db.execute(
        text(
            "UPDATE request SET status = :new "
            "WHERE id = :rid AND status = :expected "
            "AND EXISTS (SELECT 1 FROM leader_epoch WHERE id = 1 AND epoch = :epoch)"
        ),
        {"new": new, "rid": request_id, "expected": expected, "epoch": epoch},
    )
    db.commit()
    return result.rowcount == 1
```

(If the requests table is not named `request`, read `api/app/models.py` `__tablename__` and use that; record in implementation-notes.md.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_transitions.py -v` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/app/transitions.py api/tests/test_transitions.py
git commit -m "feat(db): epoch-fenced CAS transitions (spec §3.2)"
```

---

### Task 5: Intent log

**Files:**
- Modify: `api/app/models.py` (Intent model), new alembic revision
- Create: `api/app/intents.py`
- Test: `api/tests/test_intents.py`

**Interfaces:**
- Consumes: `cas_status` (Task 4).
- Produces (Plan B/C call these around every external side effect):
  - `intents.begin(db, key: str, kind: str, request_id: str, payload: dict) -> Intent | None` — inserts a `pending` intent; returns None if the key already exists (duplicate = already done/doing, caller skips the call).
  - `intents.complete(db, key: str, outcome: dict) -> None`
  - `intents.open_intents(db) -> list[Intent]` — recovery: replay these idempotently.
  - Intent kinds (string enum, exact values): `"create_repo" | "open_pr" | "merge_pr" | "trigger_build" | "apply_deploy"`.

- [ ] **Step 1: Model + migration**

Append to `api/app/models.py`:

```python
class Intent(Base):
    """Intent log for external side effects (spec §3.3). Written in the SAME
    transaction as the state change that implies the effect; completed after
    the external call returns. Recovery replays `pending` rows idempotently —
    the crash window between 'we decided' and 'we recorded the outcome' is
    therefore observable instead of silent."""
    __tablename__ = "intent"
    key: Mapped[str] = mapped_column(String(128), primary_key=True)  # idempotency key
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    request_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")  # pending|done|failed
    outcome_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    created_at: Mapped[datetime] = mapped_column(default=utcnow)   # reuse the file's existing timestamp default helper
    completed_at: Mapped[datetime | None] = mapped_column(nullable=True)
```

(Match the file's existing timestamp-default idiom; then `uv run alembic revision --autogenerate -m "intent log"` as in Task 3 Step 2.)

- [ ] **Step 2: Write the failing tests**

```python
# api/tests/test_intents.py
import json

from app.db import SessionLocal, migrate
from app import intents


def test_begin_is_idempotent_by_key():
    migrate()
    with SessionLocal() as db:
        first = intents.begin(db, "req1:merge_pr:sha123", "merge_pr", "req1", {"sha": "sha123"})
        assert first is not None and first.status == "pending"
        dup = intents.begin(db, "req1:merge_pr:sha123", "merge_pr", "req1", {"sha": "sha123"})
        assert dup is None  # caller must NOT repeat the external call


def test_complete_and_recovery_scan():
    migrate()
    with SessionLocal() as db:
        intents.begin(db, "req2:trigger_build:sha9", "trigger_build", "req2", {})
        assert [i.key for i in intents.open_intents(db)] == ["req2:trigger_build:sha9"]
        intents.complete(db, "req2:trigger_build:sha9", {"build": "b-1"})
        assert intents.open_intents(db) == []
        row = db.get(__import__("app.models", fromlist=["Intent"]).Intent, "req2:trigger_build:sha9")
        assert row.status == "done" and json.loads(row.outcome_json)["build"] == "b-1"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_intents.py -v`
Expected: FAIL — `app.intents` missing.

- [ ] **Step 4: Implement `api/app/intents.py`**

```python
"""Intent log around external side effects (spec §3.3). Usage pattern:

    with SessionLocal() as db:
        it = intents.begin(db, key, kind, req_id, payload)   # same txn as CAS
        db.commit()
    if it is not None:
        outcome = do_external_call()
        with SessionLocal() as db:
            intents.complete(db, key, outcome)
"""
import json
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import Intent


def begin(db: Session, key: str, kind: str, request_id: str, payload: dict) -> Intent | None:
    row = Intent(key=key, kind=kind, request_id=request_id,
                 payload_json=json.dumps(payload))
    db.add(row)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        return None
    return row


def complete(db: Session, key: str, outcome: dict) -> None:
    row = db.get(Intent, key)
    row.status = "done"
    row.outcome_json = json.dumps(outcome)
    row.completed_at = datetime.now(timezone.utc)
    db.commit()


def fail(db: Session, key: str, outcome: dict) -> None:
    row = db.get(Intent, key)
    row.status = "failed"
    row.outcome_json = json.dumps(outcome)
    row.completed_at = datetime.now(timezone.utc)
    db.commit()


def open_intents(db: Session) -> list[Intent]:
    return list(db.execute(
        select(Intent).where(Intent.status == "pending").order_by(Intent.created_at)
    ).scalars())
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_intents.py -v` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/app/models.py api/app/intents.py api/alembic/versions api/tests/test_intents.py
git commit -m "feat(db): intent log for external side effects (spec §3.3)"
```

---

### Task 6: Wire leadership into the app — tick loop gated, health reports it

**Files:**
- Modify: `api/app/main.py` (tick-loop guard — find the `auto_tick` loop `create_app` starts), `api/app/routers/system.py` (health payload)
- Test: `api/tests/test_leader_wiring.py`

**Interfaces:**
- Consumes: `leader.get_elector()`.
- Produces: `GET /api/health` gains `"leader": bool, "epoch": int`. The tick loop calls `elector.verify()` at the top of every pass and skips the pass when not leader (and tries `try_acquire()` again next pass).

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_leader_wiring.py
def test_health_reports_leadership(client):
    body = client.get("/api/health").json()
    assert body["leader"] is True      # sqlite: always leader
    assert isinstance(body["epoch"], int) and body["epoch"] >= 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_leader_wiring.py -v`
Expected: FAIL — KeyError `leader`.

- [ ] **Step 3: Implement**

In `api/app/main.py`, where `create_app` starts the tick loop, acquire leadership first and guard each pass:

```python
from .leader import get_elector
# inside create_app, before starting the tick thread:
elector = get_elector()
elector.try_acquire()

# inside the tick loop body, FIRST statement of every pass:
if not (elector.verify() or elector.try_acquire()):
    continue  # not leader this pass; another replica is ticking
```

In `api/app/routers/system.py`, extend the health payload dict:

```python
from ..leader import get_elector
# in the health handler's returned dict:
"leader": get_elector().is_leader(),
"epoch": get_elector().epoch,
```

- [ ] **Step 4: Run tests**

Run: `cd api && uv run pytest tests/test_leader_wiring.py -v` — Expected: PASS.
Run: `cd api && uv run pytest -q` — full suite green.

- [ ] **Step 5: Full verify + commit**

Run from repo root: `task verify` — Expected: `✓ VERIFY PASSED`.

```bash
git add api/app/main.py api/app/routers/system.py api/tests/test_leader_wiring.py
git commit -m "feat(db): tick loop gated on verified leadership; health reports leader+epoch (spec §3.2)"
```

---

### Task 7: Dev database — Azure SQL provisioning + runbook

**Files:**
- Create: `docs/runbooks/azure-sql-dev.md`
- Modify: `api/Dockerfile` (ODBC driver layer)

**Interfaces:**
- Produces: a reachable `FACTORY_DB_URL` for the laptop and the documented steps to recreate it.

- [ ] **Step 1: Provision (manual, portal or az cli) and document**

Write `docs/runbooks/azure-sql-dev.md` with the exact steps executed:

```markdown
# Azure SQL dev database

1. Resource group `sf-dev` (region nearest you).
2. Logical server `sf-dev-sql-<suffix>` — SQL auth, admin user `sffactory`.
3. Database `factory` — **Basic tier ($4.90/mo)**; set a DTU alert at 80%
   (Metrics → New alert rule); expect the S0 bump if it fires (spec §1).
4. Networking: add the laptop's public IP to the server firewall
   (Security → Networking → Add client IP). Re-add when your IP changes.
5. Budget alert on the subscription: Cost Management → Budgets → $20/mo.
6. Connection string (put in api/.env, never commit):
   FACTORY_DB_URL="mssql+pyodbc://sffactory:<pw>@sf-dev-sql-<suffix>.database.windows.net:1433/factory?driver=ODBC+Driver+18+for+SQL+Server"
7. First run: `cd api && uv run alembic upgrade head`
8. Smoke: `FACTORY_DB_URL=... uv run pytest tests/test_leader.py tests/test_transitions.py tests/test_intents.py -v`
   — the leader tests against REAL Azure SQL exercise sp_getapplock for real.
```

- [ ] **Step 2: ODBC driver in the api image**

In `api/Dockerfile`, after the base-image/apt section (image must be Debian-based; if it is alpine, switch base to `python:3.13-slim-bookworm` and note it in implementation-notes.md):

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends curl gnupg2 \
    && curl -sSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/ms.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/ms.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" > /etc/apt/sources.list.d/mssql.list \
    && apt-get update && ACCEPT_EULA=Y apt-get install -y --no-install-recommends msodbcsql18 \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 3: Verify image builds**

Run: `docker build -f api/Dockerfile -t sf-api:dev .`
Expected: success.

- [ ] **Step 4: Run the leader/intent tests against real Azure SQL**

Run (with the .env URL): `cd api && FACTORY_DB_URL="mssql+pyodbc://..." uv run pytest tests/test_leader.py tests/test_transitions.py tests/test_intents.py -v`
Expected: PASS — this is the moment sp_getapplock is proven against the real gateway.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/azure-sql-dev.md api/Dockerfile
git commit -m "feat(db): azure sql dev runbook + odbc driver in api image (spec §3.1)"
```

---

## Self-review notes

- Spec coverage §3: 3.1 Alembic+MSSQL (Tasks 1, 2, 7) · 3.2 leader+fencing+CAS (Tasks 3, 4, 6) · 3.3 intent log (Task 5) · 3.5 config/probes untouched here (Plan D) · 3.4/3.6/3.7 (Job state, fairness, approver identity) belong to Plan B where the orchestration changes live.
- The MSSQL-only lock path is exercised in CI (Task 2's job runs the whole suite including test_leader.py — on MSSQL the real sp_getapplock branch runs) and against real Azure SQL in Task 7 Step 4.
- Types consistent: `cas_status(db, str, str, str, int) -> bool`; `intents.begin(...) -> Intent | None`; elector `.epoch: int`.
- Known judgment calls the implementer may hit: exact requests `__tablename__`, the timestamp-default helper name in models.py, the test factory helper name in tests/helpers.py, alembic seeding of the epoch row — all flagged inline; log resolutions in implementation-notes.md under `## Deviations`.
