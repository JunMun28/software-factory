import { serve } from '@hono/node-server';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { ConnectionTester } from '../src/connection-tester.js';
import { createOrchestratorDeps } from '../src/factory.js';
import { ShellGateRunner } from '../src/gate-runner.js';
import { createApp } from '../src/http/app.js';
import type { PlatformDb } from '../src/platform-db.js';
import {
  PreviewManager,
  type ProcessSpawner,
} from '../src/preview-manager.js';
import { FakeHarness } from './fake-harness.js';
import {
  FakePortAllocator,
  FakeProcessSpawner,
  FakeReadinessProber,
} from './fake-preview-deps.js';
import {
  createChat,
  startTestServer,
  type TestServer,
} from './helpers.js';

const fixtureTemplate = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/template',
);

const mssqlPassword = 'Sup3rS3cret!';
const mssqlUrl =
  'mssql+pymssql://sa:Sup3rS3cret!@dbhost:1433/sales';

interface SpawnRecord {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface ConnectionResponse {
  id: string;
  chatId: string;
  name: string;
  kind: string;
  config: Record<string, string>;
  createdAt: string;
}

interface ValidationResponse {
  errors: Array<{ path: string; message: string }>;
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emitExit(code: number): void {
    this.emit('exit', code);
    this.emit('close', code);
  }
}

class FakeConnectionSpawner implements ProcessSpawner {
  readonly spawns: SpawnRecord[] = [];
  private nextRun: ((child: FakeChildProcess) => void) | undefined;

  script(run: (child: FakeChildProcess) => void): void {
    this.nextRun = run;
  }

  reset(): void {
    this.nextRun = undefined;
  }

  spawn(
    command: string,
    args: string[],
    options: {
      cwd: string;
      shell?: boolean;
      detached?: boolean;
      env?: NodeJS.ProcessEnv;
    },
  ): ChildProcess {
    const run = this.nextRun;
    this.nextRun = undefined;
    if (!run) {
      throw new Error('No fake connection process was scripted');
    }

    this.spawns.push({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
    });
    const child = new FakeChildProcess();
    setImmediate(() => run(child));
    return child as unknown as ChildProcess;
  }
}

describe('Connections HTTP API', () => {
  let workspacesRoot = '';
  let server: TestServer;
  let previewManager: PreviewManager;
  let platformDb: PlatformDb;
  const connectionSpawner = new FakeConnectionSpawner();

  beforeAll(async () => {
    workspacesRoot = await mkdtemp(
      path.join(os.tmpdir(), 'ng-v0-connections-api-'),
    );
    const configuredPreviewManager = new PreviewManager({
      workspacesRoot,
      previewRoot: path.join(workspacesRoot, 'preview'),
      spawner: new FakeProcessSpawner(),
      prober: new FakeReadinessProber(1),
      portAllocator: new FakePortAllocator(49_000),
    });
    const deps = await createOrchestratorDeps({
      config: {
        templatePath: fixtureTemplate,
        workspacesRoot,
        trustedRoot: path.join(workspacesRoot, 'trusted'),
        platformDbPath: path.join(workspacesRoot, 'platform.db'),
        gateTimeoutMs: 30_000,
        port: 0,
      },
      harness: FakeHarness.fromScripts([]),
      gateRunner: new ShellGateRunner({
        timeoutMs: 30_000,
        sourceGatePath: path.join(fixtureTemplate, 'gate.sh'),
        trustedGatePath: path.join(workspacesRoot, 'trusted', 'gate.sh'),
      }),
      previewManager: configuredPreviewManager,
      connectionTester: new ConnectionTester({
        spawner: connectionSpawner,
      }),
    });

    previewManager = deps.previewManager;
    platformDb = deps.platformDb;
    const app = createApp({
      chatStore: deps.chatStore,
      previewManager,
    });
    server = await startTestServer((port) =>
      serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }),
    );
  });

  beforeEach(() => {
    connectionSpawner.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await server.close();
    previewManager.dispose();
    await platformDb.close();
    await rm(workspacesRoot, { recursive: true, force: true });
  });

