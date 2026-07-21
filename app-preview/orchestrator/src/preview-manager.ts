import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import {
  createPreviewBridgeProxy,
  type PreviewBridgeHandle,
  type PreviewBridgeProxy,
} from './preview-bridge.js';
import { workspaceEnv } from './workspace-env.js';

export { workspaceEnv } from './workspace-env.js';

export type PreviewStatusValue = 'stopped' | 'starting' | 'ready' | 'failed';

export interface PreviewStatus {
  status: PreviewStatusValue;
  url?: string;
  error?: string;
}

export interface ProcessSpawner {
  spawn(
    command: string,
    args: string[],
    options: { cwd: string; shell?: boolean; detached?: boolean; env?: NodeJS.ProcessEnv },
  ): ChildProcess;
}

export interface ReadinessProber {
  probe(url: string): Promise<boolean>;
}

export interface PortAllocator {
  allocate(count: number): Promise<number[]>;
}

export interface PreviewManagerOptions {
  workspacesRoot: string;
  previewRoot: string;
  spawner?: ProcessSpawner;
  prober?: ReadinessProber;
  portAllocator?: PortAllocator;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  bridgeProxy?: PreviewBridgeProxy;
  connectionEnv?: (chatId: string) => Promise<Record<string, string>>;
}

type PreviewStatusListener = (status: PreviewStatus) => void;

interface PreviewRecord {
  status: PreviewStatusValue;
  url?: string;
  error?: string;
  backendPort?: number;
  frontendPort?: number;
  backendProcess?: ChildProcess;
  frontendProcess?: ChildProcess;
  bridgeHandle?: PreviewBridgeHandle;
  ensurePromise?: Promise<void>;
}

export class PreviewManager {
  private readonly records = new Map<string, PreviewRecord>();
  private readonly listeners = new Map<string, Set<PreviewStatusListener>>();
  private readonly spawner: ProcessSpawner;
  private readonly prober: ReadinessProber;
  private readonly portAllocator: PortAllocator;
  private readonly readinessTimeoutMs: number;
  private readonly readinessPollMs: number;
  private readonly bridgeProxy: PreviewBridgeProxy;
  private readonly connectionEnvProvider: (
    chatId: string,
  ) => Promise<Record<string, string>>;

  constructor(private readonly options: PreviewManagerOptions) {
    this.spawner = options.spawner ?? { spawn: nodeSpawn };
    this.prober = options.prober ?? createDefaultProber();
    this.portAllocator = options.portAllocator ?? createDefaultPortAllocator();
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 120_000;
    this.readinessPollMs = options.readinessPollMs ?? 500;
    this.bridgeProxy = options.bridgeProxy ?? createPreviewBridgeProxy();
    this.connectionEnvProvider =
      options.connectionEnv ?? (() => Promise.resolve({}));
  }

  status(chatId: string): PreviewStatus {
    const record = this.records.get(chatId);
    if (!record || record.status === 'stopped') {
      return { status: 'stopped' };
    }
    return {
      status: record.status,
      url: record.url,
      error: record.error,
    };
  }

  subscribe(chatId: string, listener: PreviewStatusListener): () => void {
    let set = this.listeners.get(chatId);
    if (!set) {
      set = new Set();
      this.listeners.set(chatId, set);
    }
    set.add(listener);
    listener(this.status(chatId));
    return () => {
      set?.delete(listener);
      if (set?.size === 0) {
        this.listeners.delete(chatId);
      }
    };
  }

  async ensure(chatId: string): Promise<void> {
    const record = this.getOrCreateRecord(chatId);

    if (record.status === 'ready' || record.status === 'starting') {
      if (record.ensurePromise) {
        await record.ensurePromise;
      }
      return;
    }

    record.ensurePromise = this.runEnsure(chatId, record);
    try {
      await record.ensurePromise;
    } finally {
      record.ensurePromise = undefined;
    }
  }

  async restart(chatId: string): Promise<void> {
    await this.stop(chatId);
    await this.ensure(chatId);
  }

  async stop(chatId: string): Promise<void> {
    const record = this.records.get(chatId);
    if (!record) {
      return;
    }
    this.killProcesses(record);
    this.setStatus(chatId, record, { status: 'stopped' });
  }

  async remove(chatId: string): Promise<void> {
    await this.stop(chatId);
    this.records.delete(chatId);
    this.listeners.delete(chatId);
  }

  dispose(): void {
    for (const chatId of this.records.keys()) {
      const record = this.records.get(chatId);
      if (record) {
        this.killProcesses(record);
      }
    }
    this.records.clear();
    this.listeners.clear();
  }

  private getOrCreateRecord(chatId: string): PreviewRecord {
    let record = this.records.get(chatId);
    if (!record) {
      record = { status: 'stopped' };
      this.records.set(chatId, record);
    }
    return record;
  }

