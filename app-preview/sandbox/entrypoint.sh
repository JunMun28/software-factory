#!/usr/bin/env bash
# sf-ngv0-sandbox entrypoint — the pod-side mirror of preview-manager.ts's
# LocalProcessSandbox (runEnsure / ensureDeps), driven from a git clone.
#
# Flow (design: docs/design/cloud-sandbox-pods.md, Phase 1 "dev-server-tracks-git"):
#   1. clone git://<orchestrator>:9418/<CHAT_ID> -> /workspace (shallow)
#   2. frontend: npm install     backend: uv sync + `python -m app.seed`
#   3. start backend uvicorn :8001 (background) and frontend ng serve :8080
#      (background) with a proxy that routes /api -> the backend
#   4. run the resync HTTP endpoint :8090 in the FOREGROUND (keeps the pod alive);
#      POST /resync git-fetch+reset-hard's the tree so the Angular watcher HMRs.
#
# Not `set -e`: dependency/seed hiccups are logged, but the pod stays up so the
# resync endpoint and whatever dev server DID start remain reachable.
set -uo pipefail

CHAT_ID="${CHAT_ID:?CHAT_ID is required}"
GIT_REMOTE="${GIT_REMOTE:-git://ng-v0-orchestrator:9418}"
WORKSPACE="${WORKSPACE:-/workspace}"
FRONTEND_PORT="${FRONTEND_PORT:-8080}"
BACKEND_PORT="${BACKEND_PORT:-8001}"
RESYNC_PORT="${RESYNC_PORT:-8090}"

log() { printf '[sandbox %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

BACKEND_PID=""
FRONTEND_PID=""
cleanup() {
  log "shutting down (signal) — stopping dev servers"
  [ -n "$BACKEND_PID" ]  && kill "$BACKEND_PID"  2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup TERM INT

# ---------------------------------------------------------------- 1. clone ----
REPO_URL="${GIT_REMOTE%/}/${CHAT_ID}"
if [ -d "$WORKSPACE/.git" ]; then
  # A restarted pod already has the clone; just move it to the current tip.
  log "workspace already a git repo — fetching tip"
  git -C "$WORKSPACE" fetch origin       || log "WARN: fetch failed (serving current tree)"
  git -C "$WORKSPACE" reset --hard FETCH_HEAD 2>/dev/null \
    || git -C "$WORKSPACE" reset --hard origin/HEAD 2>/dev/null \
    || log "WARN: reset failed (serving current tree)"
else
  log "cloning $REPO_URL -> $WORKSPACE (shallow)"
  if ! git clone --depth 1 "$REPO_URL" "$WORKSPACE"; then
    # /workspace may be a non-empty HOME; clone to a temp dir and move it in.
    log "direct clone failed — retrying via temp dir"
    tmp="$(mktemp -d)"
    if git clone --depth 1 "$REPO_URL" "$tmp/repo"; then
      shopt -s dotglob
      mv "$tmp/repo"/* "$WORKSPACE"/ 2>/dev/null || true
      shopt -u dotglob
      rm -rf "$tmp"
    else
      log "FATAL: clone of $REPO_URL failed"
      rm -rf "$tmp"
      exit 1
    fi
  fi
fi

FRONTEND_DIR="$WORKSPACE/frontend"
BACKEND_DIR="$WORKSPACE/backend"
HAS_FRONTEND=0; [ -d "$FRONTEND_DIR" ] && [ -f "$FRONTEND_DIR/package.json" ] && HAS_FRONTEND=1
HAS_BACKEND=0;  [ -d "$BACKEND_DIR" ]  && [ -f "$BACKEND_DIR/pyproject.toml" ] && HAS_BACKEND=1
if [ "$HAS_FRONTEND" -eq 0 ] && [ "$HAS_BACKEND" -eq 0 ]; then
  log "WARN: workspace has no frontend/ or backend/ split — nothing to serve; resync only"
fi

# ------------------------------------------------------------ 2/3. backend ----
if [ "$HAS_BACKEND" -eq 1 ]; then
  log "backend: uv sync"
  ( cd "$BACKEND_DIR" && uv sync ) || log "WARN: uv sync failed"
  log "backend: seeding (python -m app.seed)"
  ( cd "$BACKEND_DIR" && uv run python -m app.seed ) || log "WARN: seed failed (continuing)"
  log "backend: uvicorn app.main:app --port $BACKEND_PORT"
  ( cd "$BACKEND_DIR" && exec uv run uvicorn app.main:app --host 0.0.0.0 --port "$BACKEND_PORT" ) &
  BACKEND_PID=$!
else
  log "no backend/ — skipping backend"
fi

# ----------------------------------------------------------- 2/3. frontend ----
if [ "$HAS_FRONTEND" -eq 1 ]; then
  log "frontend: npm install"
  ( cd "$FRONTEND_DIR" && npm install ) || log "WARN: npm install failed"

  # Route /api to the pod-local backend. Mirrors preview-manager.ts's generated
  # proxy.json; it is appended after any baked --proxy-config (last one wins).
  PROXY_JSON="$FRONTEND_DIR/sandbox-proxy.json"
  cat > "$PROXY_JSON" <<JSON
{
  "/api": {
    "target": "http://localhost:${BACKEND_PORT}",
    "secure": false,
    "changeOrigin": true
  }
}
JSON

  log "frontend: ng serve --port $FRONTEND_PORT --host 0.0.0.0 --allowed-hosts"
  # 8080 is the port the pod EXPOSES; --host 0.0.0.0 so the orchestrator bridge
  # (via the Service DNS) can reach it. --proxy-config sends /api -> :8001.
  # --allowed-hosts (Vite: allowedHosts=true) turns off the dev server's host
  # check — the bridge/readiness probe arrives with the Service-DNS Host, which
  # the default localhost-only check rejects with 403.
  ( cd "$FRONTEND_DIR" && exec npm start -- \
      --port "$FRONTEND_PORT" \
      --host 0.0.0.0 \
      --allowed-hosts \
      --proxy-config "$PROXY_JSON" ) &
  FRONTEND_PID=$!
else
  log "no frontend/ — skipping frontend"
fi

# --------------------------------------------------------------- 4. resync ----
# Foreground: keeps the pod alive and lets the orchestrator poke a git ref after
# every green turn. Runs concurrently with the backgrounded dev servers above.
log "resync: listening on :$RESYNC_PORT (POST /resync {sha?})"
WORKSPACE="$WORKSPACE" RESYNC_PORT="$RESYNC_PORT" node /opt/sandbox/resync.js
