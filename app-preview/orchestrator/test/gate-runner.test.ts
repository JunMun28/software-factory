import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ShellGateRunner } from '../src/gate-runner.js';

describe('ShellGateRunner', () => {
  let tempRoot = '';

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  it('runs the trusted gate copy without passing host secrets', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-gate-'));
    const templateDir = path.join(tempRoot, 'template');
    const workspaceDir = path.join(tempRoot, 'workspace');
    const trustedGatePath = path.join(tempRoot, 'data', 'trusted', 'gate.sh');
    const sourceGatePath = path.join(templateDir, 'gate.sh');
    await mkdir(templateDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    await writeFile(
      sourceGatePath,
      '#!/usr/bin/env bash\nprintf "script=%s\\nsecret=%s\\ndatasource=%s\\ncwd=%s\\n" "$0" "${FAKE_SECRET-unset}" "${DATASOURCE_SALES_URL-unset}" "$PWD"\n',
    );
    await chmod(sourceGatePath, 0o755);
    await writeFile(
      path.join(workspaceDir, 'gate.sh'),
      '#!/usr/bin/env bash\necho "WORKSPACE GATE EXECUTED"\n',
    );

    const previousSecret = process.env.FAKE_SECRET;
    const previousDatasourceUrl = process.env.DATASOURCE_SALES_URL;
    process.env.FAKE_SECRET = 'must-not-leak';
    process.env.DATASOURCE_SALES_URL =
      'mssql+pymssql://sa:leak@host/db';
    try {
      const runner = new ShellGateRunner({
        timeoutMs: 5_000,
        sourceGatePath,
        trustedGatePath,
      });

      const result = await runner.run(workspaceDir);

      expect(result.green).toBe(true);
      expect(result.output).toContain(`script=${trustedGatePath}`);
      expect(result.output).toContain('secret=unset');
      expect(result.output).toContain('datasource=unset');
      expect(result.output).toContain(`cwd=${await realpath(workspaceDir)}`);
      expect(result.output).not.toContain('WORKSPACE GATE EXECUTED');
      expect(await readFile(trustedGatePath, 'utf8')).toBe(
        await readFile(sourceGatePath, 'utf8'),
      );
      expect((await stat(trustedGatePath)).mode & 0o777).toBe(0o755);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.FAKE_SECRET;
      } else {
        process.env.FAKE_SECRET = previousSecret;
      }
      if (previousDatasourceUrl === undefined) {
        delete process.env.DATASOURCE_SALES_URL;
      } else {
        process.env.DATASOURCE_SALES_URL = previousDatasourceUrl;
      }
    }
  });

  it('retries trusted gate preparation after a transient failure', async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-gate-retry-'));
    const templateDir = path.join(tempRoot, 'template');
    const workspaceDir = path.join(tempRoot, 'workspace');
    const sourceGatePath = path.join(templateDir, 'gate.sh');
    const trustedGatePath = path.join(tempRoot, 'trusted', 'gate.sh');
    await mkdir(templateDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    const runner = new ShellGateRunner({
      timeoutMs: 5_000,
      sourceGatePath,
      trustedGatePath,
    });

    const first = await runner.run(workspaceDir);
    expect(first.green).toBe(false);
    expect(first.output).toContain('Failed to prepare trusted gate');

    await writeFile(sourceGatePath, '#!/usr/bin/env bash\necho recovered\n');
    await chmod(sourceGatePath, 0o755);
    const second = await runner.run(workspaceDir);

    expect(second).toEqual({ green: true, output: 'recovered\n' });
  });
});
