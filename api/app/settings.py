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

# ---------- Kubernetes runner (Plan B1, spec §2/§5/§6) ----------
KUBE_NAMESPACE = os.environ.get("FACTORY_KUBE_NAMESPACE", "software-factory")
# One image for agent AND gate Jobs (spec §5); gates just get no LLM egress/key.
AGENT_IMAGE = os.environ.get("FACTORY_AGENT_IMAGE", "sf-agent:dev")
# In-cluster kill switch per Job. The ORCHESTRATOR wall clocks below are the
# backstop a partitioned node cannot dodge (spec §5 "Bounds") — they MUST
# exceed the corresponding activeDeadlineSeconds so kubelet gets first shot.
JOB_ACTIVE_DEADLINE = int(os.environ.get("FACTORY_JOB_ACTIVE_DEADLINE", "1800"))
GATE_ACTIVE_DEADLINE = int(os.environ.get("FACTORY_GATE_ACTIVE_DEADLINE", "900"))
STAGE_WALL_CLOCK = int(os.environ.get("FACTORY_STAGE_WALL_CLOCK", "2100"))
GATE_WALL_CLOCK = int(os.environ.get("FACTORY_GATE_WALL_CLOCK", "1200"))
# Backstop reaper (DEPLOY-03): the orchestrator's explicit Foreground delete_job
# is the PRIMARY reaper and captures logs/envelope first; ttlSecondsAfterFinished
# only collects Jobs a crashed/absent orchestrator never got to. Generous on
# purpose (1h) so it never races capture-before-delete on a healthy plane.
JOB_TTL_AFTER_FINISHED = int(os.environ.get("FACTORY_JOB_TTL_AFTER_FINISHED", "3600"))
# N=2: one retry-with-feedback, then needs_human (spec §4.6).
KUBE_MAX_ATTEMPTS = int(
    os.environ.get(
        "FACTORY_KUBE_MAX_ATTEMPTS",
        os.environ.get("FACTORY_MAX_ATTEMPTS", "2"),
    )
)
# Concurrent Jobs the orchestrator will run (spec §2).
KUBE_JOB_CAP = int(os.environ.get("FACTORY_JOB_CAP", "10"))

# ---------- FAIL-01: orchestrator-call timeouts ----------
# So a hung git subprocess or k8s call can't freeze the single-threaded tick
# forever. Timeouts are classified as INFRA (retry-neutral). The tick-age
# watchdog that surfaces a call which IGNORED its timeout is deferred to C7
# (it belongs with the OBS-02 livenessProbe).
GIT_TIMEOUT = int(os.environ.get("FACTORY_GIT_TIMEOUT", "120"))
KUBE_CONNECT_TIMEOUT = float(os.environ.get("FACTORY_KUBE_CONNECT_TIMEOUT", "5"))
KUBE_READ_TIMEOUT = float(os.environ.get("FACTORY_KUBE_READ_TIMEOUT", "30"))

# ---------- git-as-workspace + cluster profile (Plan B2, spec §2/§5/§6) ----------
# Base URL agent/gate Jobs clone from (the git-daemon sidecar). Empty = no git
# backbone configured: the kube runner behaves exactly like B1 (unit tests).
GIT_REMOTE_BASE = os.environ.get("FACTORY_GIT_REMOTE_BASE", "").rstrip("/")
# ---------- GitHub as the real remote (Plan B4, spec §5/§6) ----------
# Local profile: a personal github.com account + a fine-grained PAT. Empty token
# = no GitHub: agents push to the git-daemon and the merge is local (B2/B3),
# byte-for-byte. The office/Phase-2 GitHub App swaps in behind github.py's seam.
GITHUB_TOKEN = os.environ.get("FACTORY_GITHUB_TOKEN", "").strip()
GITHUB_OWNER = os.environ.get("FACTORY_GITHUB_OWNER", "").strip()
GITHUB_API = os.environ.get("FACTORY_GITHUB_API", "https://api.github.com").rstrip("/")
GITHUB_TOKEN_SECRET = os.environ.get(
    "FACTORY_GITHUB_TOKEN_SECRET", "sf-github-token"
)


