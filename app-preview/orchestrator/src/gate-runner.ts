import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { GateRunner } from './types.js';
import { workspaceEnv } from './workspace-env.js';

export interface ShellGateRunnerOptions {
  timeoutMs: number;
  sourceGatePath: string;
  trustedGatePath: string;
}

export class ShellGateRunner implements GateRunner {
  private trustedGateReady?: Promise<void>;

  constructor(private readonly options: ShellGateRunnerOptions) {}

  async run(workspaceDir: string): Promise<{ green: boolean; output: string }> {
    try {
      await this.ensureTrustedGate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { green: false, output: `Failed to prepare trusted gate: ${message}` };
    }

    return new Promise((resolve) => {
      const child = spawn('bash', [this.options.trustedGatePath], {
        cwd: workspaceDir,
        env: workspaceEnv(),
      });

      let output = '';
      const append = (chunk: Buffer | string) => {
        output += chunk.toString();
      };

      child.stdout.on('data', append);
      child.stderr.on('data', append);

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        output += '\n[GATE TIMEOUT]';
        resolve({ green: false, output });
      }, this.options.timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ green: code === 0, output });
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ green: false, output: `${output}\n${error.message}`.trim() });
      });
    });
  }

  private async ensureTrustedGate(): Promise<void> {
    const readiness = this.trustedGateReady ??= (async () => {
      await mkdir(path.dirname(this.options.trustedGatePath), { recursive: true });
      await copyFile(this.options.sourceGatePath, this.options.trustedGatePath);
      await chmod(this.options.trustedGatePath, 0o755);
    })();
    try {
      await readiness;
    } catch (error) {
      if (this.trustedGateReady === readiness) {
        this.trustedGateReady = undefined;
      }
      throw error;
    }
  }
}
