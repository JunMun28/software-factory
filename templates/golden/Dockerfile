# Produced-app image for the Angular + FastAPI golden template.
FROM node:24-slim AS frontend-build
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.7.16 /uv /uvx /bin/
WORKDIR /app
COPY backend/ ./
RUN uv sync --frozen --no-dev
COPY --from=frontend-build /frontend/dist/frontend/browser ./static
ENV PATH="/app/.venv/bin:$PATH" HOME=/app
RUN chgrp -R 0 /app && chmod -R g=u /app
EXPOSE 8000
USER 10101
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
