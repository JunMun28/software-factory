#!/usr/bin/env bash
set -euo pipefail

# The orchestrator runs a trusted copy of this script with the workspace as cwd.
ROOT="$PWD"
cd "$ROOT"

echo "==> Gate: frontend"
cd frontend
if [[ ! -d node_modules ]]; then
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
fi
npm run build

echo "==> Gate: backend"
cd "$ROOT/backend"
uv sync
uv run ruff check .
uv run python -m app.startcheck
uv run python -m app.smoke
uv run pytest -q

echo "GATE GREEN"
