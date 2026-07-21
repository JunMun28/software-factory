import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PreviewManager } from '../src/preview-manager.js';
import {
  FakePortAllocator,
  FakeProcessSpawner,
  FakeReadinessProber,
} from './fake-preview-deps.js';

describe('PreviewManager', () => {
  let workspacesRoot = '';
  let previewRoot = '';

  afterEach(async () => {
    if (workspacesRoot) {
      await rm(workspacesRoot, { recursive: true, force: true });
      workspacesRoot = '';
    }
    if (previewRoot) {
      await rm(previewRoot, { recursive: true, force: true });
      previewRoot = '';
    }
  });

  async function createWorkspace(chatId: string): Promise<string> {
    workspacesRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-preview-'));
    previewRoot = path.join(workspacesRoot, 'preview');
    const workspaceDir = path.join(workspacesRoot, chatId);
    await mkdir(path.join(workspaceDir, 'frontend', 'node_modules'), {
      recursive: true,
    });
    await mkdir(path.join(workspaceDir, 'backend', '.venv'), {
      recursive: true,
    });
    await writeFile(
      path.join(workspaceDir, 'frontend', 'package.json'),
      JSON.stringify({ name: 'frontend' }),
    );
    await writeFile(
      path.join(workspaceDir, 'backend', 'pyproject.toml'),
      '[project]\nname = "backend"\n',
    );
    return workspaceDir;
  }

  function createManager(options?: {
    spawner?: FakeProcessSpawner;
    prober?: FakeReadinessProber;
    readinessTimeoutMs?: number;
    connectionEnv?: (chatId: string) => Record<string, string>;
    bridgeProxy?: {
      starts: Array<{ targetUrl: string; port: number }>;
      start(input: { targetUrl: string; port: number }): Promise<{
        url: string;
        close(): Promise<void>;
      }>;
    };
  }) {
    const bridgeProxy =
      options?.bridgeProxy ??
      ({
        starts: [] as Array<{ targetUrl: string; port: number }>,
        async start(input: { targetUrl: string; port: number }) {
          this.starts.push(input);
          return { url: `http://localhost:${input.port}`, async close() {} };
        },
      } as const);
    return new PreviewManager({
      workspacesRoot,
      previewRoot,
      spawner: options?.spawner ?? new FakeProcessSpawner(),
      prober: options?.prober ?? new FakeReadinessProber(1),
      portAllocator: new FakePortAllocator(),
      readinessTimeoutMs: options?.readinessTimeoutMs ?? 5_000,
      readinessPollMs: 10,
      bridgeProxy,
      connectionEnv: options?.connectionEnv,
    } as never);
  }

  it('transitions starting to ready when frontend becomes reachable', async () => {
    const chatId = 'chat-ready';
    await createWorkspace(chatId);
    const spawner = new FakeProcessSpawner();
    const bridgeProxy = {
      starts: [] as Array<{ targetUrl: string; port: number }>,
      async start(input: { targetUrl: string; port: number }) {
        this.starts.push(input);
        return { url: `http://localhost:${input.port}`, async close() {} };
      },
    };
    const manager = createManager({
      spawner,
      prober: new FakeReadinessProber(1),
      bridgeProxy,
    });

    const seen: string[] = [];
    manager.subscribe(chatId, (status) => seen.push(status.status));

    await manager.ensure(chatId);

    expect(manager.status(chatId)).toMatchObject({
      status: 'ready',
      url: 'http://localhost:45002',
    });
    expect(bridgeProxy.starts).toEqual([
      { targetUrl: 'http://localhost:45001', port: 45002 },
    ]);
    expect(seen).toEqual(['stopped', 'starting', 'ready']);
    expect(spawner.spawns.some((s) => s.args.includes('uvicorn'))).toBe(true);
    expect(spawner.spawns.some((s) => s.command === 'npm' && s.args[0] === 'start')).toBe(
      true,
    );
  });

  it('passes only safe runtime variables to seed and preview processes', async () => {
    const chatId = 'chat-env';
    await createWorkspace(chatId);
    const previousPort = process.env.PORT;
    const previousNpmPort = process.env.npm_config_port;
    const previousSecret = process.env.FAKE_SECRET;
    process.env.PORT = '7071';
    process.env.npm_config_port = '7071';
    process.env.FAKE_SECRET = 'must-not-leak';
    try {
      const spawner = new FakeProcessSpawner();
      const bridgeProxy = {
        starts: [] as Array<{ targetUrl: string; port: number }>,
        async start(input: { targetUrl: string; port: number }) {
          this.starts.push(input);
          return { url: `http://localhost:${input.port}`, async close() {} };
        },
      };
      const manager = createManager({
        spawner,
        prober: new FakeReadinessProber(1),
        bridgeProxy,
      });

      await manager.ensure(chatId);

      const workspaceProcesses = spawner.spawns.filter(
        (spawned) =>
          spawned.args.includes('app.seed') ||
          spawned.args.includes('uvicorn') ||
          (spawned.command === 'npm' && spawned.args[0] === 'start'),
      );
      expect(workspaceProcesses).toHaveLength(3);
      for (const spawned of workspaceProcesses) {
        expect(spawned.env).toBeDefined();
        expect(spawned.env?.PORT).toBeUndefined();
        expect(spawned.env?.npm_config_port).toBeUndefined();
        expect(spawned.env?.FAKE_SECRET).toBeUndefined();
        expect(spawned.env?.PATH).toBe(process.env.PATH);
        expect(spawned.env?.HOME).toBe(process.env.HOME);
      }
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
      if (previousNpmPort === undefined) delete process.env.npm_config_port;
      else process.env.npm_config_port = previousNpmPort;
      if (previousSecret === undefined) delete process.env.FAKE_SECRET;
      else process.env.FAKE_SECRET = previousSecret;
    }
  });

  it('injects connection variables only into the backend preview process', async () => {
    const chatId = 'chat-connection-env';
    const workspaceDir = await createWorkspace(chatId);
    await rm(path.join(workspaceDir, 'frontend', 'node_modules'), {
      recursive: true,
      force: true,
    });
    await rm(path.join(workspaceDir, 'backend', '.venv'), {
      recursive: true,
      force: true,
    });
    const datasourceEnv = {
      DATASOURCE_SALES_KIND: 'rest',
      DATASOURCE_SALES_BASE_URL: 'https://x.test',
      DATASOURCE_NAMES: 'SALES',
    };
    const spawner = new FakeProcessSpawner();
    const manager = createManager({
      spawner,
      connectionEnv: () => datasourceEnv,
    });

    await manager.ensure(chatId);

    const backendSpawn = spawner.spawns.find((spawned) =>
      spawned.args.includes('uvicorn'),
    );
    expect(backendSpawn?.env).toMatchObject(datasourceEnv);

    const frontendSpawn = spawner.spawns.find(
      (spawned) => spawned.command === 'npm' && spawned.args[0] === 'start',
    );
    expect(frontendSpawn).toBeDefined();

    const commandSpawns = spawner.spawns.filter(
      (spawned) =>
        (spawned.command === 'npm' && spawned.args[0] === 'install') ||
        (spawned.command === 'uv' && spawned.args[0] === 'sync') ||
        spawned.args.includes('app.seed'),
    );
    expect(commandSpawns).toHaveLength(3);

    for (const spawned of [frontendSpawn, ...commandSpawns]) {
      expect(
        Object.keys(spawned?.env ?? {}).some((key) =>
          key.startsWith('DATASOURCE_'),
        ),
      ).toBe(false);
    }
  });

  it('marks failed when a child process exits during startup', async () => {
    const chatId = 'chat-failed';
    await createWorkspace(chatId);
    const spawner = new FakeProcessSpawner();
    const manager = createManager({
      spawner,
      prober: new FakeReadinessProber(0),
    });

    const ensurePromise = manager.ensure(chatId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    spawner.exitLongRunning(0, 1);
    await ensurePromise;

    expect(manager.status(chatId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('backend process exited'),
    });
  });

  it('restart stops a ready preview and starts it again', async () => {
    const chatId = 'chat-restart';
    await createWorkspace(chatId);
    const spawner = new FakeProcessSpawner();
    const manager = createManager({ spawner, prober: new FakeReadinessProber(1) });

    await manager.ensure(chatId);
    expect(manager.status(chatId).status).toBe('ready');

    const firstProcesses = [...spawner.longRunning];
    await manager.restart(chatId);

    expect(manager.status(chatId)).toMatchObject({
      status: 'ready',
      url: 'http://localhost:45005',
    });
    expect(firstProcesses.every((proc) => proc.killed)).toBe(true);
  });

  it('ensure is idempotent while preview is already ready', async () => {
    const chatId = 'chat-idempotent';
    await createWorkspace(chatId);
    const spawner = new FakeProcessSpawner();
    const manager = createManager({ spawner, prober: new FakeReadinessProber(1) });

    await manager.ensure(chatId);
    const firstUrl = manager.status(chatId).url;
    const spawnCount = spawner.spawns.length;

    await manager.ensure(chatId);

    expect(manager.status(chatId).url).toBe(firstUrl);
    expect(spawner.spawns.length).toBe(spawnCount);
  });
});