  it('creates and lists a redacted MSSQL connection', async () => {
    const { chatId } = await createChat(server.baseUrl);

    const created = await postConnection(
      server.baseUrl,
      chatId,
      mssqlConnection(),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as ConnectionResponse;
    expect(createdBody).toMatchObject({
      chatId,
      name: 'SalesDb',
      kind: 'mssql',
      config: {
        host: 'dbhost',
        port: '1433',
        database: 'sales',
        user: 'sa',
      },
    });
    expect(JSON.stringify(createdBody)).not.toContain(mssqlPassword);

    const listed = await fetch(
      `${server.baseUrl}/chats/${chatId}/connections`,
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      connections: ConnectionResponse[];
    };
    expect(listedBody.connections).toHaveLength(1);
    expect(listedBody.connections[0]).toMatchObject({
      id: createdBody.id,
      chatId,
      name: 'SalesDb',
      kind: 'mssql',
      config: createdBody.config,
    });
    expect(JSON.stringify(listedBody)).not.toContain(mssqlPassword);
  });

  it('restarts a running preview after creating a connection but leaves a stopped preview alone', async () => {
    const { chatId: runningChatId } = await createChat(server.baseUrl);
    const { chatId: stoppedChatId } = await createChat(server.baseUrl);
    vi.spyOn(previewManager, 'status').mockImplementation((chatId) => ({
      status: chatId === runningChatId ? 'ready' : 'stopped',
    }));
    const restart = vi
      .spyOn(previewManager, 'restart')
      .mockResolvedValue(undefined);

    const runningResponse = await postConnection(
      server.baseUrl,
      runningChatId,
      mssqlConnection(),
    );
    const stoppedResponse = await postConnection(
      server.baseUrl,
      stoppedChatId,
      mssqlConnection(),
    );

    expect(runningResponse.status).toBe(201);
    expect(stoppedResponse.status).toBe(201);
    expect(restart).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledWith(runningChatId);
  });

  it('returns 400 for an invalid JSON request body', async () => {
    const { chatId } = await createChat(server.baseUrl);

    const response = await fetch(
      `${server.baseUrl}/chats/${chatId}/connections`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('returns field errors for invalid connection inputs', async () => {
    const { chatId } = await createChat(server.baseUrl);
    const invalidCases: Array<{
      body: unknown;
      error: { path: string; message: string };
    }> = [
      {
        body: {
          name: 'MissingPassword',
          kind: 'mssql',
          host: 'dbhost',
          database: 'sales',
          user: 'sa',
        },
        error: { path: 'password', message: 'password is required' },
      },
      {
        body: { ...mssqlConnection(), name: 'my-api' },
        error: {
          path: 'name',
          message:
            'Connection name "my-api" contains invalid characters; use only letters, numbers, and underscores',
        },
      },
      {
        body: { name: 'UnknownKind', kind: 'postgres' },
        error: {
          path: 'kind',
          message:
            'Connection kind must be one of mssql, snowflake, or rest',
        },
      },
      {
        body: {
          name: 'ReportingApi',
          kind: 'rest',
          base_url: 'https://reports.example.test',
          auth_value: 'Bearer secret-token',
        },
        error: {
          path: 'auth_header',
          message: 'auth_header is required when auth_value is provided',
        },
      },
    ];

    for (const invalidCase of invalidCases) {
      const response = await postConnection(
        server.baseUrl,
        chatId,
        invalidCase.body,
      );
      expect(response.status).toBe(422);
      const body = (await response.json()) as ValidationResponse;
      expect(body.errors).toEqual(expect.arrayContaining([invalidCase.error]));
    }
  });

  it('rejects exact and case-insensitive duplicate names', async () => {
    const { chatId } = await createChat(server.baseUrl);

    expect(
      (await postConnection(
        server.baseUrl,
        chatId,
        mssqlConnection('Warehouse'),
      )).status,
    ).toBe(201);
    const exactDuplicate = await postConnection(
      server.baseUrl,
      chatId,
      mssqlConnection('Warehouse'),
    );
    expect(exactDuplicate.status).toBe(422);
    expect((await exactDuplicate.json()) as ValidationResponse).toMatchObject({
      errors: [
        {
          path: 'name',
          message: 'Connection name "Warehouse" already exists',
        },
      ],
    });

    expect(
      (await postConnection(
        server.baseUrl,
        chatId,
        mssqlConnection('sales'),
      )).status,
    ).toBe(201);
    const caseInsensitiveDuplicate = await postConnection(
      server.baseUrl,
      chatId,
      mssqlConnection('SALES'),
    );
    expect(caseInsensitiveDuplicate.status).toBe(422);
    expect(
      (await caseInsensitiveDuplicate.json()) as ValidationResponse,
    ).toMatchObject({
      errors: [
        {
          path: 'name',
          message: 'Connection name "SALES" already exists',
        },
      ],
    });
  });

  it('deletes a connection and returns 404 for an unknown name', async () => {
    const { chatId } = await createChat(server.baseUrl);
    expect(
      (await postConnection(
        server.baseUrl,
        chatId,
        mssqlConnection(),
      )).status,
    ).toBe(201);
    expect(
      (await postConnection(server.baseUrl, chatId, restConnection())).status,
    ).toBe(201);

    const beforeDelete = await fetch(
      `${server.baseUrl}/chats/${chatId}/connections`,
    );
    expect(beforeDelete.status).toBe(200);
    expect(
      ((await beforeDelete.json()) as { connections: ConnectionResponse[] })
        .connections,
    ).toHaveLength(2);

    const deleted = await fetch(
      `${server.baseUrl}/chats/${chatId}/connections/SalesDb`,
      { method: 'DELETE' },
    );
    expect(deleted.status).toBe(204);

    const listed = await fetch(
      `${server.baseUrl}/chats/${chatId}/connections`,
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      connections: ConnectionResponse[];
    };
    expect(listedBody.connections.map((connection) => connection.name)).toEqual([
      'OtherApi',
    ]);

    const missing = await fetch(
      `${server.baseUrl}/chats/${chatId}/connections/Missing`,
      { method: 'DELETE' },
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Connection not found' });
  });

  it('restarts a running preview after deleting a connection but leaves a stopped preview alone', async () => {
    const { chatId: runningChatId } = await createChat(server.baseUrl);
    const { chatId: stoppedChatId } = await createChat(server.baseUrl);
    expect(
      (await postConnection(
        server.baseUrl,
        runningChatId,
        mssqlConnection(),
      )).status,
    ).toBe(201);
    expect(
      (await postConnection(
        server.baseUrl,
        stoppedChatId,
        mssqlConnection(),
      )).status,
    ).toBe(201);
    vi.spyOn(previewManager, 'status').mockImplementation((chatId) => ({
      status: chatId === runningChatId ? 'ready' : 'stopped',
    }));
    const restart = vi
      .spyOn(previewManager, 'restart')
      .mockResolvedValue(undefined);

    const runningResponse = await fetch(
      `${server.baseUrl}/chats/${runningChatId}/connections/SalesDb`,
      { method: 'DELETE' },
    );
    const stoppedResponse = await fetch(
      `${server.baseUrl}/chats/${stoppedChatId}/connections/SalesDb`,
      { method: 'DELETE' },
    );

    expect(runningResponse.status).toBe(204);
    expect(stoppedResponse.status).toBe(204);
    expect(restart).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledWith(runningChatId);
  });

  it('returns 404 from every connection route for an unknown chat', async () => {
    const requests = [
      fetch(`${server.baseUrl}/chats/missing-chat/connections`),
      postConnection(server.baseUrl, 'missing-chat', mssqlConnection()),
      fetch(
        `${server.baseUrl}/chats/missing-chat/connections/SalesDb`,
        { method: 'DELETE' },
      ),
      fetch(
        `${server.baseUrl}/chats/missing-chat/connections/SalesDb/test`,
        { method: 'POST' },
      ),
    ];

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Chat not found' });
    }
  });

  it('tests only the selected connection from the backend workspace', async () => {
    const { chatId } = await createChat(server.baseUrl);
    expect(
      (await postConnection(
        server.baseUrl,
        chatId,
        mssqlConnection(),
      )).status,
    ).toBe(201);
    expect(
      (await postConnection(server.baseUrl, chatId, restConnection())).status,
    ).toBe(201);

    connectionSpawner.script((child) => {
      child.stdout.write('{"ok": true, "latencyMs": 42}\n');
      child.emitExit(0);
    });
    const spawnIndex = connectionSpawner.spawns.length;
    const response = await fetch(
      `${server.baseUrl}/chats/${chatId}/connections/SalesDb/test`,
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, latencyMs: 42 });
    expect(connectionSpawner.spawns).toHaveLength(spawnIndex + 1);
    const spawn = connectionSpawner.spawns[spawnIndex];
    expect(spawn).toMatchObject({
      command: 'uv',
      args: ['run', 'python', '-m', 'app.datasources_test', 'SALESDB'],
    });
    expect(spawn?.cwd.endsWith('/backend')).toBe(true);

    const datasourceEnv = Object.fromEntries(
      Object.entries(spawn?.env ?? {}).filter(([key]) =>
        key.startsWith('DATASOURCE_'),
      ),
    );
    expect(datasourceEnv).toEqual({
      DATASOURCE_SALESDB_KIND: 'mssql',
      DATASOURCE_SALESDB_URL: mssqlUrl,
      DATASOURCE_NAMES: 'SALESDB',
    });
    expect(
      Object.keys(datasourceEnv).some((key) => key.includes('OTHERAPI')),
    ).toBe(false);
  });

  it('passes the sanitized name to the tester for a lowercase stored name', async () => {
    const { chatId } = await createChat(server.baseUrl);
    expect(
      (await postConnection(server.baseUrl, chatId, {
        name: 'orders_api',
        kind: 'rest',
        base_url: 'https://orders.example.test',
      })).status,
    ).toBe(201);

    connectionSpawner.script((child) => {
      child.stdout.write('{"ok": true, "latencyMs": 7}\n');
      child.emitExit(0);
    });
    const spawnIndex = connectionSpawner.spawns.length;
    const response = await fetch(
      `${server.baseUrl}/chats/${chatId}/connections/orders_api/test`,
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, latencyMs: 7 });
    const spawn = connectionSpawner.spawns[spawnIndex];
    // Regression: the argv must match the env contract's sanitized name —
    // the raw stored name `orders_api` has no DATASOURCE_orders_api_* vars.
    expect(spawn?.args).toEqual([
      'run',
      'python',
      '-m',
      'app.datasources_test',
      'ORDERS_API',
    ]);
    expect(spawn?.env).toMatchObject({
      DATASOURCE_ORDERS_API_KIND: 'rest',
      DATASOURCE_NAMES: 'ORDERS_API',
    });
  });

  it('redacts the password and full URL from connection test errors', async () => {
    const { chatId } = await createChat(server.baseUrl);
    expect(
      (await postConnection(
        server.baseUrl,
        chatId,
        mssqlConnection(),
      )).status,
    ).toBe(201);

    connectionSpawner.script((child) => {
      child.stderr.write(
        `OperationalError: connection to ${mssqlUrl} failed\n`,
      );
      child.emitExit(1);
    });
    const response = await fetch(
      `${server.baseUrl}/chats/${chatId}/connections/SalesDb/test`,
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      latencyMs: number;
      error?: string;
    };
    expect(body).toMatchObject({
      ok: false,
      error: expect.stringContaining('OperationalError'),
    });
    expect(JSON.stringify(body)).not.toContain(mssqlPassword);
    expect(JSON.stringify(body)).not.toContain('mssql+pymssql://sa:');
  });

  it('returns 404 when testing an unknown connection name', async () => {
    const { chatId } = await createChat(server.baseUrl);

    const response = await fetch(
      `${server.baseUrl}/chats/${chatId}/connections/Missing/test`,
      { method: 'POST' },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Connection not found' });
  });
});

function mssqlConnection(name = 'SalesDb'): Record<string, string> {
  return {
    name,
    kind: 'mssql',
    host: 'dbhost',
    port: '1433',
    database: 'sales',
    user: 'sa',
    password: mssqlPassword,
  };
}

function restConnection(): Record<string, string> {
  return {
    name: 'OtherApi',
    kind: 'rest',
    base_url: 'https://other.example.test',
  };
}

function postConnection(
  baseUrl: string,
  chatId: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}/chats/${chatId}/connections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
