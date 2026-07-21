import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { ConnectionTester } from '../src/connection-tester.js';
import type { ProcessSpawner } from '../src/preview-manager.js';

interface SpawnRecord {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

class FakeSpawner implements ProcessSpawner {
  readonly spawns: SpawnRecord[] = [];
  readonly children: FakeChildProcess[] = [];

  constructor(private readonly run: (child: FakeChildProcess) => void) {}

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
    this.spawns.push({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
    });
    const child = new FakeChildProcess();
    this.children.push(child);
    setImmediate(() => this.run(child));
    return child as unknown as ChildProcess;
  }
}

describe('ConnectionTester', () => {
  const workspaceDir = path.join('/tmp', 'chat-workspace');
  const connectionUrl =
    'mssql+pymssql://sa:Sup3rS3cret!@dbhost:1433/sales';
  const env = {
    DATASOURCE_NAMES: 'SALES',
    DATASOURCE_SALES_KIND: 'mssql',
    DATASOURCE_SALES_URL: connectionUrl,
  };

  it('runs the trusted datasource test command and returns reported latency', async () => {
    const spawner = new FakeSpawner((child) => {
      child.stdout.write('{"ok": true, "latencyMs": 42}\n');
      child.emit('close', 0);
    });
    const tester = new ConnectionTester({ spawner });

    const result = await tester.test({
      workspaceDir,
      env,
      name: 'SALES',
      secretsToRedact: [],
    });

    expect(result).toEqual({ ok: true, latencyMs: 42 });
    expect(spawner.spawns).toHaveLength(1);
    expect(spawner.spawns[0]).toMatchObject({
      command: 'uv',
      args: ['run', 'python', '-m', 'app.datasources_test', 'SALES'],
      cwd: path.join(workspaceDir, 'backend'),
      env,
    });
  });

  it('redacts secrets from unstructured failure output', async () => {
    const spawner = new FakeSpawner((child) => {
      child.stderr.write(
        `OperationalError: connection to ${connectionUrl} failed\n`,
      );
      child.emit('close', 1);
    });
    const tester = new ConnectionTester({ spawner });

    const result = await tester.test({
      workspaceDir,
      env,
      name: 'SALES',
      secretsToRedact: ['Sup3rS3cret!', connectionUrl],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('OperationalError');
    expect(result.error).not.toContain('Sup3rS3cret!');
    expect(result.error).not.toContain(connectionUrl);
  });

  it('redacts secrets from a parsed JSON error', async () => {
    const spawner = new FakeSpawner((child) => {
      child.stdout.write(
        `${JSON.stringify({
          ok: false,
          error: `login failed for ${connectionUrl}`,
        })}\n`,
      );
      child.emit('close', 1);
    });
    const tester = new ConnectionTester({ spawner });

    const result = await tester.test({
      workspaceDir,
      env,
      name: 'SALES',
      secretsToRedact: ['Sup3rS3cret!', connectionUrl],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('login failed for ***');
    expect(result.error).not.toContain('Sup3rS3cret!');
    expect(result.error).not.toContain(connectionUrl);
  });

  it('kills and reports a subprocess that exceeds the timeout', async () => {
    const spawner = new FakeSpawner(() => {});
    const tester = new ConnectionTester({ spawner, timeoutMs: 50 });

    const result = await tester.test({
      workspaceDir,
      env,
      name: 'SALES',
      secretsToRedact: [],
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'Connection test timed out after 50 ms',
    });
    expect(spawner.children[0]?.killed).toBe(true);
  });

  it('returns a sanitized spawn error', async () => {
    const spawner = new FakeSpawner((child) => {
      child.emit('error', new Error('spawn uv ENOENT'));
    });
    const tester = new ConnectionTester({ spawner });

    const result = await tester.test({
      workspaceDir,
      env,
      name: 'SALES',
      secretsToRedact: [],
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'spawn uv ENOENT',
    });
  });
});
