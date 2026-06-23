# Build context is the REPO ROOT (see docker-compose.yml): the runner needs
# sample/ baked in, and workspaces must live on the /data volume — otherwise
# the factory's actual output is destroyed on every image rebuild.
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

WORKDIR /srv
ENV UV_COMPILE_BYTECODE=1 UV_NO_DEV=1

# git drives the per-request workspaces (ADR 0011); poppler-utils gives the
# brain `pdftotext` to self-read PDF attachments in its sandbox (ADR 0022).
# NOTE: the real-runner mode additionally needs the agent CLI in the container —
# codex by default, FACTORY_CLI=claude for Claude Code — plus its credentials.
# See README "Real agent modes"; sim mode works out of the box.
RUN apt-get update && apt-get install -y --no-install-recommends git poppler-utils \
  && rm -rf /var/lib/apt/lists/*

COPY api/pyproject.toml api/uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY api/app ./app
COPY sample /srv/sample

# data lives outside the image; compose mounts a named volume here
ENV FACTORY_DB_URL=sqlite:////data/factory.db \
    FACTORY_SAMPLE=/srv/sample \
    FACTORY_WORKSPACES=/data/workspaces
VOLUME /data
EXPOSE 8000

# /api/health runs SELECT 1 — a locked or corrupt DB now fails this check
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD ["uv", "run", "--no-sync", "python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/api/health', timeout=2).status == 200 else 1)"]

CMD ["uv", "run", "--no-sync", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
