import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatStore } from '../src/chat-store.js';
import { git, gitHasChanges } from '../src/git.js';
import { PlatformDb } from '../src/platform-db.js';
import { FakeHarness } from './fake-harness.js';
import type { DashboardBlueprint } from '../src/blueprints/types.js';
import {
  BASELINE_COMMIT_MESSAGE,
  type GateRunner,
  type WorkspaceProvider,
} from '../src/types.js';

const greenGate: GateRunner = {
  run: async () => ({ green: true, output: 'GATE GREEN' }),
};

function memoryDb(): Promise<PlatformDb> {
  return PlatformDb.open(':memory:');
}

describe('PlatformDb', () => {
  it('migrates and seeds a founder user with a default project once', async () => {
    const db = await memoryDb();
    expect(db.defaultProjectId).toBeTruthy();
    await db.close();
  });

  it('re-opening the same file is idempotent (migrations + seed)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-db-'));
    const dbPath = path.join(dir, 'platform.db');
    const first = await PlatformDb.open(dbPath);
    const projectId = first.defaultProjectId;
    await first.insertChat('chat-1', '/tmp/nowhere');
    await first.close();

    const second = await PlatformDb.open(dbPath);
    expect(second.defaultProjectId).toBe(projectId);
    expect((await second.listChats()).map((row) => row.id)).toEqual(['chat-1']);
    await second.close();
  });

  it('enables WAL journaling for file-backed databases', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-wal-db-'));
    const dbPath = path.join(dir, 'platform.db');
    const db = await PlatformDb.open(dbPath);
    await db.close();

    const raw = new DatabaseSync(dbPath);
    try {
      const row = raw.prepare('PRAGMA journal_mode').get() as
        | { journal_mode: string }
        | undefined;
      expect(row?.journal_mode).toBe('wal');
    } finally {
      raw.close();
    }
  });

  it('adds narration when upgrading a database that already applied 0001', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-legacy-db-'));
    const dbPath = path.join(dir, 'platform.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(
      'CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    legacy.exec(
      await readFile(path.resolve('migrations/sqlite/0001-init.sql'), 'utf8'),
    );
    legacy
      .prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)')
      .run('0001-init.sql', new Date().toISOString());
    legacy.close();

    const upgraded = await PlatformDb.open(dbPath);
    await upgraded.insertChat('chat-1', '/tmp/ws');
    const generationId = await upgraded.beginGeneration('chat-1', 'legacy prompt');
    await upgraded.appendTurnEvent(generationId, {
      type: 'narration',
      text: 'Persisted after upgrade',
    });
    await upgraded.finishGeneration(generationId, 'no-change');

    expect((await upgraded.listTurns('chat-1'))[0]?.narration).toBe(
      'Persisted after upgrade',
    );
    await upgraded.close();
  });

  it('records generations and versions with monotonically increasing numbering', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws');
    const gen1 = await db.beginGeneration('chat-1', 'build it');
    await db.insertVersion('chat-1', gen1, 'sha-1', 'build it');
    await db.finishGeneration(gen1, 'green');
    const gen2 = await db.beginGeneration('chat-1', 'again');
    await db.insertVersion('chat-1', gen2, 'sha-2', 'again');
    await db.finishGeneration(gen2, 'green');
    expect(await db.countVersions('chat-1')).toBe(2);
    await db.close();
  });

  it('persists and returns version diffstat and changed files, null for legacy rows', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws');
    const gen1 = await db.beginGeneration('chat-1', 'build it');
    const withStat = await db.insertVersion(
      'chat-1',
      gen1,
      'sha-1',
      'build it',
      null,
      { additions: 12, deletions: 3 },
      [
        { path: 'src/app.ts', status: 'modified' },
        { path: 'src/new.ts', status: 'added' },
      ],
    );
    expect(withStat.diffStat).toEqual({ additions: 12, deletions: 3 });
    expect(withStat.files).toEqual([
      { path: 'src/app.ts', status: 'modified' },
      { path: 'src/new.ts', status: 'added' },
    ]);

    const gen2 = await db.beginGeneration('chat-1', 'legacy');
    const legacy = await db.insertVersion('chat-1', gen2, 'sha-2', 'legacy');
    expect(legacy.diffStat).toBeNull();
    expect(legacy.files).toBeNull();

    const [first, second] = await db.listVersions('chat-1');
    expect(first?.diffStat).toEqual({ additions: 12, deletions: 3 });
    expect(first?.files).toHaveLength(2);
    expect(second?.diffStat).toBeNull();
    expect(second?.files).toBeNull();

    expect((await db.getVersion('chat-1', first!.id))?.diffStat).toEqual({
      additions: 12,
      deletions: 3,
    });
    await db.close();
  });

  it('persists assistant narration in turn history', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws');
    const generationId = await db.beginGeneration('chat-1', 'explain it');

    await db.appendTurnEvent(generationId, {
      type: 'narration',
      text: 'First paragraph.',
    });
    await db.appendTurnEvent(generationId, {
      type: 'narration',
      text: '\n\nSecond paragraph.',
    });
    await db.finishGeneration(generationId, 'no-change');

    expect(await db.listTurns('chat-1')).toEqual([
      expect.objectContaining({
        prompt: 'explain it',
        narration: 'First paragraph.\n\nSecond paragraph.',
        result: 'no-change',
      }),
    ]);
    await db.close();
  });

  it('allocates monotonic event sequences independently per generation', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws');
    const firstGeneration = await db.beginGeneration('chat-1', 'first');
    const secondGeneration = await db.beginGeneration('chat-1', 'second');

    const first = await db.appendTurnEvent(firstGeneration, {
      type: 'turn-started',
      chatId: 'chat-1',
      turnId: 'turn-1',
    });
    const second = await db.appendTurnEvent(firstGeneration, {
      type: 'narration',
      text: 'Working',
    });
    const otherGeneration = await db.appendTurnEvent(secondGeneration, {
      type: 'turn-started',
      chatId: 'chat-1',
      turnId: 'turn-2',
    });

    expect([first.seq, second.seq, otherGeneration.seq]).toEqual([1, 2, 1]);
    expect(await db.listTurnEvents(firstGeneration)).toEqual([
      expect.objectContaining({
        seq: 1,
        event: expect.objectContaining({ type: 'turn-started' }),
      }),
      expect.objectContaining({
        seq: 2,
        event: { type: 'narration', text: 'Working' },
      }),
    ]);
    expect(await db.listTurnEvents(firstGeneration, 1)).toEqual([
      expect.objectContaining({
        seq: 2,
        event: { type: 'narration', text: 'Working' },
      }),
    ]);
    await db.close();
  });

  it('rolls back a failed version cut so a later cut can allocate its sequence', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws');
    const gen1 = await db.beginGeneration('chat-1', 'first');
    await db.insertVersion('chat-1', gen1, 'sha-1', 'first');

    await expect(
      db.insertVersion('chat-1', gen1, 'duplicate-sha', 'duplicate'),
    ).rejects.toThrow();

    const gen2 = await db.beginGeneration('chat-1', 'second');
    await expect(
      db.insertVersion('chat-1', gen2, 'sha-2', 'second'),
    ).resolves.not.toThrow();
    expect(await db.countVersions('chat-1')).toBe(2);
    await db.close();
  });
});

