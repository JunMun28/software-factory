/**
 * Prove the T-SQL migrations actually run on Azure SQL, then remove what they made.
 *
 * Deliberate, networked, billable — not part of `npm test`.
 *   npx tsx scripts/mssql-migrate-check.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDriver, type SqlDriver } from '../src/sql-driver.js';

const TARGET = process.env.APPVIEW_DB_URL;
if (!TARGET) {
  console.error(
    'Set APPVIEW_DB_URL first, e.g. mssql://<server>.database.windows.net/<database>',
  );
  process.exit(1);
}
const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations/mssql',
);

// Child-before-parent so foreign keys do not block the teardown.
// generations.plan_id references plans, so generations must go BEFORE plans —
// getting this backwards leaves the whole set undropped.
const TABLES = [
  'appview_migrations',
  'connections',
  'blueprint_revisions',
  'turn_events',
  'versions',
  'generations',
  'plans',
  'chats',
  'projects',
  'users',
];

const drop = async (driver: SqlDriver) => {
  for (const t of TABLES) {
    await driver.exec(`IF OBJECT_ID('${t}') IS NOT NULL DROP TABLE ${t}`);
  }
};

let driver: SqlDriver | undefined;
try {
  driver = await createDriver(TARGET);
  console.log('connected, dialect =', driver.dialect);

  // This check DROPS every appview table. Refuse when the database holds real
  // chats — an orchestrator that has been used in anger — unless forced.
  const hasChats = await driver.get<{ n: number }>(
    "SELECT CASE WHEN OBJECT_ID('chats') IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM chats) END AS n",
  );
  if ((hasChats?.n ?? 0) > 0 && !process.argv.includes('--force')) {
    console.error(
      `REFUSING: ${hasChats?.n} chat(s) exist in this database and this check drops every table.\n` +
        'Point APPVIEW_DB_URL at a scratch database, or re-run with --force to destroy the data.',
    );
    process.exit(1);
  }

  // Start from clean so this is a true fresh-database run.
  await drop(driver);

  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), 'utf8');
    try {
      await driver.exec(sql);
      console.log(`PASS  ${file}`);
    } catch (error) {
      console.log(`FAIL  ${file}:`, error instanceof Error ? error.message : error);
      process.exitCode = 1;
      break;
    }
  }

  if (!process.exitCode) {
    // Re-running the whole set must be safe — the IF OBJECT_ID guards exist for
    // exactly this, and a second run is what a restarted migrator does.
    for (const file of files) {
      const sql = readFileSync(path.join(dir, file), 'utf8');
      try {
        await driver.exec(sql);
      } catch (error) {
        console.log(
          `FAIL  ${file} is not re-runnable:`,
          error instanceof Error ? error.message : error,
        );
        process.exitCode = 1;
        break;
      }
    }
    if (!process.exitCode) console.log('PASS  all migrations are re-runnable');
  }

  const created = await driver.all<{ name: string }>(
    `SELECT name FROM sys.tables WHERE name IN (${TABLES.map((t) => `'${t}'`).join(',')}) ORDER BY name`,
  );
  console.log('tables created:', created.map((r) => r.name).join(', ') || '(none)');

  await drop(driver);
  const left = await driver.all<{ name: string }>(
    `SELECT name FROM sys.tables WHERE name IN (${TABLES.map((t) => `'${t}'`).join(',')})`,
  );
  console.log(left.length === 0 ? 'PASS  cleaned up' : `FAIL  left behind: ${left.length}`);
  if (left.length) process.exitCode = 1;
} catch (error) {
  console.log('FAIL  threw:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await driver?.close().catch(() => {});
}
