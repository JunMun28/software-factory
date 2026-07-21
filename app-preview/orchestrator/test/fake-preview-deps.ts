import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type {
  PortAllocator,
  ProcessSpawner,
  ReadinessProber,
} from '../src/preview-manager.js';

export interface FakeSpawnRecord {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export class FakeProcessSpawner implements ProcessSpawner {
  readonly spawns: FakeSpawnRecord[] = [];
  readonly longRunning: FakeChildProcess[] = [];

  spawn(
    command: string,
    args: string[],
    options: { cwd: string; shell?: boolean; detached?: boolean; env?: NodeJS.ProcessEnv },
  ): ChildProcess {
    this.spawns.push({ command, args, cwd: options.cwd, env: options.env });

    if (isLongRunning(command, args)) {
      const proc = new FakeChildProcess();
      this.longRunning.push(proc);
      return proc as unknown as ChildProcess;
    }

    const proc = new FakeChildProcess();
    setImmediate(() => proc.emitExit(0));
    return proc as unknown as ChildProcess;
  }

  exitLongRunning(index: number, code: number | null = 1): void {
    const proc = this.longRunning[index];
    if (proc && !proc.killed) {
      proc.emitExit(code);
    }
  }
}

export class FakeReadinessProber implements ReadinessProber {
  private attempts = 0;

  constructor(private readonly readyAfterAttempts = 2) {}

  async probe(_url: string): Promise<boolean> {
    this.attempts += 1;
    if (this.readyAfterAttempts <= 0) {
      return false;
    }
    return this.attempts >= this.readyAfterAttempts;
  }
}

export class FakePortAllocator implements PortAllocator {
  private nextPort: number;

  constructor(startPort = 45_000) {
    this.nextPort = startPort;
  }

  async allocate(count: number): Promise<number[]> {
    const ports: number[] = [];
    for (let i = 0; i < count; i += 1) {
      ports.push(this.nextPort);
      this.nextPort += 1;
    }
    return ports;
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emitExit(0);
    return true;
  }

  emitExit(code: number | null): void {
    this.killed = true;
    this.emit('exit', code);
    this.emit('close', code);
  }
}

function isLongRunning(command: string, args: string[]): boolean {
  if (args.includes('uvicorn')) {
    return true;
  }
  return command === 'npm' && args[0] === 'start';
}
