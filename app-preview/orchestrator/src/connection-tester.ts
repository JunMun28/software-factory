import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import { sanitizeConnectionName } from './connection-env.js';
import type { ProcessSpawner } from './preview-manager.js';
import { workspaceEnv } from './workspace-env.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ERROR_LENGTH = 500;

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

interface ParsedConnectionTestResult {
  ok: boolean;
  latencyMs?: unknown;
  error?: unknown;
}

export class ConnectionTester {
  private readonly spawner: ProcessSpawner;
  private readonly timeoutMs: number;

  constructor(options: { spawner?: ProcessSpawner; timeoutMs?: number } = {}) {
    this.spawner = options.spawner ?? { spawn: nodeSpawn };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async test(opts: {
    workspaceDir: string;
    env: Record<string, string>;
    name: string;
    secretsToRedact: string[];
  }): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    let child: ChildProcess;
    try {
      child = this.spawner.spawn(
        'uv',
        // The template resolves sources by their env-contract name
        // (DATASOURCE_<NAME>_*), so the argv must be the sanitized form,
        // not the raw stored name (e.g. `orders_api` -> `ORDERS_API`).
        ['run', 'python', '-m', 'app.datasources_test', sanitizeConnectionName(opts.name)],
        {
          cwd: path.join(opts.workspaceDir, 'backend'),
          env: { ...workspaceEnv(), ...opts.env },
        },
      );
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: sanitizeError(errorMessage(error), opts.secretsToRedact),
      };
    }

    return await new Promise<ConnectionTestResult>((resolve) => {
      let stdout = '';
      let combinedOutput = '';
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;

      const finish = (
        result: ConnectionTestResult,
        beforeResolve?: () => void,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        beforeResolve?.();
        resolve(result);
      };

      child.stdout?.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        stdout += text;
        combinedOutput += text;
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        combinedOutput += chunk.toString();
      });

      child.once('error', (error) => {
        finish({
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: sanitizeError(error.message, opts.secretsToRedact),
        });
      });

      child.once('close', () => {
        const elapsed = Date.now() - startedAt;
        const parsed = findLastJsonResult(stdout);
        if (!parsed) {
          finish({
            ok: false,
            latencyMs: elapsed,
            error: outputError(combinedOutput, opts.secretsToRedact),
          });
          return;
        }

        const latencyMs = reportedLatency(parsed.latencyMs, elapsed);
        if (parsed.ok) {
          finish({ ok: true, latencyMs });
          return;
        }

        const parsedError =
          typeof parsed.error === 'string'
            ? sanitizeError(parsed.error, opts.secretsToRedact)
            : '';
        finish({
          ok: false,
          latencyMs,
          error:
            parsedError ||
            outputError(combinedOutput, opts.secretsToRedact),
        });
      });

      timeout = setTimeout(() => {
        const elapsed = Date.now() - startedAt;
        finish(
          {
            ok: false,
            latencyMs: elapsed,
            error: sanitizeError(
              `Connection test timed out after ${this.timeoutMs} ms`,
              opts.secretsToRedact,
            ),
          },
          () => {
            try {
              child.kill();
            } catch {
              // The timeout result is still authoritative if the process
              // exits between the timer firing and the kill attempt.
            }
          },
        );
      }, this.timeoutMs);
    });
  }
}

function findLastJsonResult(stdout: string): ParsedConnectionTestResult | null {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { ok?: unknown }).ok === 'boolean'
      ) {
        return parsed as ParsedConnectionTestResult;
      }
    } catch {
      // Keep scanning for the last earlier line matching the contract.
    }
  }
  return null;
}

function reportedLatency(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function sanitizeError(
  value: string,
  secretsToRedact: string[],
  takeTail = false,
): string {
  let sanitized = value;
  const secrets = [
    ...new Set(secretsToRedact.filter((secret) => secret.length > 0)),
  ].sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    sanitized = sanitized.split(secret).join('***');
  }
  sanitized = sanitized.trim();
  if (sanitized.length <= MAX_ERROR_LENGTH) {
    return sanitized;
  }
  return takeTail
    ? sanitized.slice(-MAX_ERROR_LENGTH)
    : sanitized.slice(0, MAX_ERROR_LENGTH);
}

function outputError(value: string, secretsToRedact: string[]): string {
  return (
    sanitizeError(value, secretsToRedact, true) ||
    sanitizeError('Connection test failed', secretsToRedact)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
