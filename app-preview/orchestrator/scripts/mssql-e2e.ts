/**
 * End-to-end proof: drive the real PlatformDb against Azure SQL.
 *
 * The driver probe checks primitives and the migrate check checks DDL. This one
 * exercises the actual application methods — chats, generations, turn events,
 * versions, blueprints, connections — through the same code paths the
 * orchestrator uses, then removes everything it made.
 *
 * Deliberate, networked, billable — not part of `npm test`.
 *   npx tsx scripts/mssql-e2e.ts
 */
import { PlatformDb } from '../src/platform-db.js';
import { createDriver, type SqlDriver } from '../src/sql-driver.js';

const TARGET = process.env.APPVIEW_DB_URL;
if (!TARGET) {
  console.error(
    'Set APPVIEW_DB_URL first, e.g. mssql://<server>.database.windows.net/<database>',
  );
  process.exit(1);
}

// generations.plan_id references plans, so generations drops BEFORE plans.
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

const ok = (label: string, pass: boolean, extra = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!pass) process.exitCode = 1;
};

const teardown = async (driver: SqlDriver) => {
  for (const t of TABLES) {
    await driver.exec(`IF OBJECT_ID('${t}') IS NOT NULL DROP TABLE ${t}`);
  }
};

let db: PlatformDb | undefined;
let cleaner: SqlDriver | undefined;
try {
  // Start from a clean schema so this is a true fresh-install run.
  cleaner = await createDriver(TARGET);
  await teardown(cleaner);
  await cleaner.close();
  cleaner = undefined;

  db = await PlatformDb.open(TARGET);
  ok('open + migrate + seed', db.dialect === 'mssql', `dialect=${db.dialect}`);

  const projects = await db.listProjects('founder');
  ok(
    'seed created the default project',
    projects.some((p) => p.id === 'local-workspace'),
    projects.map((p) => p.id).join(','),
  );

  const chatId = 'e2e-chat';
  await db.insertChat(chatId, 'ws-ref-1', db.defaultProjectId, undefined);
  ok('insertChat', (await db.listChats()).some((c) => c.id === chatId));

  // Title is set once and never overwritten by a later prompt.
  await db.setChatTitleIfEmpty(chatId, 'first title');
  await db.setChatTitleIfEmpty(chatId, 'second title');
  ok('setChatTitleIfEmpty is write-once', (await db.getChatTitle(chatId)) === 'first title');

  ok('updateChatTitle reports a hit', (await db.updateChatTitle(chatId, 'renamed')) === true);
  ok('updateChatTitle reports a miss', (await db.updateChatTitle('ghost', 'x')) === false);

  const gen = await db.beginGeneration(chatId, 'make it blue');
  ok('beginGeneration', typeof gen === 'string' && gen.length > 0);

  const running = await db.getRunningGeneration(chatId);
  ok('getRunningGeneration (TOP 1 path)', running?.id === gen, running?.id ?? 'none');

  // Narration events append to the generation's narration column — this is the
  // `||` vs `+` concatenation split between the two dialects.
  await db.appendTurnEvent(gen, { type: 'narration', text: 'hello ' } as never);
  await db.appendTurnEvent(gen, { type: 'narration', text: 'world' } as never);
  const events = await db.listTurnEvents(gen);
  ok('appendTurnEvent sequencing', events.length === 2 && events[0].seq < events[1].seq,
     events.map((e) => e.seq).join(','));

  const turns = await db.listTurns(chatId);
  ok('narration concatenated', turns[0]?.narration === 'hello world',
     JSON.stringify(turns[0]?.narration));

  await db.finishGeneration(gen, 'green');
  ok('finishGeneration', (await db.getGeneration(gen))?.result === 'green');

  const version = await db.insertVersion(chatId, gen, 'sha-abc', 'first version', null,
    { filesChanged: 2, insertions: 10, deletions: 1 } as never,
    [{ path: 'a.ts', status: 'modified' }] as never);
  ok('insertVersion', version.seq === 1);
  ok('countVersions', (await db.countVersions(chatId)) === 1);

  const fetched = await db.getVersion(chatId, version.id);
  ok('version JSON round-trip', fetched?.diffStat !== null && fetched?.files !== null,
     JSON.stringify(fetched?.diffStat));

  const rev = await db.insertBlueprintRevision(chatId, { title: 'bp' } as never);
  const approved = await db.approveBlueprintRevision(chatId, rev.id);
  ok('approveBlueprintRevision', approved?.approved === true);

  await db.createConnection(chatId, 'warehouse', 'mssql', { host: 'h' }, { pw: 's' });
  const conns = await db.listConnections(chatId);
  ok('createConnection', conns.length === 1 && conns[0].name === 'warehouse');
  ok(
    'listConnections omits the secret',
    !Object.prototype.hasOwnProperty.call(conns[0], 'secret'),
  );
  const withSecret = await db.getConnectionWithSecret(chatId, 'warehouse');
  ok('getConnectionWithSecret returns it', withSecret?.secret?.pw === 's');

  // Duplicate names must be rejected, and the failure must roll back cleanly.
  let rejected = false;
  try {
    await db.createConnection(chatId, 'warehouse', 'rest', {}, {});
  } catch {
    rejected = true;
  }
  ok('duplicate connection rejected', rejected);
  ok('rollback left one connection', (await db.listConnections(chatId)).length === 1);

  ok('deleteChat cascades', (await db.deleteChat(chatId)) === true);
  ok('chat is gone', (await db.listChats()).every((c) => c.id !== chatId));
  ok('versions are gone', (await db.countVersions(chatId)) === 0);

  await db.close();
  db = undefined;

  cleaner = await createDriver(TARGET);
  await teardown(cleaner);
  const left = await cleaner.all<{ name: string }>(
    `SELECT name FROM sys.tables WHERE name IN (${TABLES.map((t) => `'${t}'`).join(',')})`,
  );
  ok('cleaned up', left.length === 0, `${left.length} left`);
} catch (error) {
  console.log('FAIL  threw:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await db?.close().catch(() => {});
  await cleaner?.close().catch(() => {});
}