def github_enabled() -> bool:
    """GitHub mode needs a git backbone (the local mirror the orchestrator fetches
    into) AND a token AND an owner. Any unset -> git-daemon remote + local merge."""
    return bool(GIT_REMOTE_BASE and GITHUB_TOKEN and GITHUB_OWNER)


# Forced non-root UID for agent/gate pods — restricted-SCC behavior is proven
# locally, not discovered at the office (spec §2). Any high UID works; the
# image is built to arbitrary-UID conventions (root group, g=u, HOME=/workspace).
KUBE_RUN_AS_UID = int(os.environ.get("FACTORY_KUBE_RUN_AS_UID", "10101"))
KUBE_AGENT_SA = os.environ.get("FACTORY_KUBE_AGENT_SA", "sf-agent")
KUBE_GATE_SA = os.environ.get("FACTORY_KUBE_GATE_SA", "sf-gate")
# Secret carrying the operator's ~/.codex/auth.json (task sync-codex-auth);
# mounted ONLY into stage pods — gates hold no LLM credential (spec §6).
CODEX_AUTH_SECRET = os.environ.get("FACTORY_CODEX_AUTH_SECRET", "sf-codex-auth")

# ---------- produced-app build + deploy (Plan B3, spec §7) ----------
# Registry the build Job pushes to AND the deploy pulls from — ONE image name for
# both (kaniko reaches it via cluster DNS; the node reaches it via a containerd
# mirror to a NodePort). Empty = build/deploy disabled: approve_merge behaves
# exactly like B2 (merge -> done). This is the B3 env gate, mirroring GIT_REMOTE_BASE.
REGISTRY = os.environ.get("FACTORY_REGISTRY", "").rstrip("/")
# Master switch for the post-merge deploy flow. Requires REGISTRY + GIT_REMOTE_BASE.
APP_DEPLOY = os.environ.get("FACTORY_APP_DEPLOY", "").lower() in ("1", "true", "yes")
KANIKO_IMAGE = os.environ.get("FACTORY_KANIKO_IMAGE", "gcr.io/kaniko-project/executor:latest")
# Pull-through proxy for BASE images: build pods have no internet (build-walls),
# so kaniko's --registry-mirror routes docker.io pulls through this one
# controlled door. Empty = no mirror flag (kaniko pulls direct — office/AKS
# profiles with open registry egress).
REGISTRY_PROXY = os.environ.get("FACTORY_REGISTRY_PROXY", "sf-registry-proxy:5000").rstrip("/")
APP_INGRESS_DOMAIN = os.environ.get("FACTORY_APP_INGRESS_DOMAIN", "localtest.me")
KUBE_BUILD_SA = os.environ.get("FACTORY_KUBE_BUILD_SA", "sf-build")
KUBE_APP_SA = os.environ.get("FACTORY_KUBE_APP_SA", "sf-app")
BUILD_ACTIVE_DEADLINE = int(os.environ.get("FACTORY_BUILD_ACTIVE_DEADLINE", "900"))
BUILD_WALL_CLOCK = int(os.environ.get("FACTORY_BUILD_WALL_CLOCK", "1200"))
DEPLOY_WALL_CLOCK = int(os.environ.get("FACTORY_DEPLOY_WALL_CLOCK", "600"))

# ---------- pre-merge requester preview + feedback loop (Plan C1) ----------
PREVIEW = os.environ.get("FACTORY_PREVIEW", "").lower() in ("1", "true", "yes")
PREVIEW_MAX_ROUNDS = int(os.environ.get("FACTORY_PREVIEW_MAX_ROUNDS", "3"))
PREVIEW_CAP = int(os.environ.get("FACTORY_PREVIEW_CAP", "5"))
PREVIEW_TTL = int(os.environ.get("FACTORY_PREVIEW_TTL", "259200"))


def preview_enabled() -> bool:
    """Previewing is an overlay on the produced-app deploy profile."""
    return app_deploy_enabled() and PREVIEW


def app_deploy_enabled() -> bool:
    """B3 build+deploy is active only with a git backbone AND a registry AND the
    switch. Any one unset -> B2 behavior (merge ends at main)."""
    return bool(GIT_REMOTE_BASE and REGISTRY and APP_DEPLOY)
