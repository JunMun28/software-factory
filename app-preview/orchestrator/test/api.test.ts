import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DashboardBlueprint } from '../src/blueprints/types.js';
import { createApp } from '../src/http/app.js';
import { createOrchestratorDeps } from '../src/factory.js';
import { git, gitHasChanges } from '../src/git.js';
import { ShellGateRunner } from '../src/gate-runner.js';
import { PreviewManager } from '../src/preview-manager.js';
import {
  FakeHarness,
  setGateFail,
  writeIgnoredFile,
  writeTrackedFile,
  deleteTrackedFile,
} from './fake-harness.js';
import {
  FakePortAllocator,
  FakeProcessSpawner,
  FakeReadinessProber,
} from './fake-preview-deps.js';
import {
  createChat,
  getChat,
  getPreviewStatus,
  getWorkspaceFileContent,
  getWorkspaceFileDiff,
  getWorkspaceFiles,
  parseChatEvents,
  postPreview,
  postTurn,
  startTestServer,
  startTurnWithoutWaiting,
  waitForPreviewStatus,
  type TestServer,
} from './helpers.js';

const fixtureTemplate = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/template',
);

describe('Orchestrator HTTP API', () => {
  let workspacesRoot = '';
  let server: TestServer;
  let app: Hono;
  let fakeHarness: FakeHarness;
  const previewSpawner = new FakeProcessSpawner();
  const previewProber = new FakeReadinessProber(1);
  const previewPorts = new FakePortAllocator(46_000);

  beforeAll(async () => {
    workspacesRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-chats-'));

    fakeHarness = FakeHarness.fromScripts([]);

    const { chatStore, previewManager } = await createOrchestratorDeps({
      config: {
        templatePath: fixtureTemplate,
        workspacesRoot,
        trustedRoot: path.join(workspacesRoot, 'trusted'),
        platformDbPath: path.join(workspacesRoot, 'platform.db'),
        gateTimeoutMs: 30_000,
        port: 0,
      },
      harness: fakeHarness,
      gateRunner: new ShellGateRunner({
        timeoutMs: 30_000,
        sourceGatePath: path.join(fixtureTemplate, 'gate.sh'),
        trustedGatePath: path.join(workspacesRoot, 'trusted', 'gate.sh'),
      }),
      previewManager: new PreviewManager({
        workspacesRoot,
        previewRoot: path.join(workspacesRoot, 'preview'),
        spawner: previewSpawner,
        prober: previewProber,
        portAllocator: previewPorts,
        readinessPollMs: 10,
        readinessTimeoutMs: 5_000,
      }),
    });

    app = createApp({ chatStore, previewManager });
    server = await startTestServer((port) =>
      serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }),
    );
  });

  afterAll(async () => {
    await server.close();
    await rm(workspacesRoot, { recursive: true, force: true });
  });

  it('creates a chat with baseline workspace and idle status', async () => {
    fakeHarness.withDefaultScripts([]);

    const { status, chatId } = await createChat(server.baseUrl);
    expect(status).toBe(201);

    const workspaceDir = path.join(workspacesRoot, chatId);
    const { stdout: log } = await git(workspaceDir, ['log', '--oneline']);
    expect(log).toContain('Baseline: Golden Template');

    const chat = await getChat(server.baseUrl, chatId);
    expect(chat.status).toBe(200);
    expect(chat.body).toMatchObject({
      chatId,
      status: 'idle',
      versions: [],
    });
  });

  it('lists real harness models and forwards a selected model to the turn', async () => {
    fakeHarness.withDefaultScripts([]);
    const modelsResponse = await fetch(`${server.baseUrl}/models`);
    expect(modelsResponse.status).toBe(200);
    expect(await modelsResponse.json()).toEqual({
      models: [
        { id: 'openai/gpt-5.4', provider: 'openai', name: 'gpt-5.4' },
        { id: 'google/gemini-2.5-pro', provider: 'google', name: 'gemini-2.5-pro' },
      ],
    });

    const { chatId } = await createChat(server.baseUrl);
    const turn = await postTurn(
      server.baseUrl,
      chatId,
      'Use the selected model',
      'openai/gpt-5.4',
    );

    expect(turn.status).toBe(200);
    expect(fakeHarness.receivedModels.at(-1)).toBe('openai/gpt-5.4');
  });

  it('rejects a model that is not in the live catalog', async () => {
    fakeHarness.withDefaultScripts([]);
    const { chatId } = await createChat(server.baseUrl);

    const turn = await postTurn(
      server.baseUrl,
      chatId,
      'Do not start this turn',
      'unknown/not-real',
    );

    expect(turn.status).toBe(400);
    expect(fakeHarness.receivedModels).not.toContain('unknown/not-real');
  });

  it('exposes read-only SQLite workspace data for the database tool', async () => {
    fakeHarness.withDefaultScripts([]);
    const { chatId } = await createChat(server.baseUrl);
    const db = new DatabaseSync(path.join(workspacesRoot, chatId, 'backend', 'app.db'));
    db.exec('CREATE TABLE metric (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    db.prepare('INSERT INTO metric (label) VALUES (?)').run('Revenue');
    db.close();

    const response = await fetch(`${server.baseUrl}/chats/${chatId}/database`);
    const body = (await response.json()) as {
      connected: boolean;
      tables: Array<{ name: string; rows: Array<Record<string, unknown>> }>;
    };

    expect(response.status).toBe(200);
    expect(body.connected).toBe(true);
    expect(body.tables[0]).toMatchObject({
      name: 'metric',
      rows: [{ id: 1, label: 'Revenue' }],
    });
  });

  it('green turn with file changes commits once and ignores gitignored files', async () => {
    fakeHarness.withDefaultScripts([
      {
        events: [{ type: 'narration', text: 'Updating hello.txt' }],
        mutate: async (workspaceDir) => {
          await writeTrackedFile(workspaceDir, 'hello.txt', 'changed\n');
          await writeIgnoredFile(workspaceDir, 'app.db', 'sqlite-bytes');
        },
      },
    ]);

    const { chatId } = await createChat(server.baseUrl);
    const { events } = await postTurn(
      server.baseUrl,
      chatId,
      'Make hello greener',
    );

    const types = events.map((event) => event.type);
    expect(types).toContain('turn-started');
    expect(types).toContain('narration');
    expect(types.filter((t) => t === 'gate-status')).toEqual([
      'gate-status',
      'gate-status',
    ]);
    expect(events.some((e) => e.type === 'gate-status' && e.status === 'green')).toBe(
      true,
    );
    expect(types).toContain('version-created');
    expect(types.at(-1)).toBe('turn-finished');
    expect(events.at(-1)).toMatchObject({ type: 'turn-finished', result: 'green' });

    const workspaceDir = path.join(workspacesRoot, chatId);
    const { stdout: log } = await git(workspaceDir, ['log', '--oneline']);
    const commits = log.trim().split('\n').filter(Boolean);
    expect(commits).toHaveLength(2);

    const { stdout: show } = await git(workspaceDir, [
      'show',
      '--name-only',
      '--pretty=format:',
      'HEAD',
    ]);
    expect(show).toContain('hello.txt');
    expect(show).not.toContain('app.db');

    const chat = await getChat(server.baseUrl, chatId);
    expect(chat.body.versions).toHaveLength(1);
  });

  it('exposes per-version diffstat and changed files computed at version-cut time', async () => {
    fakeHarness.withDefaultScripts([
      {
        events: [{ type: 'narration', text: 'Editing files' }],
        mutate: async (workspaceDir) => {
          // hello.txt exists in the baseline; modify it and add a new file.
          await writeTrackedFile(workspaceDir, 'hello.txt', 'line one\nline two\n');
          await writeTrackedFile(workspaceDir, 'created.txt', 'brand new\n');
        },
      },
    ]);

    const { chatId } = await createChat(server.baseUrl);
    await postTurn(server.baseUrl, chatId, 'Change some files');

    const response = await fetch(`${server.baseUrl}/chats/${chatId}/versions`);
    expect(response.status).toBe(200);
    const versions = (await response.json()) as Array<{
      seq: number;
      diffStat: { additions: number; deletions: number } | null;
      files: Array<{ path: string; status: string }> | null;
    }>;

    expect(versions).toHaveLength(1);
    const [version] = versions;
    expect(version?.diffStat).not.toBeNull();
    expect(version?.diffStat?.additions).toBeGreaterThan(0);
    expect(version?.files).toEqual(
      expect.arrayContaining([
        { path: 'created.txt', status: 'added' },
        expect.objectContaining({ path: 'hello.txt', status: 'modified' }),
      ]),
    );
  });

  it('red turn leaves workspace dirty then follow-up green commits accumulated changes', async () => {
    fakeHarness.withDefaultScripts([
      {
        events: [{ type: 'narration', text: 'First attempt' }],
        mutate: async (workspaceDir) => {
          await setGateFail(workspaceDir, true);
          await writeTrackedFile(workspaceDir, 'turn-a.txt', 'from turn A\n');
        },
      },
      {
        events: [{ type: 'narration', text: 'Second attempt' }],
        mutate: async (workspaceDir) => {
          await setGateFail(workspaceDir, false);
          await writeTrackedFile(workspaceDir, 'turn-b.txt', 'from turn B\n');
        },
      },
    ]);

    const { chatId } = await createChat(server.baseUrl);
    const workspaceDir = path.join(workspacesRoot, chatId);

    const red = await postTurn(server.baseUrl, chatId, 'Fail the gate');
    expect(red.events.some((e) => e.type === 'gate-status' && e.status === 'red')).toBe(
      true,
    );
    expect(red.events.at(-1)).toMatchObject({
      type: 'turn-finished',
      result: 'red',
    });
    expect(red.events.some((e) => e.type === 'version-created')).toBe(false);

    const { stdout: logAfterRed } = await git(workspaceDir, ['log', '--oneline']);
    expect(logAfterRed.trim().split('\n')).toHaveLength(1);
    expect(await gitHasChanges(workspaceDir)).toBe(true);

    const green = await postTurn(server.baseUrl, chatId, 'Fix and pass gate');
    expect(green.events.at(-1)).toMatchObject({
      type: 'turn-finished',
      result: 'green',
    });

    const { stdout: logAfterGreen } = await git(workspaceDir, ['log', '--oneline']);
    expect(logAfterGreen.trim().split('\n')).toHaveLength(2);

    const { stdout: show } = await git(workspaceDir, [
      'show',
      '--name-only',
      '--pretty=format:',
      'HEAD',
    ]);
    expect(show).toContain('turn-a.txt');
    expect(show).toContain('turn-b.txt');
  });

  it('green turn with no file changes finishes as no-change without commit', async () => {
    fakeHarness.withDefaultScripts([
      {
        events: [{ type: 'narration', text: 'Nothing to do' }],
      },
    ]);

    const { chatId } = await createChat(server.baseUrl);
    const { events } = await postTurn(
      server.baseUrl,
      chatId,
      'No-op turn please',
    );

    expect(events.at(-1)).toMatchObject({
      type: 'turn-finished',
      result: 'no-change',
    });
    expect(events.some((e) => e.type === 'version-created')).toBe(false);

    const workspaceDir = path.join(workspacesRoot, chatId);
    const { stdout: log } = await git(workspaceDir, ['log', '--oneline']);
    expect(log.trim().split('\n')).toHaveLength(1);
  });

  it('mid-turn harness failure returns red and allows follow-up turn', async () => {
    fakeHarness.withDefaultScripts([
      {
        events: [{ type: 'narration', text: 'About to fail' }],
        throwError: 'harness exploded',
      },
      {
        events: [{ type: 'narration', text: 'Recovered' }],
        mutate: async (workspaceDir) => {
          await writeTrackedFile(workspaceDir, 'recovery.txt', 'ok\n');
        },
      },
    ]);

    const { chatId } = await createChat(server.baseUrl);

    const failed = await postTurn(server.baseUrl, chatId, 'Trigger harness error');
    expect(failed.events.at(-1)).toMatchObject({
      type: 'turn-finished',
      result: 'red',
    });

    const health = await getChat(server.baseUrl, chatId);
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('idle');

    const followUp = await postTurn(server.baseUrl, chatId, 'Try again');
    expect(followUp.events.at(-1)).toMatchObject({
      type: 'turn-finished',
      result: 'green',
    });
  });

  it('isolates workspaces and histories across two chats', async () => {
    fakeHarness.withDefaultScripts([
      {
        events: [{ type: 'narration', text: 'Chat-specific edit' }],
        mutate: async (workspaceDir) => {
          await writeTrackedFile(
            workspaceDir,
            'isolated.txt',
            `${path.basename(path.dirname(workspaceDir))}\n`,
          );
        },
      },
    ]);

    const chatA = await createChat(server.baseUrl);
    const chatB = await createChat(server.baseUrl);

    await postTurn(server.baseUrl, chatA.chatId, 'Edit in A');

    const dirA = path.join(workspacesRoot, chatA.chatId);
    const dirB = path.join(workspacesRoot, chatB.chatId);

    const { stdout: logA } = await git(dirA, ['log', '--oneline']);
    const { stdout: logB } = await git(dirB, ['log', '--oneline']);

    expect(logA.trim().split('\n')).toHaveLength(2);
    expect(logB.trim().split('\n')).toHaveLength(1);
    expect(await gitHasChanges(dirB)).toBe(false);
  });

  it('returns 409 for concurrent turns and 404 for unknown chat', async () => {
    fakeHarness.withDefaultScripts([
      {
        events: [{ type: 'narration', text: 'Slow turn' }],
        delayMs: 500,
      },
    ]);

    const { chatId } = await createChat(server.baseUrl);

    const first = startTurnWithoutWaiting(
      server.baseUrl,
      chatId,
      'Slow prompt',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const concurrent = await postTurn(server.baseUrl, chatId, 'Should conflict');
    expect(concurrent.status).toBe(409);

    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    await parseSseFromResponse(firstResponse);

    const missing = await postTurn(server.baseUrl, 'missing-chat-id', 'Nope');
    expect(missing.status).toBe(404);
  });

  it('preview endpoints return status, accept ensure requests, and stream preview-status SSE', async () => {
    fakeHarness.withDefaultScripts([]);

    const { chatId } = await createChat(server.baseUrl);

    const initial = await getPreviewStatus(server.baseUrl, chatId);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ status: 'stopped' });

    const eventsPromise = parseChatEvents(server.baseUrl, chatId, async () => {
      const started = await postPreview(server.baseUrl, chatId);
      expect(started.status).toBe(202);
      expect(started.body.status).toBe('starting');
    });

    const ready = await waitForPreviewStatus(server.baseUrl, chatId, 'ready', 5_000);
    expect(ready.body).toMatchObject({
      status: 'ready',
      url: 'http://localhost:46002',
    });

    const events = await eventsPromise;
    const previewEvents = events.filter((event) => event.event === 'preview-status');
    expect(previewEvents.length).toBeGreaterThanOrEqual(2);
    expect(
      previewEvents.some((event) => {
        const data = JSON.parse(event.data) as { status: string };
        return data.status === 'starting';
      }),
    ).toBe(true);
    expect(
      previewEvents.some((event) => {
        const data = JSON.parse(event.data) as { status: string; url?: string };
        return data.status === 'ready' && data.url === 'http://localhost:46002';
      }),
    ).toBe(true);

    const missing = await getPreviewStatus(server.baseUrl, 'missing-chat');
    expect(missing.status).toBe(404);
  });

  it('files endpoint reports created, modified, deleted, and unchanged statuses', async () => {
    fakeHarness.withDefaultScripts([]);

    const { chatId } = await createChat(server.baseUrl);
    const workspaceDir = path.join(workspacesRoot, chatId);
    await writeTrackedFile(workspaceDir, 'hello.txt', 'modified\n');
    await writeTrackedFile(workspaceDir, 'created.txt', 'new file\n');
    await deleteTrackedFile(workspaceDir, 'frontend/package.json');

    const tree = await getWorkspaceFiles(server.baseUrl, chatId);
    expect(tree.status).toBe(200);

    const byPath = new Map(
      (tree.body.files ?? []).map((entry) => [entry.path, entry.status]),
    );
    expect(byPath.get('hello.txt')).toBe('modified');
    expect(byPath.get('created.txt')).toBe('created');
    expect(byPath.get('frontend/package.json')).toBe('deleted');
    expect(byPath.get('gate.sh')).toBe('unchanged');
  });

  it('files endpoint excludes gitignored paths', async () => {
    fakeHarness.withDefaultScripts([]);

    const { chatId } = await createChat(server.baseUrl);
    const workspaceDir = path.join(workspacesRoot, chatId);
    await writeIgnoredFile(workspaceDir, 'app.db', 'sqlite');
    await writeIgnoredFile(
      workspaceDir,
      'node_modules/ignored-lib/index.js',
      'ignored\n',
    );
    await writeTrackedFile(workspaceDir, 'visible.txt', 'ok\n');

    const tree = await getWorkspaceFiles(server.baseUrl, chatId);
    expect(tree.status).toBe(200);

    const paths = (tree.body.files ?? []).map((entry) => entry.path);
    expect(paths).toContain('visible.txt');
    expect(paths).not.toContain('app.db');
    expect(paths.some((entry) => entry.includes('node_modules'))).toBe(false);
  });

  it('files content endpoint returns content and rejects traversal', async () => {
    fakeHarness.withDefaultScripts([]);

    const { chatId } = await createChat(server.baseUrl);
    const workspaceDir = path.join(workspacesRoot, chatId);
    await writeTrackedFile(workspaceDir, 'hello.txt', 'line one\n');

    const content = await getWorkspaceFileContent(server.baseUrl, chatId, 'hello.txt');
    expect(content.status).toBe(200);
    expect(content.body.content).toBe('line one\n');

    const traversal = await getWorkspaceFileContent(
      server.baseUrl,
      chatId,
      '../../../etc/passwd',
    );
    expect(traversal.status).toBe(404);

    const missing = await getWorkspaceFiles(server.baseUrl, 'missing-chat');
    expect(missing.status).toBe(404);
  });

  it('files diff endpoint returns unified diff for modified and untracked files', async () => {
    fakeHarness.withDefaultScripts([]);

    const { chatId } = await createChat(server.baseUrl);
    const workspaceDir = path.join(workspacesRoot, chatId);
    await writeTrackedFile(workspaceDir, 'hello.txt', 'changed line\n');
    await writeTrackedFile(workspaceDir, 'new-file.txt', 'brand new\n');

    const modified = await getWorkspaceFileDiff(server.baseUrl, chatId, 'hello.txt');
    expect(modified.status).toBe(200);
    expect(modified.body.diff).toContain('-Hello from fixture template');
    expect(modified.body.diff).toContain('+changed line');

    const created = await getWorkspaceFileDiff(server.baseUrl, chatId, 'new-file.txt');
    expect(created.status).toBe(200);
    expect(created.body.diff).toContain('+++ b/new-file.txt');
    expect(created.body.diff).toContain('+brand new');

    const unchanged = await getWorkspaceFileDiff(server.baseUrl, chatId, 'gate.sh');
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.diff).toBe('');
  });

  it('rejects invalid blueprint updates with field errors', async () => {
    fakeHarness.withDefaultScripts([]);
    const { chatId } = await createChat(server.baseUrl);

    const response = await app.request(`/chats/${chatId}/blueprints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1 }),
    });
    expect(response.status).toBe(422);

    const body = (await response.json()) as { errors: Array<{ path: string; message: string }> };
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('stores, lists, and approves blueprint revisions', async () => {
    fakeHarness.withDefaultScripts([]);
    const { chatId } = await createChat(server.baseUrl);

    const created = await app.request(`/chats/${chatId}/blueprints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBlueprint()),
    });
    expect(created.status).toBe(201);
    const firstRevision = (await created.json()) as { id: string; revision: number; approved: boolean };
    expect(firstRevision).toMatchObject({ revision: 1, approved: false });

    const second = await app.request(`/chats/${chatId}/blueprints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(changedBlueprint()),
    });
    expect(second.status).toBe(201);
    const secondRevision = (await second.json()) as { id: string; revision: number };
    expect(secondRevision.revision).toBe(2);

    const approve = await app.request(
      `/chats/${chatId}/blueprints/${secondRevision.id}/approve`,
      { method: 'POST' },
    );
    expect(approve.status).toBe(200);
    expect((await approve.json()) as { approved: boolean }).toMatchObject({
      approved: true,
    });

    const list = await app.request(`/chats/${chatId}/blueprints`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      revisions: Array<{ id: string; revision: number; approved: boolean }>;
    };
    expect(listed.revisions).toMatchObject([
      { id: firstRevision.id, revision: 1, approved: false },
      { id: secondRevision.id, revision: 2, approved: true },
    ]);
  });

  it('returns 404 for blueprint routes on an unknown chat or revision', async () => {
    fakeHarness.withDefaultScripts([]);
    const { chatId } = await createChat(server.baseUrl);

    expect((await app.request('/chats/missing-chat/blueprints')).status).toBe(404);

    const post = await app.request('/chats/missing-chat/blueprints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBlueprint()),
    });
    expect(post.status).toBe(404);

    const approveMissingChat = await app.request(
      '/chats/missing-chat/blueprints/whatever/approve',
      { method: 'POST' },
    );
    expect(approveMissingChat.status).toBe(404);

    const approveMissingRevision = await app.request(
      `/chats/${chatId}/blueprints/missing-revision/approve`,
      { method: 'POST' },
    );
    expect(approveMissingRevision.status).toBe(404);
  });
});

async function parseSseFromResponse(response: Response) {
  const text = await response.text();
  return text;
}

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
