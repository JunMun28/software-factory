# Software Factory — local dev & verification
# Stack: FastAPI + uv (api/) · Angular 22 (web/) · SQLite (throwaway, gitignored)

.PHONY: dev api web test test-web build smoke verify reset up backup

WEB_PORT ?= 4200   # e.g. `make dev WEB_PORT=4300` if :4200 is taken

## Run backend + frontend together (Ctrl-C stops both). Simulator ticks every 8s.
dev:
	@trap 'kill 0' EXIT; \
	( cd api && SIM_INTERVAL=8 uv run uvicorn app.main:app --port 8000 --reload ) & \
	( cd web && npx ng serve --port $(WEB_PORT) ) & \
	wait

## Backend only (auto-seeds on first boot; SIM_INTERVAL=8 keeps builds moving)
api:
	cd api && SIM_INTERVAL=8 uv run uvicorn app.main:app --port 8000 --reload

## Frontend only
web:
	cd web && npx ng serve --port $(WEB_PORT)

## Backend behavioral + hardening tests (31 — lifecycle, gates, ledger idempotency, event log, simulator, validation)
test:
	cd api && uv run pytest -q

## Frontend unit tests (vitest — domain vocabulary, glyph logic, time handling)
test-web:
	cd web && npx ng test

## Frontend production build (catches template/type errors)
build:
	cd web && npx ng build

## End-to-end lifecycle smoke against a real server on a throwaway DB
smoke:
	./scripts/smoke.sh

## Everything: backend tests + web tests + build + smoke. Green = safe.
verify: test test-web build smoke
	@echo "" && echo "✓ VERIFY PASSED — tests, build, and smoke all green"

## Production-shaped deployment: nginx + API + persistent volume on :8080
up:
	docker compose up --build

## Online backup of the SQLite system of record (safe on a LIVE database —
## uses sqlite's backup API, never a raw cp). For the compose stack:
##   docker compose exec api uv run --no-sync python -c "<same one-liner> '/data/factory.db'"
backup:
	@mkdir -p backups
	@python3 -c "import sqlite3,datetime,pathlib; src=sqlite3.connect('api/factory.db'); \
out=f'backups/factory-{datetime.datetime.now():%Y%m%d-%H%M%S}.db'; dst=sqlite3.connect(out); \
src.backup(dst); dst.close(); print(f'✓ {out} ({pathlib.Path(out).stat().st_size:,} bytes)')"

## Wipe the local database (re-seeds on next boot)
reset:
	rm -f api/factory.db api/factory.db-wal api/factory.db-shm && echo "factory.db removed — fresh seed on next 'make api'"