  private async runEnsure(chatId: string, record: PreviewRecord): Promise<void> {
    this.setStatus(chatId, record, { status: 'starting' });

    try {
      const workspaceDir = path.join(this.options.workspacesRoot, chatId);
      const frontendDir = path.join(workspaceDir, 'frontend');
      const backendDir = path.join(workspaceDir, 'backend');

      await this.ensureDeps(frontendDir, backendDir);

      const [backendPort, frontendPort, bridgePort] = await this.portAllocator.allocate(3);
      record.backendPort = backendPort;
      record.frontendPort = frontendPort;

      const seedResult = await this.runCommand(
        'uv',
        ['run', 'python', '-m', 'app.seed'],
        backendDir,
      );
      if (seedResult.code !== 0) {
        throw new Error(seedResult.output || 'Seed failed');
      }

      const backendProcess = this.spawner.spawn(
        'uv',
        ['run', 'uvicorn', 'app.main:app', '--port', String(backendPort)],
        {
          cwd: backendDir,
          shell: true,
          detached: true,
          env: {
            ...workspaceEnv(),
            ...(await this.connectionEnvProvider(chatId)),
          },
        },
      );
      record.backendProcess = backendProcess;
      this.attachExitHandler(chatId, record, backendProcess, 'backend');

      await mkdir(this.options.previewRoot, { recursive: true });
      const proxyPath = path.join(this.options.previewRoot, `${chatId}.proxy.json`);
      await writeFile(
        proxyPath,
        JSON.stringify(
          {
            '/api': {
              target: `http://localhost:${backendPort}`,
              secure: false,
              changeOrigin: true,
            },
          },
          null,
          2,
        ),
      );

      const frontendProcess = this.spawner.spawn(
        'npm',
        ['start', '--', '--port', String(frontendPort), '--proxy-config', proxyPath],
        { cwd: frontendDir, shell: true, detached: true, env: workspaceEnv() },
      );
      record.frontendProcess = frontendProcess;
      this.attachExitHandler(chatId, record, frontendProcess, 'frontend');

      const frontendUrl = `http://localhost:${frontendPort}`;
      const ready = await this.waitForReady(record, frontendUrl);
      if (record.status === 'failed') {
        return;
      }
      if (!ready) {
        throw new Error('Preview readiness timeout');
      }

      if (bridgePort === undefined) {
        throw new Error('Preview bridge port was not allocated');
      }
      record.bridgeHandle = await this.bridgeProxy.start({
        targetUrl: frontendUrl,
        port: bridgePort,
      });
      this.setStatus(chatId, record, {
        status: 'ready',
        url: record.bridgeHandle.url,
      });
    } catch (error) {
      if (record.status === 'failed') {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.killProcesses(record);
      this.setStatus(chatId, record, { status: 'failed', error: message });
    }
  }

  private async ensureDeps(frontendDir: string, backendDir: string): Promise<void> {
    const frontendDeps = path.join(frontendDir, 'node_modules');
    if (!(await pathExists(frontendDeps))) {
      const result = await this.runCommand('npm', ['install'], frontendDir);
      if (result.code !== 0) {
        throw new Error(result.output || 'npm install failed');
      }
    }

    const backendDeps = path.join(backendDir, '.venv');
    if (!(await pathExists(backendDeps))) {
      const result = await this.runCommand('uv', ['sync'], backendDir);
      if (result.code !== 0) {
        throw new Error(result.output || 'uv sync failed');
      }
    }
  }

  private async runCommand(
    command: string,
    args: string[],
    cwd: string,
  ): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = this.spawner.spawn(command, args, { cwd, shell: true, env: workspaceEnv() });
      let output = '';
      const append = (chunk: Buffer | string) => {
        output += chunk.toString();
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      child.on('close', (code) => resolve({ code, output }));
      child.on('error', (err) => resolve({ code: 1, output: `${output}\n${err.message}`.trim() }));
    });
  }

  private attachExitHandler(
    chatId: string,
    record: PreviewRecord,
    process: ChildProcess,
    label: string,
  ): void {
    process.on('exit', (code) => {
      if (record.status !== 'starting' && record.status !== 'ready') {
        return;
      }
      const message = `${label} process exited with code ${code ?? 'unknown'}`;
      this.killProcesses(record);
      this.setStatus(chatId, record, { status: 'failed', error: message });
    });
  }

  private async waitForReady(record: PreviewRecord, url: string): Promise<boolean> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (record.status === 'failed') {
        return false;
      }
      if (await this.prober.probe(url)) {
        return true;
      }
      await sleep(this.readinessPollMs);
    }
    return false;
  }

  private killProcesses(record: PreviewRecord): void {
    for (const proc of [record.backendProcess, record.frontendProcess]) {
      if (!proc || proc.killed) {
        continue;
      }
      this.killProcessTree(proc);
    }
    record.backendProcess = undefined;
    record.frontendProcess = undefined;
    void record.bridgeHandle?.close();
    record.bridgeHandle = undefined;
    record.backendPort = undefined;
    record.frontendPort = undefined;
    record.url = undefined;
  }

  private killProcessTree(proc: ChildProcess): void {
    const pid = proc.pid;
    if (pid) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          proc.kill('SIGTERM');
        } catch {
          // Process may already be gone.
        }
      }
    } else {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may already be gone.
      }
    }
  }

  private setStatus(
    chatId: string,
    record: PreviewRecord,
    status: PreviewStatus,
  ): void {
    record.status = status.status;
    record.url = status.url;
    record.error = status.error;
    this.emit(chatId, status);
  }

  private emit(chatId: string, status: PreviewStatus): void {
    const set = this.listeners.get(chatId);
    if (!set) {
      return;
    }
    for (const listener of set) {
      listener(status);
    }
  }
}

function createDefaultPortAllocator(): PortAllocator {
  return {
    async allocate(count: number): Promise<number[]> {
      const ports: number[] = [];
      for (let i = 0; i < count; i += 1) {
        ports.push(await getFreePort());
      }
      return ports;
    },
  };
}

function createDefaultProber(): ReadinessProber {
  return {
    async probe(url: string): Promise<boolean> {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2_000);
        const response = await fetch(`${url}/`, { signal: controller.signal });
        clearTimeout(timer);
        return response.status === 200;
      } catch {
        return false;
      }
    },
  };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to acquire free port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
