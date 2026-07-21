/**
 * Live check of MssqlDriver against a real Azure SQL database.
 *
 * Not part of `npm test` — it needs network, credentials and costs money.
 * Run deliberately:  npx tsx scripts/mssql-probe.ts
 */
import { createDriver, type SqlDriver } from '../src/sql-driver.js';

const TARGET = process.env.APPVIEW_DB_URL;
if (!TARGET) {
  console.error(
    'Set APPVIEW_DB_URL first, e.g. mssql://<server>.database.windows.net/<database>',
  );
  process.exit(1);
}
const TABLE = 'appview_probe_tmp';

const ok = (label: string, pass: boolean, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!pass) process.exitCode = 1;
};

let driver: SqlDriver | undefined;
try {
  driver = await createDriver(TARGET);
  ok('connect', driver.dialect === 'mssql', `dialect=${driver.dialect}`);

  await driver.exec(`IF OBJECT_ID('${TABLE}') IS NOT NULL DROP TABLE ${TABLE}`);
  await driver.exec(
    `CREATE TABLE ${TABLE} (id NVARCHAR(450) PRIMARY KEY, n INT, note NVARCHAR(MAX))`,
  );
  ok('create table', true);

  // `?` placeholders must survive translation to @p0/@p1/@p2.
  await driver.run(`INSERT INTO ${TABLE} (id, n, note) VALUES (?, ?, ?)`, [
    'a',
    1,
    'plain',
  ]);
  await driver.run(`INSERT INTO ${TABLE} (id, n, note) VALUES (?, ?, ?)`, [
    'b',
    2,
    null,
  ]);
  const row = await driver.get<{ n: number; note: string | null }>(
    `SELECT n, note FROM ${TABLE} WHERE id = ?`,
    ['a'],
  );
  ok('placeholder round-trip', row?.n === 1 && row?.note === 'plain', JSON.stringify(row));

  const nullRow = await driver.get<{ note: string | null }>(
    `SELECT note FROM ${TABLE} WHERE id = ?`,
    ['b'],
  );
  ok('null binds as NULL', nullRow?.note === null);

  const all = await driver.all<{ id: string }>(`SELECT id FROM ${TABLE} ORDER BY id`);
  ok('all() ordering', all.map((r) => r.id).join(',') === 'a,b', all.map((r) => r.id).join(','));

  // A `?` inside a literal is data, not a placeholder.
  const lit = await driver.get<{ q: string }>(
    `SELECT 'what?' AS q, ? AS bound`,
    ['x'],
  );
  ok('literal question mark preserved', lit?.q === 'what?', JSON.stringify(lit));

  const upd = await driver.run(`UPDATE ${TABLE} SET n = ? WHERE id = ?`, [9, 'a']);
  const miss = await driver.run(`UPDATE ${TABLE} SET n = ? WHERE id = ?`, [9, 'ghost']);
  ok('rowsAffected', upd.changes === 1 && miss.changes === 0, `${upd.changes}/${miss.changes}`);

  await driver
    .withTransaction(async () => {
      await driver!.run(`INSERT INTO ${TABLE} (id, n) VALUES (?, ?)`, ['tx', 3]);
      throw new Error('rollback-probe');
    })
    .catch(() => {});
  const gone = await driver.get(`SELECT id FROM ${TABLE} WHERE id = ?`, ['tx']);
  ok('rollback discards', gone === undefined);

  await driver.withTransaction(async () => {
    await driver!.run(`INSERT INTO ${TABLE} (id, n) VALUES (?, ?)`, ['tx2', 4]);
  });
  const kept = await driver.get(`SELECT id FROM ${TABLE} WHERE id = ?`, ['tx2']);
  ok('commit persists', kept !== undefined);

  await driver.exec(`DROP TABLE ${TABLE}`);
  ok('cleanup', true);
} catch (error) {
  console.log('FAIL  threw:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await driver?.close().catch(() => {});
}
