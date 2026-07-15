#!/usr/bin/env bash
# Local proof (no kind) that the golden template containerizes and runs its
# /health probe. Not in `task verify` — opt-in, like netpol-smoke.
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -t sf-app-smoke:dev sample/
CID=$(docker run -d -p 18000:8000 --user 10101:0 sf-app-smoke:dev)
trap 'docker rm -f "$CID" >/dev/null' EXIT
for _ in $(seq 1 30); do
  curl -sf http://localhost:18000/health >/dev/null && break || sleep 1
done
curl -sf http://localhost:18000/health | grep -q '"status":"ok"' \
  && echo "✓ golden template builds and answers /health as an arbitrary UID"
