"""Leadership: exactly one process runs the tick loop + orchestration.

MSSQL: sp_getapplock (Session owner) on a DEDICATED non-pooled connection —
the lock lives and dies with that connection, so it must never come from the
pool (spec §3.2, review F-D1). SQLite: single process by definition (AGENTS.md
"single uvicorn worker"), so acquisition always succeeds; the epoch mechanics
stay identical so the fencing contract is exercised by every test run.
Only writes routed through transitions.cas_status are fenced today; Plan B
wires pipeline state changes through it.
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
            try:
                if not self._sqlite:
                    # Detach the raw connection so the session-owned lock has
                    # a dedicated lifetime outside the pool.
                    self._conn = self._engine.raw_connection()
                    self._conn.detach()
                    # must target the DBAPI connection: the pool fairy has no
                    # __setattr__ delegation, so setting it on self._conn is a no-op.
                    # dbapi_connection, not driver_connection — the latter is None
                    # for detached pyodbc connections (first live mssql CI run).
                    self._conn.dbapi_connection.autocommit = True
                    cur = self._conn.cursor()
                    try:
                        cur.execute(
                            "SET NOCOUNT ON; DECLARE @r int; "
                            "EXEC @r = sp_getapplock @Resource=?, "
                            "@LockMode='Exclusive', @LockOwner='Session', "
                            "@LockTimeout=0; SELECT @r",
                            (_LOCK_NAME,),
                        )
                        got = cur.fetchone()[0] >= 0
                    finally:
                        cur.close()
                    if not got:
                        self._demote()
                        return False
                epoch = self._bump_epoch()
            except Exception:
                self._demote()
                raise
            self.epoch = epoch
            self._leader = True
            return True

    def _bump_epoch(self) -> int:
        with self._engine.begin() as conn:
            conn.execute(text(
                "UPDATE leader_epochs SET epoch = epoch + 1 WHERE id = 1"))
            row = conn.execute(text(
                "SELECT epoch FROM leader_epochs WHERE id = 1")).first()
            if row is None:
                conn.execute(text(
                    "INSERT INTO leader_epochs (id, epoch) VALUES (1, 1)"))
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
