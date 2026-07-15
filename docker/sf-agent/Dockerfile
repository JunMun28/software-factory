# sf-agent — ONE image for agent (stage) and gate Jobs (spec §5).
# Contents: git, python+uv+pytest, node+Angular CLI, opencode + codex CLIs,
# factory-owned prompts + opencode configs. Built to ARBITRARY-UID
# conventions: root group ownership, chmod g=u, HOME=/workspace — restricted
# SCC compatibility is proven locally, not discovered at the office.
#   docker build -t sf-agent:dev -f docker/sf-agent/Dockerfile .
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates jq \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# the two agent CLIs + the Angular CLI for the golden template's web half
RUN npm install -g opencode-ai @openai/codex @angular/cli \
  && npm cache clean --force

# the gate runs the factory-owned test command with the system interpreter
RUN uv pip install --system pytest

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
