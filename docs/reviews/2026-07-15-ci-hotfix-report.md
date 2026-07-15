# CI Hotfix Report

## Status

Both CI root causes are fixed on `ci-hotfix`; no commit was created.

## Root causes

1. **MSSQL leader epoch seed:** SQLAlchemy treated the singleton integer primary key as autoincrementing, so MSSQL rendered it as `IDENTITY` while both Alembic and `_bump_epoch()` explicitly insert `id=1`.
2. **Smoke approve ledger:** this was not a timing race. The smoke script still posted the removed `actor` field after `OperatorNote` changed to require `operator_id`; CI logged a 422 that `curl -s` discarded, leaving the request untouched at `pending_approval/spec/False/False/False`.
3. **ResizeObserver logs:** the Vitest messages were nonfatal—CI reported intake 68/68, console 55/55, and shared 88/88—but Lenis constructed a `ResizeObserver` that jsdom did not provide.

The approval transaction itself is correct: `transitions.apply()` flushes then refreshes the ORM object, `repo_ready` and `spec_pr_open` are assigned after that refresh, and the caller's final `db.commit()` persists them with the transition, audit, and gate event.

## Files changed

- `api/app/models.py`
- `api/alembic/versions/b71c2e4f9a10_rebuild_leader_epoch_without_identity.py`
- `api/tests/test_migrations.py`
- `scripts/smoke.sh`
- `angular.json`
- `apps/intake/tsconfig.spec.json`
- `apps/intake/src/test-setup.ts`
- `.superpowers-ci-hotfix-report.md`

## Verification

- Backend: `267 passed`.
- Alembic: fresh SQLite upgrade and upgrade/downgrade/upgrade cycle pass with seed `(1, 0)`.
- MSSQL offline DDL: the new revision renders `id INTEGER NOT NULL` with no `IDENTITY` and re-seeds `(1, 0)`.
- Frontend: intake `68 passed`, console `55 passed`, shared `88 passed`; no `ResizeObserver` errors after the setup stub.
- Angular: both development builds pass under pinned Node 24.15.0.
- Smoke contract: `bash -n` passes, all three approve calls send `operator_id: 1`, approve now uses `curl -f`, and the API ledger/idempotency regression passes.

The managed execution sandbox prevents a live smoke rerun because it rejects binding `127.0.0.1:8911`. It also blocks production font inlining by denying DNS access to `fonts.googleapis.com`; the production build reached that external fetch after TypeScript compilation. The initial local production build abort was the Angular LMDB cache's native module; CI mode disables that local-only cache.
