import { cp, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { git } from './git.js';
import {
  BASELINE_COMMIT_MESSAGE,
  TEMPLATE_EXCLUDES,
  type WorkspaceProvider,
  type WorkspaceSeed,
} from './types.js';

export class LocalWorkspaceProvider implements WorkspaceProvider {
  constructor(
    private readonly templatePath: string,
    private readonly workspacesRoot: string,
  ) {}

  async create(chatId: string, seed?: WorkspaceSeed): Promise<string> {
    const workspaceDir = path.join(this.workspacesRoot, chatId);
    await mkdir(workspaceDir, { recursive: true });
    if (seed) {
      await this.seedWorkspace(workspaceDir, seed);
    } else {
      await this.copyTemplate(this.templatePath, workspaceDir);
      await git(workspaceDir, ['init', '-b', 'main']);
      await git(workspaceDir, ['add', '-A']);
      await git(workspaceDir, ['commit', '-m', BASELINE_COMMIT_MESSAGE]);
    }
    return workspaceDir;
  }

  // Seed path: build the workspace from an existing repo state instead of the
  // golden template. A depth-1 fetch of the exact ref keeps it cheap, and works
  // for an arbitrary sha (which `git clone <url> --branch <sha>` cannot) via
  // init + fetch + checkout. FETCH_HEAD lands on branch main so the rest of the
  // orchestrator — which assumes work happens on main — sees the same shape a
  // template-born workspace has.
  private async seedWorkspace(
    dest: string,
    seed: WorkspaceSeed,
  ): Promise<void> {
    await git(dest, ['init', '-b', 'main']);
    await git(dest, ['fetch', '--depth', '1', seed.url, seed.ref]);
    await git(dest, ['checkout', '-B', 'main', 'FETCH_HEAD']);
    await this.chmodGate(dest);
  }

  private async copyTemplate(src: string, dest: string): Promise<void> {
    await cp(src, dest, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(src, source);
        if (!relative) {
          return true;
        }
        const parts = relative.split(path.sep);
        return !parts.some((part) => TEMPLATE_EXCLUDES.has(part));
      },
    });

    await this.chmodGate(dest);
  }

  private async chmodGate(dest: string): Promise<void> {
    const gatePath = path.join(dest, 'gate.sh');
    try {
      await chmod(gatePath, 0o755);
    } catch {
      // gate.sh may be absent in minimal fixtures / seeds
    }
  }
}
