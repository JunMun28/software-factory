import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BASELINE_COMMIT_MESSAGE } from './types.js';

const execFileAsync = promisify(execFile);

export async function git(
  workspaceDir: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', ['-C', workspaceDir, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
}

export async function gitHasChanges(workspaceDir: string): Promise<boolean> {
  const { stdout } = await git(workspaceDir, ['status', '--porcelain']);
  return stdout.trim().length > 0;
}

export function gitResetHardAndClean(workspaceDir: string): boolean {
  let status: string;
  try {
    status = execFileSync(
      'git',
      ['-C', workspaceDir, 'status', '--porcelain'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return false;
  }
  if (status.trim().length === 0) {
    return false;
  }
  execFileSync('git', ['-C', workspaceDir, 'reset', '--hard', 'HEAD'], {
    stdio: 'ignore',
  });
  execFileSync('git', ['-C', workspaceDir, 'clean', '-fd'], {
    stdio: 'ignore',
  });
  return true;
}

export async function gitCommit(
  workspaceDir: string,
  message: string,
  options: { allowEmpty?: boolean } = {},
): Promise<string> {
  await git(workspaceDir, ['add', '-A']);
  await git(workspaceDir, [
    'commit',
    ...(options.allowEmpty ? ['--allow-empty'] : []),
    '-m',
    message,
  ]);
  const { stdout } = await git(workspaceDir, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

export async function gitRestoreToCommit(
  workspaceDir: string,
  commit: string,
): Promise<void> {
  await git(workspaceDir, ['read-tree', '-u', '--reset', commit]);
  await git(workspaceDir, ['clean', '-fd']);
}

export async function gitImportCommitTree(
  workspaceDir: string,
  sourceWorkspaceDir: string,
  sourceCommit: string,
  message: string,
): Promise<string> {
  await git(workspaceDir, [
    'fetch',
    '--no-tags',
    sourceWorkspaceDir,
    sourceCommit,
  ]);
  await gitRestoreToCommit(workspaceDir, 'FETCH_HEAD');
  return gitCommit(workspaceDir, message, { allowEmpty: true });
}

export async function listVersions(workspaceDir: string): Promise<
  Array<{ commit: string; message: string }>
> {
  const { stdout } = await git(workspaceDir, [
    'log',
    '--format=%H%x09%s',
    '--reverse',
  ]);
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .map((line) => {
      const tab = line.indexOf('\t');
      if (tab === -1) {
        return null;
      }
      const commit = line.slice(0, tab);
      const message = line.slice(tab + 1);
      return { commit, message };
    })
    .filter((entry): entry is { commit: string; message: string } => entry !== null)
    .filter((entry) => entry.message !== BASELINE_COMMIT_MESSAGE);
}

// The seed/baseline commit a chat is anchored at: the single root reachable
// from `ref`. For a seeded chat this is the (shallow) commit fetched at seed
// time; for a template-born chat it is the "Baseline: Golden Template" commit.
// Chat history is linear from one root, so there is exactly one.
export async function gitRootCommit(
  workspaceDir: string,
  ref = 'HEAD',
): Promise<string> {
  const { stdout } = await git(workspaceDir, [
    'rev-list',
    '--max-parents=0',
    ref,
  ]);
  const root = stdout.trim().split('\n')[0]?.trim();
  if (!root) {
    throw new Error(`No root commit reachable from ${ref}`);
  }
  return root;
}

// Every commit in `from..to` (excludes `from`, includes `to`), oldest first.
// This is the per-checkpoint history piece 2 replays 1:1.
export async function listCommitRange(
  workspaceDir: string,
  fromExclusive: string,
  toInclusive: string,
): Promise<Array<{ sha: string; message: string }>> {
  const { stdout } = await git(workspaceDir, [
    'log',
    '--reverse',
    '--format=%H%x09%s',
    `${fromExclusive}..${toInclusive}`,
  ]);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const sha = tab === -1 ? line : line.slice(0, tab);
      const message = tab === -1 ? '' : line.slice(tab + 1);
      return { sha, message };
    });
}

// A base64 git bundle of `from..toSha` (excludes `from`, includes `toSha`).
// The range is thin — it carries `from` as a prerequisite, not a payload — so
// the factory, which already holds the seed ref, can unbundle it onto a temp
// ref. `git bundle` refuses a range that names no ref (a raw sha is not one),
// so we point a throwaway branch at `toSha`, bundle that ref, and delete it.
// The temp branch never touches HEAD or the working tree.
export async function gitBundleRange(
  workspaceDir: string,
  fromExclusive: string,
  toSha: string,
): Promise<string> {
  const tmpBranch = `appview-export-${randomUUID()}`;
  const tmpFile = path.join(os.tmpdir(), `appview-bundle-${randomUUID()}.bundle`);
  try {
    await git(workspaceDir, ['branch', tmpBranch, toSha]);
    await git(workspaceDir, [
      'bundle',
      'create',
      tmpFile,
      `${fromExclusive}..refs/heads/${tmpBranch}`,
    ]);
    return (await readFile(tmpFile)).toString('base64');
  } finally {
    await git(workspaceDir, ['branch', '-D', tmpBranch]).catch(() => {});
    await rm(tmpFile, { force: true }).catch(() => {});
  }
}

export function truncatePrompt(prompt: string, maxLen = 72): string {
  const firstLine = prompt.split('\n')[0]?.trim() ?? 'Turn';
  if (firstLine.length <= maxLen) {
    return firstLine;
  }
  return `${firstLine.slice(0, maxLen - 3)}...`;
}

export function tailOutput(output: string, maxChars = 4000): string {
  if (output.length <= maxChars) {
    return output;
  }
  return output.slice(-maxChars);
}