describe('PlatformDb blueprint revisions', () => {
  it('keeps immutable blueprint revisions and one approved revision', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws');
    const chatId = 'chat-1';

    const first = await db.insertBlueprintRevision(chatId, validBlueprint());
    const second = await db.insertBlueprintRevision(chatId, changedBlueprint());
    await db.approveBlueprintRevision(chatId, second.id);
    expect(await db.listBlueprintRevisions(chatId)).toMatchObject([
      { id: first.id, revision: 1, approved: false },
      { id: second.id, revision: 2, approved: true },
    ]);
    await db.close();
  });

  it('moves the single approval when a different revision is approved', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws');
    const first = await db.insertBlueprintRevision('chat-1', validBlueprint());
    const second = await db.insertBlueprintRevision('chat-1', changedBlueprint());

    await db.approveBlueprintRevision('chat-1', first.id);
    await db.approveBlueprintRevision('chat-1', second.id);

    const revisions = await db.listBlueprintRevisions('chat-1');
    expect(revisions.filter((row) => row.approved)).toEqual([
      expect.objectContaining({ id: second.id }),
    ]);
    await db.close();
  });

  it('persists the stored blueprint payload immutably per revision', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws');
    const first = await db.insertBlueprintRevision('chat-1', validBlueprint());
    await db.insertBlueprintRevision('chat-1', changedBlueprint());

    const stored = await db.getBlueprintRevision('chat-1', first.id);
    expect(stored?.blueprint.title).toBe('Revenue dashboard');
    expect(await db.getBlueprintRevision('chat-1', 'missing')).toBeNull();
    await db.close();
  });

  it('returns null when approving an unknown revision', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws');
    await db.insertBlueprintRevision('chat-1', validBlueprint());
    expect(await db.approveBlueprintRevision('chat-1', 'missing')).toBeNull();
    await db.close();
  });

  it('removes blueprint revisions when the chat is deleted', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws');
    await db.insertBlueprintRevision('chat-1', validBlueprint());
    expect(await db.deleteChat('chat-1')).toBe(true);
    expect(await db.listBlueprintRevisions('chat-1')).toEqual([]);
    await db.close();
  });
});

