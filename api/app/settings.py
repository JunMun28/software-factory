"""Every env-driven knob in one place (ADR 0013).

Values are read once at import time; path defaults are anchored to the api/
directory so launching from the wrong CWD can never silently create a second
database or strand the workspaces tree. The two runtime-switchable modes
(FACTORY_BRAIN, FACTORY_RUNNER) intentionally stay per-call reads in
claude_exec.py — tests flip them with monkeypatch.setenv mid-process.
"""
import os
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]  # .../api
REPO_DIR = API_DIR.parent

DB_URL = os.environ.get("FACTORY_DB_URL", f"sqlite:///{API_DIR / 'factory.db'}")
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
CLAUDE_MODEL = os.environ.get("FACTORY_CLAUDE_MODEL", "claude-haiku-4-5")
WORKSPACES = Path(os.environ.get("FACTORY_WORKSPACES", str(API_DIR / "workspaces")))
SAMPLE = Path(os.environ.get("FACTORY_SAMPLE", str(REPO_DIR / "sample")))
STAGE_TIMEOUT = int(os.environ.get("FACTORY_STAGE_TIMEOUT", "300"))
SIM_INTERVAL = float(os.environ.get("SIM_INTERVAL", "0") or 0)
# demo world on first boot — on for dev/tests, OFF in the compose stack so a
# production DB never starts polluted with fictional requests and audit rows
SEED_DEMO = os.environ.get("FACTORY_SEED_DEMO", "1").lower() not in ("0", "false", "no")
LOG_LEVEL = os.environ.get("FACTORY_LOG_LEVEL", "INFO")
