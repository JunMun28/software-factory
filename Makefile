# Software Factory — local dev & verification
# Stack: FastAPI + uv (api/) · Angular 22 monorepo (apps/intake + apps/console,
# packages/shared) · SQLite (throwaway, gitignored). Single root node_modules;
# the Angular workspace (angular.json) lives at the repo root (ADR 0017 Phase 2).

.PHONY: dev api web intake console test test-web build smoke lint verify reset up backup

INTAKE_PORT  ?= 4201   # e.g. `make dev INTAKE_PORT=4301` if :4201 is taken
CONSOLE_PORT ?= 4202   # the second app gets its own origin (ADR 0017)
WEB_PORT     ?= $(INTAKE_PORT)   # back-compat alias for `make web`

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

## Run backend + BOTH frontends together (Ctrl-C stops all). Distinct origins:
## intake :4201, console :4202, api :8000. Simulator ticks every 8s.
dev:
	@trap 'kill 0' EXIT; \
	( cd api && SIM_INTERVAL=8 uv run uvicorn app.main:app --port 8000 --reload ) & \
	( npx ng serve intake --port $(INTAKE_PORT) ) & \
	( npx ng serve console --port $(CONSOLE_PORT) ) & \
	wait

## Backend only (auto-seeds on first boot; SIM_INTERVAL=8 keeps builds moving)
api:
	cd api && SIM_INTERVAL=8 uv run uvicorn app.main:app --port 8000 --reload

## Serve the Intake app (the default `web` target — back-compat alias for intake)
web: intake

## Serve the Intake app (submitter + admin for now)
intake:
	npx ng serve intake --port $(INTAKE_PORT)

## Serve the Console shell
console:
	npx ng serve console --port $(CONSOLE_PORT)

## Backend behavioral + hardening tests (lifecycle, gates, ledger idempotency, event log, simulator, validation)
test:
	cd api && uv run pytest -q

## Frontend unit tests (vitest — domain vocabulary, glyph logic, time handling).
## Runs ALL THREE projects in the repo-root workspace (ADR 0017): the intake app
## (former web-app specs), the console shell, AND the @sf/shared library, which
## owns the moved util/poll/theme specs. A bare `ng test` is avoided because it
## would try every project at once; each is run explicitly so every spec set
## stays in the verify chain.
test-web:
	npx ng test intake && npx ng test console && npx ng test shared

## Frontend production build of BOTH apps (catches template/type errors)
build:
	npx ng build intake && npx ng build console

## End-to-end lifecycle smoke against a real server on a throwaway DB
smoke:
	./scripts/smoke.sh

## Lint both sides (ruff + eslint + prettier check). The Angular workspace now
## lives at the repo root (ADR 0017 Phase 2), so each project is linted
## explicitly — intake + console apps and the @sf/shared library (its sf-prefixed
## selector rules live in packages/shared/eslint.config.js).
lint:
	cd api && uv run ruff check .
	npx ng lint intake && npx ng lint console && npx ng lint shared && npm run format:check

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
