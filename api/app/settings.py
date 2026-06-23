"""Every env-driven knob in one place (ADR 0013).

Values are read once at import time; path defaults are anchored to the api/
directory so launching from the wrong CWD can never silently create a second
database or strand the workspaces tree. The two runtime-switchable modes
(FACTORY_BRAIN, FACTORY_RUNNER) intentionally stay per-call reads in
agent_exec.py — tests flip them with monkeypatch.setenv mid-process.
"""
import os
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]  # .../api
REPO_DIR = API_DIR.parent

DB_URL = os.environ.get("FACTORY_DB_URL", f"sqlite:///{API_DIR / 'factory.db'}")
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
CLAUDE_MODEL = os.environ.get("FACTORY_CLAUDE_MODEL", "claude-haiku-4-5")
CODEX_BIN = os.environ.get("CODEX_BIN", "codex")
CODEX_MODEL = os.environ.get("FACTORY_CODEX_MODEL", "")  # empty → the CLI's configured default
WORKSPACES = Path(os.environ.get("FACTORY_WORKSPACES", str(API_DIR / "workspaces")))
SAMPLE = Path(os.environ.get("FACTORY_SAMPLE", str(REPO_DIR / "sample")))
STAGE_TIMEOUT = int(os.environ.get("FACTORY_STAGE_TIMEOUT", "300"))
SIM_INTERVAL = float(os.environ.get("SIM_INTERVAL", "0") or 0)
# run-state health (spec 2026-06-12 §5): an in-flight run whose latest step
# event is older than this renders "slow". Default 3× the sim tick; fixed
# fallback when the interval is 0 (tests, manual ticking).
RUN_SLOW_AFTER_SECONDS = float(os.environ.get("RUN_SLOW_AFTER_SECONDS", "0") or 0) or (
    3 * SIM_INTERVAL if SIM_INTERVAL > 0 else 30.0
)
# demo world on first boot — on for dev/tests, OFF in the compose stack so a
# production DB never starts polluted with fictional requests and audit rows
SEED_DEMO = os.environ.get("FACTORY_SEED_DEMO", "1").lower() not in ("0", "false", "no")
LOG_LEVEL = os.environ.get("FACTORY_LOG_LEVEL", "INFO")
# Attachments (ADR 0022) — bytes on the local FS, metadata in the DB.
UPLOADS = Path(os.environ.get("FACTORY_UPLOADS", str(API_DIR / "uploads")))
ATTACH_MAX_BYTES = int(os.environ.get("FACTORY_ATTACH_MAX_BYTES", str(10 * 1024 * 1024)))  # 10 MB
ATTACH_MAX_COUNT = int(os.environ.get("FACTORY_ATTACH_MAX_COUNT", "5"))
ATTACH_MAX_IMAGES = int(os.environ.get("FACTORY_ATTACH_MAX_IMAGES", "4"))  # passed to codex --image
