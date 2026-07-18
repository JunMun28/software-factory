# sf-agent — ONE image for agent (stage) and gate Jobs (spec §5).
# Contents: git, python+uv+pytest, node+Angular CLI, opencode + codex CLIs,
# factory-owned prompts + opencode configs. Built to ARBITRARY-UID
# conventions: root group ownership, chmod g=u, HOME=/workspace — restricted
# SCC compatibility is proven locally, not discovered at the office.
#   docker build -t sf-agent:dev -f docker/sf-agent/Dockerfile .
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

ARG TARGETARCH
ARG GITLEAKS_VERSION=8.24.2

# build-essential: some golden-template deps (httptools cp312/aarch64) ship no
# prebuilt wheel; the IMAGE build compiles them once into the shared uv cache,
# so walled gate pods never need a compiler or the network.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates jq build-essential \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Pinned, multi-arch gitleaks binary. Gate pods have no internet egress, so the
# scanner must be present in the image before the committed diff is graded.
RUN case "$TARGETARCH" in \
      amd64) gitleaks_arch=x64 ;; \
      arm64) gitleaks_arch=arm64 ;; \
      *) echo "unsupported gitleaks architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${gitleaks_arch}.tar.gz" \
    | tar -xz -C /usr/local/bin gitleaks \
  && gitleaks version

# the two agent CLIs + the Angular CLI for the golden template's web half
RUN npm install -g opencode-ai @openai/codex @angular/cli \
  && npm cache clean --force

# BUILD-02 v1: gates remain network-closed. Pre-bake the golden runtime/test
# stack so collection can import common app dependencies. Arbitrary per-app
# requirements.txt installation remains phased until a controlled package
# mirror can be added without weakening gate-pod egress.
# C5 implementation note: full Trivy IMAGE scanning is also PHASED/office;
# gitleaks covers committed-diff secrets in the merge gate here.
RUN uv pip install --system \
      "pytest>=9,<10" \
      "fastapi>=0.115,<0.116" \
      "uvicorn[standard]>=0.32,<0.33" \
      "httpx>=0.27,<1" \
      "pydantic>=2.9,<3"

# The golden template pins Python 3.12 (.python-version); gate pods have NO
# egress by design, so the interpreter must be baked in — uv dialing out for
# a cpython download inside the gate is exactly what failed live (E2E-4).
# A SHARED install dir, because pods run as arbitrary UIDs (10101): a
# root-homed managed install is invisible to them (second live finding).
# UV_PYTHON_DOWNLOADS=never makes any future gap fail loudly, not dial out.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
RUN uv python install 3.12 && chmod -R a+rX /opt/uv
ENV UV_PYTHON_DOWNLOADS=never

# Warm the shared uv cache with the golden template's LOCKED dependency set
# (third live E2E-4 finding: gate-time `uv sync` dialed PyPI for wheels).
# A complete cache makes the walled gate fully offline for the pinned lock;
# an agent silently ADDING a dep will fail the gate loudly — by design (the
# office answer for legit new deps is an internal mirror, not gate egress).
ENV UV_CACHE_DIR=/opt/uv/cache
COPY templates/golden/backend/pyproject.toml templates/golden/backend/uv.lock /tmp/golden-lock/
RUN cd /tmp/golden-lock \
  && uv venv --python 3.12 /tmp/golden-venv \
  && VIRTUAL_ENV=/tmp/golden-venv uv sync --frozen --active \
  && rm -rf /tmp/golden-venv /tmp/golden-lock \
  && chmod -R a+rwX /opt/uv/cache && chmod -R a+rX /opt/uv/python

# Baked frontend node_modules (E2E-4 #15): the egress-walled gate pod cannot
# npm ci, so frontend TESTS were never gated — the reviewer kept catching
# broken specs the implementer's own gate called GREEN. The template lock is
# frozen (DEPENDENCY FREEZE), so an image-time npm ci is exact: the gate
# copies this tree in when the repo's package-lock.json matches the baked one.
COPY templates/golden/frontend/package.json templates/golden/frontend/package-lock.json /opt/sf/golden-npm/
RUN cd /opt/sf/golden-npm \
  && npm ci --no-audit --no-fund \
  && npm cache clean --force \
  && chmod -R a+rX /opt/sf/golden-npm

# arbitrary-UID pods and local fixture tests clone repos owned by OTHER uids;
# git's dubious-ownership check would refuse them (the pod uid never matches)
RUN git config --system safe.directory '*'

COPY docker/sf-agent/entrypoint.sh /opt/sf/entrypoint.sh
COPY docker/sf-agent/gate.sh /opt/sf/gate.sh
COPY docker/sf-agent/prompts /opt/sf/prompts
# the factory-owned opencode read-only/write configs (ADR 0024)
COPY api/app/opencode /opt/sf/opencode

# arbitrary-UID conventions: any UID in root group can read/execute/write
RUN chmod +x /opt/sf/entrypoint.sh /opt/sf/gate.sh \
  && mkdir -p /workspace \
  && chgrp -R 0 /opt/sf /workspace \
  && chmod -R g=u /opt/sf /workspace

ENV HOME=/workspace
WORKDIR /workspace
ENTRYPOINT ["/opt/sf/entrypoint.sh"]
