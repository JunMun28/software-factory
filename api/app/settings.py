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
OPENCODE_BIN = os.environ.get("OPENCODE_BIN", "opencode")
# opencode model ids are "provider/model". Default to a provider authed on this host.
OPENCODE_MODEL = os.environ.get("FACTORY_OPENCODE_MODEL", "openai/gpt-5.5").strip()
# Read-only vs write is a HARD guarantee, enforced by a factory-owned config pointed at
# via OPENCODE_CONFIG (never the operator's global agents). deny = fail-closed sandbox.
OPENCODE_CONFIG_DIR = API_DIR / "app" / "opencode"
OPENCODE_RO_CONFIG = OPENCODE_CONFIG_DIR / "factory-readonly.json"
OPENCODE_RW_CONFIG = OPENCODE_CONFIG_DIR / "factory-write.json"
WORKSPACES = Path(os.environ.get("FACTORY_WORKSPACES", str(API_DIR / "workspaces")))
SAMPLE = Path(os.environ.get("FACTORY_SAMPLE", str(REPO_DIR / "sample")))
STAGE_TIMEOUT = int(os.environ.get("FACTORY_STAGE_TIMEOUT", "300"))
# Per intake-interview model call. A cold `claude` CLI on a larger model routinely
# runs 60-90s; too tight a bound makes questions time out and fall back to the
# shallow scripted script, which defeats the adaptive-depth budget (esp. new apps).
INTERVIEW_TIMEOUT = int(os.environ.get("FACTORY_INTERVIEW_TIMEOUT", "120"))
# Reasoning-effort dial for the intake brain's read-only calls (low|medium|high|
# xhigh|max). Empty → the model's default. Lower = faster but a quality risk on
# deep interviews, so it ships off; --safe-mode already cuts the bulk of the wait.
INTERVIEW_EFFORT = os.environ.get("FACTORY_INTERVIEW_EFFORT", "").strip()
# Prototype step (new-app only). A full hi-fi HTML document is a much bigger generation than a
# one-line interview question, so it gets its own longer bound. Default to sonnet-5: it clears the
# taste>=7 bar for the baoyu/artifact-design harness AND token-streams smoothly (so the prose
# preamble types out live, like the interview) — opus is thinking-heavy and slow, which stalls the
# live typewriter on this interactive step. Set FACTORY_PROTOTYPE_MODEL=claude-opus-4-8 to trade
# streaming/latency for max quality. Applies to the claude CLI path; codex keeps CODEX_MODEL.
PROTOTYPE_TIMEOUT = int(os.environ.get("FACTORY_PROTOTYPE_TIMEOUT", "240"))
PROTOTYPE_MODEL = os.environ.get("FACTORY_PROTOTYPE_MODEL", "claude-sonnet-5").strip()
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
ATTACH_MAX_BYTES = int(os.environ.get("FACTORY_ATTACH_MAX_BYTES", str(100 * 1024 * 1024)))  # 100 MB
ATTACH_MAX_COUNT = int(os.environ.get("FACTORY_ATTACH_MAX_COUNT", "5"))
ATTACH_MAX_IMAGES = int(os.environ.get("FACTORY_ATTACH_MAX_IMAGES", "4"))  # passed to codex --image
