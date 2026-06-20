# Software Factory — local dev & verification
# Stack: FastAPI + uv (api/) · Angular 22 (web/) · SQLite (throwaway, gitignored)

.PHONY: dev api web test test-web build smoke lint verify reset up backup

WEB_PORT ?= 4200   # e.g. `make dev WEB_PORT=4300` if :4200 is taken

# Angular's CLI rejects Node older than the version pinned in .nvmrc. Dev shells
# sometimes surface an old nvm Node first on PATH (every version is installed),
# so resolve the pinned version's bin dir via nvm and put it first. No-op when
# nvm or that version is absent (e.g. CI that already activates a supported Node).
NODE_BIN := $(shell export NVM_DIR="$$HOME/.nvm"; \
	[ -s "$$NVM_DIR/nvm.sh" ] && . "$$NVM_DIR/nvm.sh" >/dev/null 2>&1; \
	n="$$(nvm which "$$(cat .nvmrc 2>/dev/null)" 2>/dev/null)"; [ -x "$$n" ] && dirname "$$n")
ifneq ($(NODE_BIN),)
export PATH := $(NODE_BIN):$(PATH)
endif

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

## Backend behavioral + hardening tests (lifecycle, gates, ledger idempotency, event log, simulator, validation)
test:
	cd api && uv run pytest -q

## Frontend unit tests (vitest — domain vocabulary, glyph logic, time handling).
## Runs BOTH projects in the workspace (ADR 0017): the `web` app AND the
## @sf/shared library, which now owns the moved util/poll/theme specs. A bare
## `ng test` is avoided because it would try every project at once; each is run
## explicitly so both spec sets stay in the verify chain.
test-web:
	cd web && npx ng test web && npx ng test shared

## Frontend production build (catches template/type errors)
build:
	cd web && npx ng build

## End-to-end lifecycle smoke against a real server on a throwaway DB
smoke:
	./scripts/smoke.sh

## Lint both sides (ruff + eslint + prettier check). `ng lint` is scoped to the
## `web` app: the @sf/shared library (ADR 0017) sits outside the web/ workspace
## root that the angular-eslint builder forces as its cwd, so a bare `ng lint`
## reports its files as ignored. Lint it explicitly with `ng lint shared`.
lint:
	cd api && uv run ruff check .
	cd web && npx ng lint web && npm run format:check

## Everything: lint + backend tests + web tests + build + smoke. Green = safe.
verify: lint test test-web build smoke
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
