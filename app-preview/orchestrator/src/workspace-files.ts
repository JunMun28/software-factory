import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { git } from './git.js';
import {
  TEMPLATE_EXCLUDES,
  type VersionDiffStat,
  type VersionFileChange,
} from './types.js';

export type FileStatus = 'unchanged' | 'created' | 'modified' | 'deleted';

export interface WorkspaceFileEntry {
  path: string;
  status: FileStatus;
}

export interface VersionFileDiff extends WorkspaceFileEntry {
  diff: string;
}

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

export function isExcludedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return segments.some((segment) => TEMPLATE_EXCLUDES.has(segment));
}

export function resolveWorkspacePath(
  workspaceDir: string,
  relativePath: string,
): string {
  const normalized = relativePath.replace(/\\/g, '/').trim();
  if (!normalized || normalized.includes('\0')) {
    throw new WorkspacePathError('Invalid path');
  }
  if (path.isAbsolute(normalized)) {
    throw new WorkspacePathError('Path must be relative');
  }

  const fullPath = path.resolve(workspaceDir, normalized);
  const relative = path.relative(workspaceDir, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new WorkspacePathError('Path escapes workspace');
  }

  return fullPath;
}

function parsePorcelain(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const status = line.slice(0, 2);
    let file = line.slice(3).trim();
    const renameArrow = file.indexOf(' -> ');
    if (renameArrow !== -1) {
      file = file.slice(renameArrow + 4);
    }
    map.set(file.replace(/\\/g, '/'), status);
  }
  return map;
}

function deriveStatus(porcelainStatus: string | undefined): FileStatus {
  if (!porcelainStatus) {
    return 'unchanged';
  }
  if (porcelainStatus === '??') {
    return 'created';
  }
  if (porcelainStatus.includes('D')) {
    return 'deleted';
  }
  if (
    porcelainStatus.includes('M') ||
    porcelainStatus.includes('A') ||
    porcelainStatus.includes('R') ||
    porcelainStatus.includes('T')
  ) {
    return 'modified';
  }
  return 'unchanged';
}

async function isGitIgnored(
  workspaceDir: string,
  relativePath: string,
): Promise<boolean> {
  if (isExcludedPath(relativePath)) {
    return true;
  }
  try {
    await git(workspaceDir, ['check-ignore', '-q', '--', relativePath]);
    return true;
  } catch {
    return false;
  }
}

