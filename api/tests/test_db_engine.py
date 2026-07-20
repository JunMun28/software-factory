from app import db


def test_non_sqlite_engine_pool_matches_anyio_thread_capacity():
    assert db._engine_kwargs("mssql+pyodbc://factory") == {
        "pool_pre_ping": True,
        "pool_recycle": 1800,
        "pool_size": 20,
        "max_overflow": 20,
        "pool_timeout": 10,
    }


def test_sqlite_engine_keeps_its_existing_thread_option_only():
    assert db._engine_kwargs("sqlite:///factory.db") == {
        "connect_args": {"check_same_thread": False}
    }
