# Azure SQL dev database

> **Status (2026-07-20): PROVISIONED & LIVE-PROVEN.** Server
> `sf-dev-sql-<suffix>.database.windows.net` (southeastasia), db `factory`
> (Basic, LRS backups), admin `<admin-login>` — credentials live ONLY in
> `api/.env` (gitignored) and, for clusters, the `factory-db` Secret.
> the exact server name and login live in `api/.env.azure` (gitignored) and in
> the Azure portal — deliberately not recorded here, since this repo is public
> DTU 80% alert `sf-factory-dtu80` + $20/mo budget `sf-monthly-cap` are live.
> Alembic migrated to head; step-8 trio (leader `sp_getapplock` through the
> real gateway, transitions, intents) = 52/52 green. Note: step 8 shares one
> durable DB across runs — suites must scope assertions to their own rows
> (test_intents was fixed for this on 2026-07-20).


1. **User action (Azure portal or `az` CLI):** Create resource group `sf-dev`
   in the region nearest you.
2. **User action (Azure portal or `az` CLI):** Create logical server
   `sf-dev-sql-<suffix>` with SQL authentication and admin user `<admin-login>`.
3. **User action (Azure portal or `az` CLI):** Create database `factory` on the
   **Basic tier (~$5/mo)**. Set a DTU alert at 80% (Metrics → New alert rule),
   and expect to bump the database to S0 (~$15/mo) if the alert fires.
4. **User action (Azure portal or `az` CLI):** Add the laptop's public IP to the
   server firewall (Security → Networking → Add client IP). Re-add it whenever
   the public IP changes.
5. **User action (Azure portal or `az` CLI):** Add a $20/mo subscription budget
   alert under Cost Management → Budgets.
6. Put the connection string in `api/.env`; never commit it. Nothing loads this
   file automatically, so commands must load it explicitly:

   ```dotenv
   FACTORY_DB_URL="mssql+pyodbc://<admin-login>:<pw>@sf-dev-sql-<suffix>.database.windows.net:1433/factory?driver=ODBC+Driver+18+for+SQL+Server"
   (URL-encode special characters in the password — a raw @, /, #, or : silently breaks the URL; e.g. p@ss → p%40ss)
   ```

7. Run the migrations for the first time:

   ```bash
   cd api && uv run --env-file .env alembic upgrade head
   ```

8. Smoke-test the leader, transition, and intent paths against Azure SQL:

   **Warning:** Never point the full test suite at a database you care about; the `CI` environment variable gates destructive cleanup.

   ```bash
   FACTORY_TEST_USE_ENV_DB=1 uv run --env-file .env pytest tests/test_leader.py tests/test_transitions.py tests/test_intents.py -v
   ```

   The leader tests against real Azure SQL exercise `sp_getapplock` for real.

## Free-tier alternative

Azure SQL's serverless free offer exists, but auto-pause fights the factory's
tick loop: pausing kills database connections, while repeated wake-ups consume
the free quota. Basic is therefore the chosen default for the dev database.

## CI note

The `test-mssql` GitHub job covers the MSSQL dialect on every push. Step 8 adds
proof that `sp_getapplock` works through the real Azure gateway.
