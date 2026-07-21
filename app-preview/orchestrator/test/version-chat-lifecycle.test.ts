import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatStore } from '../src/chat-store.js';
import { git, gitCommit } from '../src/git.js';
import { createApp } from '../src/http/app.js';
import { PlatformDb } from '../src/platform-db.js';
import { PreviewManager } from '../src/preview-manager.js';
import type { GateRunner } from '../src/types.js';
import { LocalWorkspaceProvider } from '../src/workspace-provider.js';
import { FakeHarness } from './fake-harness.js';
import {
  FakePortAllocator,
  FakeProcessSpawner,
  FakeReadinessProber,
} from './fake-preview-deps.js';

const fixtureTemplate = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/template',
);

const greenGate: GateRunner = {
  run: async () => ({ green: true, output: 'GATE GREEN' }),
};

interface VersionJson {
  id: string;
  seq: number;
  commit: string;
  message: string;
  restoredFromVersionId: string | null;
  createdAt: string;
}

interface Context {
  root: string;
  workspacesRoot: string;
  db: PlatformDb;
  chatStore: ChatStore;
  previewManager: PreviewManager;
  app: ReturnType<typeof createApp>;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

async function makeContext(): Promise<Context> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-version-chat-'));
  const workspacesRoot = path.join(root, 'workspaces');
  const db = await PlatformDb.open(path.join(root, 'platform.db'));
  const chatStore = new ChatStore(
    new LocalWorkspaceProvider(fixtureTemplate, workspacesRoot),
    FakeHarness.fromScripts([]),
    greenGate,
    db,
  );
  const previewManager = new PreviewManager({
    workspacesRoot,
    previewRoot: path.join(root, 'preview'),
    spawner: new FakeProcessSpawner(),
    prober: new FakeReadinessProber(1),
    portAllocator: new FakePortAllocator(47_000),
    readinessPollMs: 1,
    bridgeProxy: {
      async start({ port }) {
        return { url: `http://localhost:${port}`, async close() {} };
      },
    },
  });
  const app = createApp({ chatStore, previewManager });

