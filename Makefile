# Software Factory — local dev & verification
# Stack: FastAPI + uv (api/) · Angular 22 (web/) · SQLite (throwaway, gitignored)

.PHONY: dev api web test test-web build smoke verify reset up

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

## Wipe the local database (re-seeds on next boot)
reset:
	rm -f api/factory.db && echo "factory.db removed — fresh seed on next 'make api'"
