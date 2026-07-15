# MSSQL leader-lock failures: root cause and fix

## Status

Fixed in the working tree; no commit created.

## Definitive execution-order trace

Pytest collects the suite by module name. The first test that requests the
`conftest.py` session-scoped `client` is in `test_agent_runner.py`, well before
the three leader-owning modules. Its `TestClient` enters the app lifespan,
`get_elector().try_acquire()` opens the singleton's detached pyodbc connection,
and that SQL session takes `sf_leader`. The session fixture remains alive until
the entire suite ends.

The leader-owning modules are reached in this order:

1. `test_intents.py`
2. `test_leader.py`
3. `test_leader_wiring.py` (touches the singleton directly, but has no wrapper)
4. `test_transitions.py` (the alphabetically last leader-owning module)

`restore_app_leadership` is declared `scope="module"` in `conftest.py`. A
module-scoped fixture is cached against the requesting module node, not once
against the conftest file, so the three autouse wrappers request three distinct
fixture instances. For each wrapped module pytest orders the fixtures as
follows:

```text
SETUP restore_app_leadership
  app singleton release()
SETUP module autouse wrapper
  SETUP make_elector (only for a test that requests it)
  TEST
  TEARDOWN make_elector (release every local elector)
TEARDOWN module autouse wrapper
TEARDOWN restore_app_leadership
  app singleton try_acquire()
```

At a module boundary pytest tears down module A before setting up module B.
Therefore A's teardown does re-acquire the singleton lock, but B's fresh
`restore_app_leadership` setup immediately calls `release()` before B's
function-scoped `make_elector` is created. A module teardown cannot, by fixture
ordering alone, leave the singleton holding the lock during B's tests. The
local `--setup-show` trace confirmed this exact sequence for intents, leader,
and transitions. The wrappers are redundant-looking but correctly scoped and
ordered; changing them to function scope or adding another pre-test call to
the same broken `release()` would only mask the real lifecycle defect.

## Root cause

`LeaderElector.release()` only called `close()` on the detached SQLAlchemy raw
connection. Detaching keeps the handle out of SQLAlchemy's pool, but pyodbc's
ODBC layer has its own process-level connection pooling. `close()` performs a
logical `SQLDisconnect`; with pooling enabled, the physical SQL session can be
returned to that pool and remain live. `sf_leader` was acquired with
`@LockOwner='Session'`, so it belongs to that live SQL session, not to a
transaction or to the Python handle. A later local elector can receive a
different pooled SQL session and get a negative `sp_getapplock` result, or it
can receive the old holder session and acquire re-entrantly. That explains the
mixed failures, the apparently contradictory passing leader tests, and why the
last transitions module could pass without contradicting the fixture trace.
Microsoft documents both parts of this behavior: pooled `SQLDisconnect`
returns the connection to the pool while it remains available, and a Session
application lock must be explicitly balanced by `sp_releaseapplock` on the same
session (including one release per re-entrant acquisition):

- https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqldisconnect-function
- https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-releaseapplock-transact-sql

The current `dbapi_connection.autocommit = True` is correct but unrelated to
this failure: the lock owner is `Session`, not `Transaction`. Git history also
shows that the preceding `driver_connection.autocommit = True` version
dereferenced `None` after detach and crashed before this lock-lifetime path was
exercised. Neither that earlier crash nor the still earlier implicit-transaction
behavior explains the current run.

## Minimal fix

`LeaderElector.release()` now executes
`sp_releaseapplock @Resource='sf_leader', @LockOwner='Session'` on the exact
dedicated connection that acquired the lock, then closes/demotes in a `finally`
block. This is a production correctness fix: a voluntary release must release
leadership even when ODBC pooling keeps the SQL session alive. The fixture
scopes and module wrappers remain unchanged because their ordering is correct.

The existing final test slot in `test_leader.py` was converted into an MSSQL
release regression without increasing the suite count. It uses a fake MSSQL
connection to assert that explicit same-session release happens before close
and that the elector is demoted. The regression failed before the production
change because no release cursor was opened, then passed after the change.

## Verification

- Regression red: `test_mssql_release_explicitly_drops_the_session_lock`
  failed because `conn.cursor().execute` was never called.
- Regression green: `1 passed`.
- Affected modules: `44 passed`.
- Full SQLite suite: `267 passed, 2 warnings`.
- Ruff: `All checks passed!`.
- `git diff --check`: clean.

The warnings are pre-existing: one Starlette deprecation warning and one
SQLAlchemy session warning in `test_agent_brain_attachments.py`.
