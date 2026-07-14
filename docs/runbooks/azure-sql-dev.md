# Azure SQL dev database

1. **User action (Azure portal or `az` CLI):** Create resource group `sf-dev`
   in the region nearest you.
2. **User action (Azure portal or `az` CLI):** Create logical server
   `sf-dev-sql-<suffix>` with SQL authentication and admin user `sffactory`.
3. **User action (Azure portal or `az` CLI):** Create database `factory` on the
   **Basic tier (~$5/mo)**. Set a DTU alert at 80% (Metrics → New alert rule),
   and expect to bump the database to S0 (~$15/mo) if the alert fires.
4. **User action (Azure portal or `az` CLI):** Add the laptop's public IP to the
   server firewall (Security → Networking → Add client IP). Re-add it whenever
   the public IP changes.
5. **User action (Azure portal or `az` CLI):** Add a $20/mo subscription budget
   alert under Cost Management → Budgets.
6. Put the connection string in `api/.env`; never commit it:

   ```dotenv
   FACTORY_DB_URL="mssql+pyodbc://sffactory:<pw>@sf-dev-sql-<suffix>.database.windows.net:1433/factory?driver=ODBC+Driver+18+for+SQL+Server"
   ```

7. Run the migrations for the first time:

   ```bash
   cd api && uv run alembic upgrade head
   ```

8. Smoke-test the leader, transition, and intent paths against Azure SQL:

   ```bash
   FACTORY_DB_URL="mssql+pyodbc://..." uv run pytest tests/test_leader.py tests/test_transitions.py tests/test_intents.py -v
   ```

   The leader tests against real Azure SQL exercise `sp_getapplock` for real.

## Free-tier alternative

Azure SQL's serverless free offer exists, but auto-pause fights the factory's
tick loop: pausing kills database connections, while repeated wake-ups consume
the free quota. Basic is therefore the chosen default for the dev database.

## CI note

The `test-mssql` GitHub job covers the MSSQL dialect on every push. Step 8 adds
proof that `sp_getapplock` works through the real Azure gateway.