describe('ChatStore restart survival (issue 0025)', () => {
  let workspacesRoot = '';
  let dbPath = '';

  beforeAll(async () => {
    workspacesRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-rehydrate-'));
    dbPath = path.join(workspacesRoot, 'platform.db');
  });

  afterAll(() => {
    // temp dir cleanup is left to the OS
  });

  function makeProvider(): WorkspaceProvider {
    return {
      create: async (chatId: string) => {
        const dir = path.join(workspacesRoot, chatId);
        await mkdir(dir, { recursive: true });
        return dir;
      },
    };
  }

  it('a chat created before a restart is usable after it', async () => {
    const db1 = await PlatformDb.open(dbPath);
    const store1 = new ChatStore(
      makeProvider(),
      FakeHarness.fromScripts([]),
      greenGate,
      db1,
    );
    const chatId = await store1.createChat();
    expect(store1.hasChat(chatId)).toBe(true);
    await db1.close();

    // "Restart": a fresh store over the same database file.
    const db2 = await PlatformDb.open(dbPath);
    const store2 = new ChatStore(
      makeProvider(),
      FakeHarness.fromScripts([]),
      greenGate,
      db2,
    );
    expect(store2.hasChat(chatId)).toBe(false);
    const restored = await store2.rehydrate();
    expect(restored).toBeGreaterThanOrEqual(1);
    expect(store2.hasChat(chatId)).toBe(true);
    expect(store2.getWorkspaceDir(chatId)).toBe(path.join(workspacesRoot, chatId));
    await db2.close();
  });

  it('serves database versions oldest first without reading the git workspace', async () => {
    const chatId = 'database-version-chat';
    const workspaceDir = await makeProvider().create(chatId);
    const db = await memoryDb();
    await db.insertChat(chatId, workspaceDir);
    await db.insertVersion(chatId, null, 'persisted-sha-1', 'First persisted version');
    await db.insertVersion(chatId, null, 'persisted-sha-2', 'Second persisted version');
    const store = new ChatStore(
      makeProvider(),
      FakeHarness.fromScripts([]),
      greenGate,
      db,
    );
    await store.rehydrate();

    const chat = await store.getChat(chatId);

    expect(chat?.versions).toEqual([
      { commit: 'persisted-sha-1', message: 'First persisted version' },
      { commit: 'persisted-sha-2', message: 'Second persisted version' },
    ]);
    await db.close();
  });

  it('rehydrate backfills database versions from legacy git history', async () => {
    const chatId = 'legacy-version-chat';
    const workspaceDir = await makeProvider().create(chatId);
    await git(workspaceDir, ['init']);
    await git(workspaceDir, ['config', 'user.email', 'test@example.com']);
    await git(workspaceDir, ['config', 'user.name', 'Test User']);
    await writeFile(path.join(workspaceDir, 'tracked.txt'), 'baseline\n', 'utf8');
    await git(workspaceDir, ['add', 'tracked.txt']);
    await git(workspaceDir, ['commit', '-m', BASELINE_COMMIT_MESSAGE]);
    await writeFile(path.join(workspaceDir, 'tracked.txt'), 'legacy change\n', 'utf8');
    await git(workspaceDir, ['commit', '-am', 'Legacy version']);
    const { stdout } = await git(workspaceDir, ['rev-parse', 'HEAD']);
    const legacyCommit = stdout.trim();

    const db = await memoryDb();
    await db.insertChat(chatId, workspaceDir);
    const store = new ChatStore(
      makeProvider(),
      FakeHarness.fromScripts([]),
      greenGate,
      db,
    );
    expect(await db.listVersions(chatId)).toEqual([]);

    await store.rehydrate();

    expect(await db.listVersions(chatId)).toEqual([
      expect.objectContaining({
        generationId: null,
        seq: 1,
        manifestRef: legacyCommit,
        message: 'Legacy version',
        diffStat: null,
        files: null,
      }),
    ]);
    await db.close();
  });

  it('rehydrate skips chats whose workspace directory is gone', async () => {
    const db = await PlatformDb.open(dbPath);
    await db.insertChat('ghost-chat', path.join(workspacesRoot, 'does-not-exist'));
    const store = new ChatStore(
      makeProvider(),
      FakeHarness.fromScripts([]),
      greenGate,
      db,
    );
    await store.rehydrate();
    expect(store.hasChat('ghost-chat')).toBe(false);
    await db.close();
  });

  it('rehydrate marks a dangling running generation as error', async () => {
    const chatId = 'interrupted-chat';
    const workspaceDir = await makeProvider().create(chatId);
    const db = await PlatformDb.open(dbPath);
    await db.insertChat(chatId, workspaceDir);
    await db.beginGeneration(chatId, 'interrupted prompt');
    const store = new ChatStore(
      makeProvider(),
      FakeHarness.fromScripts([]),
      greenGate,
      db,
    );

    await store.rehydrate();

    expect(await db.listTurns(chatId)).toEqual([
      expect.objectContaining({
        prompt: 'interrupted prompt',
        result: 'error',
        finished_at: expect.any(String),
      }),
    ]);
    await db.close();
  });

  it('rehydrate resets tracked and untracked edits in an idle workspace', async () => {
    const chatId = 'dirty-chat';
    const workspaceDir = await makeProvider().create(chatId);
    await git(workspaceDir, ['init']);
    await git(workspaceDir, ['config', 'user.email', 'test@example.com']);
    await git(workspaceDir, ['config', 'user.name', 'Test User']);
    await writeFile(path.join(workspaceDir, 'tracked.txt'), 'baseline\n', 'utf8');
    await git(workspaceDir, ['add', 'tracked.txt']);
    await git(workspaceDir, ['commit', '-m', 'baseline']);

    const db = await PlatformDb.open(dbPath);
    await db.insertChat(chatId, workspaceDir);
    await writeFile(path.join(workspaceDir, 'tracked.txt'), 'partial edit\n', 'utf8');
    await writeFile(path.join(workspaceDir, 'untracked.txt'), 'partial file\n', 'utf8');
    expect(await gitHasChanges(workspaceDir)).toBe(true);

    const store = new ChatStore(
      makeProvider(),
      FakeHarness.fromScripts([]),
      greenGate,
      db,
    );
    await store.rehydrate();

    expect(await gitHasChanges(workspaceDir)).toBe(false);
    expect(await readFile(path.join(workspaceDir, 'tracked.txt'), 'utf8')).toBe(
      'baseline\n',
    );
    await expect(access(path.join(workspaceDir, 'untracked.txt'))).rejects.toThrow();
    await db.close();
  });
});

