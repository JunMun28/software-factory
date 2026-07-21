# Build context is the REPO ROOT (like api/Dockerfile), NOT app-preview/orchestrator:
#   docker build -f app-preview/orchestrator/Dockerfile -t sf-ngv0-orchestrator:dev .
# The factory's ONE golden template lives at <repo>/templates/golden (VENDORED.md);
# it must be baked in, so the build needs the repo root as context.
#
# The SAME image doubles as the git-daemon sidecar (cloud-sandbox-pods.md Phase 0),
# so `git` is installed in the final stage even though the k8s manifest — not this
# CMD — sets the sidecar's git-daemon command. EXPOSE 7071 (http) + 9418 (git-daemon).

# ---- build stage: compile TypeScript -> dist/ ----
FROM node:24-slim AS build
WORKDIR /app

# Deterministic install from the committed lockfile (dev deps included: tsc).
COPY app-preview/orchestrator/package.json app-preview/orchestrator/package-lock.json ./
RUN npm ci

# Sources + build config. tsconfig.build.json emits dist/ (rootDir ./src).
COPY app-preview/orchestrator/tsconfig.json app-preview/orchestrator/tsconfig.build.json ./
COPY app-preview/orchestrator/src ./src
RUN npm run build

# ---- runtime stage: lean, git-capable ----
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# git drives the workspaces (git.ts) AND backs the git-daemon sidecar that
# exports /data/workspaces on 9418.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Production dependencies only (mssql, @azure/identity, hono, opencode sdk).
# node:sqlite is a Node 24 built-in — no native module to compile.
COPY app-preview/orchestrator/package.json app-preview/orchestrator/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled app. platform-db.ts resolves migrations at <dist>/../migrations,
# so migrations/ must sit next to dist/ at /app/migrations.
COPY --from=build /app/dist ./dist
COPY app-preview/orchestrator/migrations ./migrations

# The golden seed template, baked at the TEMPLATE_PATH the manifest points to.
COPY templates/golden ./templates/golden

# Runtime config comes from the manifest env: PORT=7071, ORCHESTRATOR_HOSTNAME=0.0.0.0,
# PLATFORM_DB_PATH=/data/platform.db, WORKSPACES_ROOT=/data/workspaces,
# PREVIEW_ROOT=/data/preview, TRUSTED_ROOT=/data/trusted, TEMPLATE_PATH=/app/templates/golden.
EXPOSE 7071 9418
CMD ["node", "dist/index.js"]