export async function listWorkspaceFiles(
  workspaceDir: string,
): Promise<WorkspaceFileEntry[]> {
  const [{ stdout: trackedStdout }, { stdout: porcelainStdout }] =
    await Promise.all([
      git(workspaceDir, ['ls-files']),
      git(workspaceDir, ['status', '--porcelain']),
    ]);

  const tracked = trackedStdout
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean);
  const porcelain = parsePorcelain(porcelainStdout);
  const entries = new Map<string, FileStatus>();

  for (const filePath of tracked) {
    if (isExcludedPath(filePath)) {
      continue;
    }
    entries.set(filePath, deriveStatus(porcelain.get(filePath)));
  }

  for (const [filePath, statusCode] of porcelain) {
    if (statusCode !== '??' || entries.has(filePath) || isExcludedPath(filePath)) {
      continue;
    }
    entries.set(filePath, 'created');
  }

  return [...entries.entries()]
    .map(([filePath, status]) => ({ path: filePath, status }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function readWorkspaceFileContent(
  workspaceDir: string,
  relativePath: string,
): Promise<string> {
  const normalized = relativePath.replace(/\\/g, '/');
  if (isExcludedPath(normalized)) {
    throw new WorkspacePathError('Path is ignored');
  }
  if (await isGitIgnored(workspaceDir, normalized)) {
    throw new WorkspacePathError('Path is ignored');
  }

  const fullPath = resolveWorkspacePath(workspaceDir, normalized);
  const files = await listWorkspaceFiles(workspaceDir);
  const entry = files.find((file) => file.path === normalized);
  if (!entry) {
    throw new WorkspacePathError('File not in workspace');
  }
  if (entry.status === 'deleted') {
    throw new WorkspacePathError('File is deleted');
  }

  return readFile(fullPath, 'utf8');
}

export async function getWorkspaceFileDiff(
  workspaceDir: string,
  relativePath: string,
): Promise<string> {
  const normalized = relativePath.replace(/\\/g, '/');
  if (isExcludedPath(normalized)) {
    throw new WorkspacePathError('Path is ignored');
  }
  if (await isGitIgnored(workspaceDir, normalized)) {
    throw new WorkspacePathError('Path is ignored');
  }

  resolveWorkspacePath(workspaceDir, normalized);

  const files = await listWorkspaceFiles(workspaceDir);
  const entry = files.find((file) => file.path === normalized);
  if (!entry) {
    throw new WorkspacePathError('File not in workspace');
  }
  if (entry.status === 'unchanged') {
    return '';
  }

  if (entry.status === 'created') {
    const fullPath = resolveWorkspacePath(workspaceDir, normalized);
    try {
      const { stdout } = await git(workspaceDir, [
        'diff',
        '--no-index',
        '--',
        '/dev/null',
        normalized,
      ]);
      return stdout;
    } catch (error) {
      const execError = error as { stdout?: string; code?: number };
      if (execError.code === 1 && execError.stdout) {
        return execError.stdout;
      }
      throw error;
    }
  }

  const { stdout } = await git(workspaceDir, ['diff', 'HEAD', '--', normalized]);
  return stdout;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// A version's parent commit, or git's empty tree for the very first commit so
// the diff shows every file as added.
async function resolveDiffBase(
  workspaceDir: string,
  commit: string,
): Promise<string> {
  const { stdout } = await git(workspaceDir, [
    'rev-list',
    '--parents',
    '-n',
    '1',
    commit,
  ]);
  const [, parent] = stdout.trim().split(/\s+/);
  return parent ?? EMPTY_TREE;
}

export interface VersionDiffSummary {
  diffStat: VersionDiffStat;
  files: VersionFileChange[];
}

// Aggregate additions/deletions plus the changed-file list for a version,
// computed against its parent commit. Binary files contribute a file row but
// zero additions/deletions (git reports "-" for their numstat counts).
// Excluded (gitignored) paths never appear in commit diffs, but are filtered
// defensively to mirror getVersionFileDiffs.
export async function getVersionDiffStat(
  workspaceDir: string,
  commit: string,
): Promise<VersionDiffSummary> {
  const base = await resolveDiffBase(workspaceDir, commit);
  const [{ stdout: nameStatus }, { stdout: numstat }] = await Promise.all([
    git(workspaceDir, [
      'diff',
      '--name-status',
      '--find-renames',
      base,
      commit,
    ]),
    git(workspaceDir, ['diff', '--numstat', '--find-renames', base, commit]),
  ]);

  const files: VersionFileChange[] = nameStatus
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [code = '', firstPath = '', secondPath] = line.split('\t');
      const renamed = code.startsWith('R') || code.startsWith('C');
      const filePath = (renamed ? secondPath : firstPath)?.replace(/\\/g, '/') ?? '';
      return { code, filePath };
    })
    .filter(({ filePath }) => filePath && !isExcludedPath(filePath))
    .map(({ code, filePath }) => ({
      path: filePath,
      status: diffStatStatus(code),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const [add = '', del = '', ...rest] = line.split('\t');
    const filePath = numstatPath(rest.join('\t'));
    if (!filePath || isExcludedPath(filePath)) {
      continue;
    }
    additions += add === '-' ? 0 : Number.parseInt(add, 10) || 0;
    deletions += del === '-' ? 0 : Number.parseInt(del, 10) || 0;
  }

  return { diffStat: { additions, deletions }, files };
}

function diffStatStatus(code: string): VersionFileChange['status'] {
  if (code.startsWith('A')) {
    return 'added';
  }
  if (code.startsWith('D')) {
    return 'deleted';
  }
  // M (modified), R (renamed), C (copied), T (type change): all "modified".
  return 'modified';
}

// numstat renders a rename path as "old => new" (or the brace form
// "pre/{old => new}/post"); reduce it to the destination path so exclusion
// checks see the real file.
function numstatPath(raw: string): string {
  const normalized = raw.replace(/\\/g, '/');
  const arrow = normalized.indexOf(' => ');
  if (arrow === -1) {
    return normalized;
  }
  const braceOpen = normalized.indexOf('{');
  if (braceOpen !== -1 && braceOpen < arrow) {
    const braceClose = normalized.indexOf('}', arrow);
    if (braceClose !== -1) {
      const prefix = normalized.slice(0, braceOpen);
      const newPart = normalized.slice(arrow + 4, braceClose);
      const suffix = normalized.slice(braceClose + 1);
      return `${prefix}${newPart}${suffix}`.replace(/\/{2,}/g, '/');
    }
  }
  return normalized.slice(arrow + 4);
}

export async function getVersionFileDiffs(
  workspaceDir: string,
  commit: string,
): Promise<VersionFileDiff[]> {
  const base = await resolveDiffBase(workspaceDir, commit);
  const { stdout: namesOutput } = await git(workspaceDir, [
    'diff',
    '--name-status',
    '--find-renames',
    base,
    commit,
  ]);

  const changed = namesOutput
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [code = '', firstPath = '', secondPath] = line.split('\t');
      const renamed = code.startsWith('R') || code.startsWith('C');
      const filePath = (renamed ? secondPath : firstPath)?.replace(/\\/g, '/');
      return {
        code,
        filePath: filePath ?? '',
        sourcePath: renamed ? firstPath.replace(/\\/g, '/') : null,
      };
    })
    .filter(({ filePath }) => filePath && !isExcludedPath(filePath));

  const files = await Promise.all(
    changed.map(async ({ code, filePath, sourcePath }) => {
      const paths = sourcePath ? [sourcePath, filePath] : [filePath];
      const { stdout: diff } = await git(workspaceDir, [
        'diff',
        '--no-ext-diff',
        '--binary',
        base,
        commit,
        '--',
        ...paths,
      ]);
      return {
        path: filePath,
        status: versionFileStatus(code),
        diff,
      } satisfies VersionFileDiff;
    }),
  );

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function versionFileStatus(code: string): FileStatus {
  if (code.startsWith('A')) {
    return 'created';
  }
  if (code.startsWith('D')) {
    return 'deleted';
  }
  return 'modified';
}