  cleanup.push(async () => {
    await previewManager.dispose();
    await db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspacesRoot, db, chatStore, previewManager, app };
}

async function createChat(
  context: Context,
  options: { projectId?: string; title?: string } = {},
): Promise<string> {
  const response = await context.app.request('/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { chatId: string }).chatId;
}

async function commitVersion(
  context: Context,
  chatId: string,
  prompt: string,
  message: string,
  mutate: (workspaceDir: string) => Promise<void>,
): Promise<string> {
  const workspaceDir = context.chatStore.getWorkspaceDir(chatId);
  expect(workspaceDir).not.toBeNull();
  await mutate(workspaceDir!);
  const commit = await gitCommit(workspaceDir!, message);
  const generationId = await context.db.beginGeneration(chatId, prompt);
  await context.db.finishGeneration(generationId, 'green');
  await context.db.insertVersion(chatId, generationId, commit, message);
  return commit;
}

async function listVersions(context: Context, chatId: string): Promise<VersionJson[]> {
  const response = await context.app.request(`/chats/${chatId}/versions`);
  expect(response.status).toBe(200);
  return (await response.json()) as VersionJson[];
}

describe('version recovery and chat lifecycle API', () => {
  it('lists database versions and restore appends a provenance-linked commit with the source tree', async () => {
    const context = await makeContext();
    const chatId = await createChat(context, { title: 'Restore source' });
    const workspaceDir = context.chatStore.getWorkspaceDir(chatId)!;

    const firstCommit = await commitVersion(
      context,
      chatId,
      'first',
      'Version one',
      async (dir) => {
        await writeFile(path.join(dir, 'hello.txt'), 'version one\n');
        await writeFile(path.join(dir, 'only-v1.txt'), 'keep me\n');
      },
    );
    const secondCommit = await commitVersion(
      context,
      chatId,
      'second',
      'Version two',
      async (dir) => {
        await writeFile(path.join(dir, 'hello.txt'), 'version two\n');
        await rm(path.join(dir, 'only-v1.txt'));
        await writeFile(path.join(dir, 'only-v2.txt'), 'remove me\n');
      },
    );
    const before = await listVersions(context, chatId);
    await writeFile(path.join(workspaceDir, 'only-v1.txt'), 'untracked collision\n');
    await writeFile(path.join(workspaceDir, 'untracked-after-v2.txt'), 'remove me too\n');

    expect(before).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        seq: 1,
        commit: firstCommit,
        message: 'Version one',
        restoredFromVersionId: null,
        createdAt: expect.any(String),
      }),
      expect.objectContaining({ seq: 2, commit: secondCommit }),
    ]);

    const response = await context.app.request(
      `/chats/${chatId}/versions/${before[0]!.id}/restore`,
      { method: 'POST' },
    );
    const restored = (await response.json()) as VersionJson;

    expect(response.status).toBe(201);
    expect(restored).toMatchObject({
      id: expect.any(String),
      seq: 3,
      commit: expect.any(String),
      message: 'Restore v1',
      restoredFromVersionId: before[0]!.id,
      createdAt: expect.any(String),
    });
    expect((await git(workspaceDir, ['rev-parse', 'HEAD^'])).stdout.trim()).toBe(
      secondCommit,
    );
    expect((await git(workspaceDir, ['diff', '--exit-code', firstCommit, restored.commit])).stdout).toBe('');
    expect(await readFile(path.join(workspaceDir, 'hello.txt'), 'utf8')).toBe(
      'version one\n',
    );
    expect(await readFile(path.join(workspaceDir, 'only-v1.txt'), 'utf8')).toBe(
      'keep me\n',
    );
    await expect(access(path.join(workspaceDir, 'only-v2.txt'))).rejects.toThrow();
    await expect(
      access(path.join(workspaceDir, 'untracked-after-v2.txt')),
    ).rejects.toThrow();
    expect(await listVersions(context, chatId)).toHaveLength(3);

    const missing = await context.app.request(
      `/chats/${chatId}/versions/not-a-version/restore`,
      { method: 'POST' },
    );
    expect(missing.status).toBe(404);
  });

  it('pokes a live sandbox to the restored commit (cloud previews hold their own clone)', async () => {
    const context = await makeContext();
    const chatId = await createChat(context, { title: 'Restore resync' });

    await commitVersion(context, chatId, 'first', 'Version one', async (dir) => {
      await writeFile(path.join(dir, 'hello.txt'), 'version one\n');
    });
    await commitVersion(context, chatId, 'second', 'Version two', async (dir) => {
      await writeFile(path.join(dir, 'hello.txt'), 'version two\n');
    });
    const before = await listVersions(context, chatId);

    const resyncs: Array<{ chatId: string; sha: string }> = [];
    context.chatStore.onVersionCreated = (id, sha) => {
      resyncs.push({ chatId: id, sha });
    };

    const response = await context.app.request(
      `/chats/${chatId}/versions/${before[0]!.id}/restore`,
      { method: 'POST' },
    );
    expect(response.status).toBe(201);
    const restored = (await response.json()) as VersionJson;

    expect(resyncs).toHaveLength(1);
    expect(resyncs[0]).toMatchObject({ chatId, sha: restored.commit });
  });

  it('forks a version into an independent chat in the same project', async () => {
    const context = await makeContext();
    const projectResponse = await context.app.request('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fork project' }),
    });
    const project = (await projectResponse.json()) as { id: string };
    const sourceChatId = await createChat(context, {
      projectId: project.id,
      title: 'Source chat',
    });
    const sourceCommit = await commitVersion(
      context,
      sourceChatId,
      'source',
      'Source version',
      async (dir) => {
        await writeFile(path.join(dir, 'hello.txt'), 'forked content\n');
        await writeFile(path.join(dir, 'fork-only.txt'), 'from source\n');
      },
    );
    const [sourceVersion] = await listVersions(context, sourceChatId);

    const response = await context.app.request(
      `/chats/${sourceChatId}/versions/${sourceVersion!.id}/fork`,
      { method: 'POST' },
    );
    const body = (await response.json()) as { chatId: string };

    expect(response.status).toBe(201);
    expect(body.chatId).not.toBe(sourceChatId);
    const forkResponse = await context.app.request(`/chats/${body.chatId}`);
    const fork = (await forkResponse.json()) as {
      chatId: string;
      projectId: string;
      title: string;
    };
    expect(fork).toMatchObject({
      chatId: body.chatId,
      projectId: project.id,
      title: 'Fork of Source chat',
    });

    const forkWorkspace = context.chatStore.getWorkspaceDir(body.chatId)!;
    const [forkVersion] = await listVersions(context, body.chatId);
    expect(forkVersion).toMatchObject({
      seq: 1,
      commit: expect.any(String),
      message: 'Fork from v1',
      restoredFromVersionId: null,
    });
    expect(forkVersion!.commit).not.toBe(sourceCommit);
    expect((await git(forkWorkspace, ['diff', '--exit-code', sourceCommit, 'HEAD'])).stdout).toBe('');
    expect(await readFile(path.join(forkWorkspace, 'fork-only.txt'), 'utf8')).toBe(
      'from source\n',
    );

    await writeFile(path.join(forkWorkspace, 'fork-only.txt'), 'changed in fork\n');
    expect(
      await readFile(
        path.join(context.chatStore.getWorkspaceDir(sourceChatId)!, 'fork-only.txt'),
        'utf8',
      ),
    ).toBe('from source\n');
  });

  it('returns each file changed by a version with its historical patch', async () => {
    const context = await makeContext();
    const chatId = await createChat(context);
    await commitVersion(context, chatId, 'first', 'First version', async (dir) => {
      await writeFile(path.join(dir, 'hello.txt'), 'first\n');
    });
    await commitVersion(context, chatId, 'second', 'Second version', async (dir) => {
      await writeFile(path.join(dir, 'hello.txt'), 'second\n');
      await writeFile(path.join(dir, 'added.txt'), 'new file\n');
    });
    const versions = await listVersions(context, chatId);

    const response = await context.app.request(
      `/chats/${chatId}/versions/${versions[1]!.id}/diff`,
    );
    const body = (await response.json()) as {
      files: Array<{ path: string; status: string; diff: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.files).toEqual([
      expect.objectContaining({
        path: 'added.txt',
        status: 'created',
        diff: expect.stringContaining('+new file'),
      }),
      expect.objectContaining({
        path: 'hello.txt',
        status: 'modified',
        diff: expect.stringContaining('-first'),
      }),
    ]);
    expect(body.files[1]!.diff).toContain('+second');
  });

  it('renames a chat and delete cascades metadata, stops preview, and removes its workspace', async () => {
    const context = await makeContext();
    const chatId = await createChat(context, { title: 'Old title' });
    const workspaceDir = context.chatStore.getWorkspaceDir(chatId)!;
    await commitVersion(context, chatId, 'delete me', 'Disposable version', async (dir) => {
      await writeFile(path.join(dir, 'hello.txt'), 'temporary\n');
    });
    const generationId = await context.db.beginGeneration(chatId, 'eventful turn');
    await context.db.appendTurnEvent(generationId, {
      type: 'turn-started',
      chatId,
      turnId: 'turn-delete',
    });
    await context.db.finishGeneration(generationId, 'no-change');

    const renameResponse = await context.app.request(`/chats/${chatId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '  New title  ' }),
    });
    const renamed = (await renameResponse.json()) as { title: string };
    expect(renameResponse.status).toBe(200);
    expect(renamed.title).toBe('New title');

    const invalidRename = await context.app.request(`/chats/${chatId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    });
    expect(invalidRename.status).toBe(400);

    const stop = vi.spyOn(context.previewManager, 'stop');
    const deleteResponse = await context.app.request(`/chats/${chatId}`, {
      method: 'DELETE',
    });

    expect(deleteResponse.status).toBe(204);
    expect(stop).toHaveBeenCalledWith(chatId);
    expect(context.chatStore.hasChat(chatId)).toBe(false);
    expect((await context.db.listChats()).some((chat) => chat.id === chatId)).toBe(
      false,
    );
    expect(await context.db.listTurns(chatId)).toEqual([]);
    expect(await context.db.countVersions(chatId)).toBe(0);
    expect(await context.db.listTurnEvents(generationId)).toEqual([]);
    await expect(access(workspaceDir)).rejects.toThrow();

    const secondDelete = await context.app.request(`/chats/${chatId}`, {
      method: 'DELETE',
    });
    expect(secondDelete.status).toBe(404);
  });

  it('rejects deleting a running chat without stopping its preview or deleting records', async () => {
    const context = await makeContext();
    const chatId = await createChat(context, { title: 'Running chat' });
    const workspaceDir = context.chatStore.getWorkspaceDir(chatId)!;
    await context.previewManager.ensure(chatId);
    const stop = vi.spyOn(context.previewManager, 'stop');
    const generationId = await context.db.beginGeneration(chatId, 'Keep this turn alive');
    await context.db.appendTurnEvent(generationId, {
      type: 'turn-started',
      chatId,
      turnId: 'turn-running',
    });
    context.chatStore.beginTurn(chatId);

    const response = await context.app.request(`/chats/${chatId}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Turn already in progress' });
    expect(stop).not.toHaveBeenCalled();
    expect(context.previewManager.status(chatId).status).toBe('ready');
    expect(context.chatStore.hasChat(chatId)).toBe(true);
    expect((await context.db.listChats()).some((chat) => chat.id === chatId)).toBe(
      true,
    );
    expect(await context.db.listTurns(chatId)).toEqual([
      expect.objectContaining({
        generationId,
        prompt: 'Keep this turn alive',
        result: 'running',
      }),
    ]);
    expect(await context.db.listTurnEvents(generationId)).toHaveLength(1);
    await expect(access(workspaceDir)).resolves.toBeUndefined();
  });
});
