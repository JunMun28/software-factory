# sf-ngv0-sandbox — ONE per-chat dev-server pod for the ng-v0 preview tier.
#
# It mirrors preview-manager.ts's LocalProcessSandbox (runEnsure/ensureDeps) but
# inside a pod, from a git clone: clone the chat workspace from the orchestrator
# git-daemon, `npm install` + `uv sync` + seed, then run the golden template's
# backend (uvicorn :8001) and frontend (ng serve :8080) plus a tiny resync HTTP
# endpoint (:8090) that git-fetch/reset-hard's the workspace so the dev server's
# file watcher HMR-reloads on each green turn (design: docs/design/cloud-sandbox-pods.md).
#
# Build (self-contained context — the template is CLONED at runtime, not baked):
#   docker build -f app-preview/sandbox/Dockerfile -t sf-ngv0-sandbox:dev app-preview/sandbox
#
# Runtime env: CHAT_ID (required), GIT_REMOTE=git://ng-v0-orchestrator:9418.
#
# Built to ARBITRARY-UID conventions (sf-agent pattern): root-group ownership,
# chmod g=u, HOME=/workspace — so a restricted SCC / non-root random UID can read
# and write /workspace. Proven local build runs as root; see the report note.
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

# git (clone + resync), node 24 + npm (dev server + resync helper), curl/ca-certs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# The golden template's web half needs the Angular CLI on PATH (`ng serve`).
RUN npm install -g @angular/cli \
  && npm cache clean --force

# The golden template pins Python 3.12 (.python-version); bake 3.12 AND 3.13 into
# a SHARED, world-readable install dir so an arbitrary UID can find the
# interpreter offline (a root-homed managed install is invisible to it — the
# sf-agent live finding). Downloads stay ENABLED (unlike the walled gate) because
# the sandbox tier is allowed the package registries for install.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
RUN uv python install 3.12 3.13 \
  && chmod -R a+rX /opt/uv

# arbitrary-UID pods clone a repo whose objects are owned by another uid; git's
# dubious-ownership check would refuse it (the pod uid never matches the owner).
RUN git config --system safe.directory '*'

COPY entrypoint.sh /opt/sandbox/entrypoint.sh
COPY resync.js     /opt/sandbox/resync.js

# arbitrary-UID conventions: any UID in the root group can read/execute/write.
RUN chmod +x /opt/sandbox/entrypoint.sh \
  && mkdir -p /workspace \
  && chgrp -R 0 /opt/sandbox /workspace \
  && chmod -R g=u /opt/sandbox /workspace

# HOME=/workspace keeps tool config group-writable for arbitrary UIDs; caches go
# to /tmp so they never pollute the cloned working tree that resync reset-hards.
ENV HOME=/workspace \
    WORKSPACE=/workspace \
    GIT_REMOTE=git://ng-v0-orchestrator:9418 \
    FRONTEND_PORT=8080 \
    BACKEND_PORT=8001 \
    RESYNC_PORT=8090 \
    NPM_CONFIG_CACHE=/tmp/.npm \
    UV_CACHE_DIR=/tmp/.uv-cache

WORKDIR /workspace

# 8080 = frontend (the exposed preview port); 8090 = resync control endpoint.
# 8001 (backend) is pod-internal only — the frontend proxies /api to it.
EXPOSE 8080 8090

ENTRYPOINT ["/opt/sandbox/entrypoint.sh"]