function validBlueprint(): DashboardBlueprint {
  return {
    version: 1,
    title: 'Revenue dashboard',
    goal: 'Track revenue over time',
    users: ['analyst'],
    pages: [{ id: 'overview', title: 'Overview', path: '/' }],
    entities: [
      {
        name: 'order',
        fields: [
          { name: 'total', type: 'number' },
          { name: 'created', type: 'date' },
        ],
      },
    ],
    metrics: [
      {
        id: 'revenue',
        label: 'Revenue',
        formula: 'sum(order.total)',
        format: 'currency',
        expected: 1000,
      },
    ],
    charts: [
      {
        id: 'revenue-by-day',
        title: 'Revenue by day',
        kind: 'line',
        measure: 'revenue',
        dimension: 'order.created',
      },
    ],
    filters: [
      { id: 'date', label: 'Date', field: 'order.created', control: 'date-range' },
    ],
    states: ['loading', 'empty'],
    seed: {
      id: 'seed-1',
      scenarios: [{ name: 'baseline', description: 'A typical month' }],
    },
    journeys: [
      {
        id: 'view-overview',
        title: 'View the overview',
        viewport: { width: 1280, height: 800 },
        actions: [{ kind: 'goto', path: '/' }],
        assertions: [{ kind: 'text', testId: 'revenue', value: '$1,000' }],
      },
    ],
  };
}

function changedBlueprint(): DashboardBlueprint {
  return {
    ...validBlueprint(),
    title: 'Revenue dashboard v2',
    goal: 'Track revenue and refunds over time',
  };
}
