FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

WORKDIR /srv
ENV UV_COMPILE_BYTECODE=1 UV_NO_DEV=1

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY app ./app

# data lives outside the image; compose mounts a named volume here
ENV FACTORY_DB_URL=sqlite:////data/factory.db
VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD ["uv", "run", "--no-sync", "python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/api/health', timeout=2).status == 200 else 1)"]

CMD ["uv", "run", "--no-sync", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
