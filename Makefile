# Software Factory — local dev & verification
# Stack: FastAPI + uv (api/) · Angular 22 (web/) · SQLite (throwaway, gitignored)

.PHONY: dev api web test build smoke verify reset

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

## Backend behavioral tests (12 — lifecycle, gates, ledger idempotency, event log, simulator)
test:
	cd api && uv run pytest -q

## Frontend production build (catches template/type errors)
build:
	cd web && npx ng build

## End-to-end lifecycle smoke against a real server on a throwaway DB
smoke:
	./scripts/smoke.sh

## Everything: tests + build + smoke. Green = safe.
verify: test build smoke
	@echo "" && echo "✓ VERIFY PASSED — tests, build, and smoke all green"

## Wipe the local database (re-seeds on next boot)
reset:
	rm -f api/factory.db && echo "factory.db removed — fresh seed on next 'make api'"
