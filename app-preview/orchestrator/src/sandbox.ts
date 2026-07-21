import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { workspaceEnv } from './workspace-env.js';

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

/**
 * A running sandbox: the dev server(s) that serve a chat's app, plus the URL the
 * preview bridge should target. The bridge proxy (overlay + HMR tunnel) lives in
 * PreviewManager and is deliberately NOT part of the sandbox concern.
 */
export interface SandboxHandle {
  /** URL the bridge proxy targets (today: the frontend `http://localhost:<port>`). */
  readonly targetUrl: string;
  /**
   * Host-routed (kube) only: the `Host` header that routes to this sandbox
   * through the orchestrator's main server (`<slug>.<previewDomain>`). The local
   * provider leaves this undefined — it uses a per-chat localhost bridge instead.
   */
  readonly previewHost?: string;
  /**
   * Host-routed (kube) only: the browser-facing preview URL
   * (`http://<slug>.<previewDomain>[:<port>]/`). When set, PreviewManager skips
   * the localhost bridge and reports this URL as the preview status URL. Local
   * leaves it undefined.
   */
  readonly externalPreviewUrl?: string;
  /**
   * Bring the sandbox in line with a new workspace git ref.
   *
   * For the local provider this is a NO-OP: the dev server already watches the
   * live workspace directory, so edits HMR automatically. It exists for the Kube
   * provider (Phase 1C) to trigger an in-pod `git fetch` + `reset --hard`.
   */
  resync(sha?: string): Promise<void>;
  /** Tear the sandbox down (today: kill the child processes). Idempotent. */
  stop(): Promise<void>;
}

export interface SandboxStartOptions {
  /**
   * Invoked when the sandbox dies unexpectedly while it should be live (a dev
   * server crash during or after startup). Lets the owner mark the preview
   * failed. Not called for an intentional {@link SandboxHandle.stop}.
   */
  onExit?: (error: Error) => void;
}

/**
 * Swappable "run the dev servers and give me a target URL" seam. The local
 * implementation spawns child processes; a Kube implementation (Phase 1) creates
 * a Deployment + Service per chat. PreviewManager owns the bridge proxy, records,
 * status and listeners, and delegates the sandbox lifecycle to a provider.
 */
export interface SandboxProvider {
  start(chatId: string, options?: SandboxStartOptions): Promise<SandboxHandle>;
}

export interface LocalProcessSandboxOptions {
  workspacesRoot: string;
  previewRoot: string;
  spawner?: ProcessSpawner;
  prober?: ReadinessProber;
  portAllocator?: PortAllocator;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  connectionEnv?: (chatId: string) => Promise<Record<string, string>>;
}

/** Per-`start` mutable state so a single provider instance can back many chats. */
interface SandboxProcessState {
  backendProcess?: ChildProcess;
  frontendProcess?: ChildProcess;
  phase: 'active' | 'stopped';
  exitError?: Error;
}

/**
 * The original local-process behaviour, extracted verbatim: ensureDeps
 * (npm install / uv sync), seed, spawn the backend (`uv run uvicorn`), write the
 * proxy.json, spawn the frontend (`npm start`) on allocated localhost ports, and
 * wait for readiness. Returns a handle targeting the frontend URL.
 */
export class LocalProcessSandbox implements SandboxProvider {
  private readonly workspacesRoot: string;
  private readonly previewRoot: string;
  private readonly spawner: ProcessSpawner;
  private readonly prober: ReadinessProber;
  private readonly portAllocator: PortAllocator;
  private readonly readinessTimeoutMs: number;
  private readonly readinessPollMs: number;
  private readonly connectionEnvProvider: (
    chatId: string,
  ) => Promise<Record<string, string>>;

  constructor(options: LocalProcessSandboxOptions) {
    this.workspacesRoot = options.workspacesRoot;
    this.previewRoot = options.previewRoot;
    this.spawner = options.spawner ?? { spawn: nodeSpawn };
    this.prober = options.prober ?? createDefaultProber();
    this.portAllocator = options.portAllocator ?? createDefaultPortAllocator();
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 120_000;
    this.readinessPollMs = options.readinessPollMs ?? 500;
    this.connectionEnvProvider =
      options.connectionEnv ?? (() => Promise.resolve({}));
  }

  async start(
    chatId: string,
    options: SandboxStartOptions = {},
  ): Promise<SandboxHandle> {
    const { onExit } = options;
    const state: SandboxProcessState = { phase: 'active' };

    try {
      const workspaceDir = path.join(this.workspacesRoot, chatId);
      const frontendDir = path.join(workspaceDir, 'frontend');
      const backendDir = path.join(workspaceDir, 'backend');

      await this.ensureDeps(frontendDir, backendDir);

      const [backendPort, frontendPort] = await this.portAllocator.allocate(2);

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
      state.backendProcess = backendProcess;
      this.attachExitHandler(state, backendProcess, 'backend', onExit);

      await mkdir(this.previewRoot, { recursive: true });
      const proxyPath = path.join(this.previewRoot, `${chatId}.proxy.json`);
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
      state.frontendProcess = frontendProcess;
      this.attachExitHandler(state, frontendProcess, 'frontend', onExit);

      const frontendUrl = `http://localhost:${frontendPort}`;
      const ready = await this.waitForReady(state, frontendUrl);
      if (!ready) {
        throw state.exitError ?? new Error('Preview readiness timeout');
      }

      return {
        targetUrl: frontendUrl,
        resync: async () => {
          // No-op: the local dev server watches the live workspace dir directly.
        },
        stop: async () => {
          state.phase = 'stopped';
          this.killProcesses(state);
        },
      } satisfies SandboxHandle;
    } catch (error) {
      state.phase = 'stopped';
      this.killProcesses(state);
      throw error;
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
    state: SandboxProcessState,
    proc: ChildProcess,
    label: string,
    onExit: SandboxStartOptions['onExit'],
  ): void {
    proc.on('exit', (code) => {
      if (state.phase !== 'active') {
        return;
      }
      state.phase = 'stopped';
      const message = `${label} process exited with code ${code ?? 'unknown'}`;
      state.exitError = new Error(message);
      this.killProcesses(state);
      onExit?.(state.exitError);
    });
  }

  private async waitForReady(
    state: SandboxProcessState,
    url: string,
  ): Promise<boolean> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (state.phase !== 'active') {
        return false;
      }
      if (await this.prober.probe(url)) {
        return true;
      }
      await sleep(this.readinessPollMs);
    }
    return false;
  }

  private killProcesses(state: SandboxProcessState): void {
    for (const proc of [state.backendProcess, state.frontendProcess]) {
      if (!proc || proc.killed) {
        continue;
      }
      this.killProcessTree(proc);
    }
    state.backendProcess = undefined;
    state.frontendProcess = undefined;
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
}

export function createDefaultPortAllocator(): PortAllocator {
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

export function createDefaultProber(): ReadinessProber {
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
