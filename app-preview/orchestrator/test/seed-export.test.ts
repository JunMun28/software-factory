import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatStore } from '../src/chat-store.js';
import { ShellGateRunner } from '../src/gate-runner.js';
import { git, gitCommit } from '../src/git.js';
import { createApp } from '../src/http/app.js';
import { PlatformDb } from '../src/platform-db.js';
import { PreviewManager } from '../src/preview-manager.js';
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
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

async function makeContext(): Promise<Context> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-seed-'));
  const workspacesRoot = path.join(root, 'workspaces');
  // The factory's own gate (piece 2 invariant: it grades every seed under ITS
  // OWN runner). Here it simply re-runs whatever gate.sh the workspace carries,
  // so a seed's exit code decides green/red.
  const factoryGate = path.join(root, 'factory-gate.sh');
  await writeFile(factoryGate, '#!/usr/bin/env bash\nexec bash gate.sh\n');
  await chmod(factoryGate, 0o755);
  const db = await PlatformDb.open(path.join(root, 'platform.db'));
  const chatStore = new ChatStore(
    new LocalWorkspaceProvider(fixtureTemplate, workspacesRoot),
    FakeHarness.fromScripts([]),
    new ShellGateRunner({
      timeoutMs: 30_000,
      sourceGatePath: factoryGate,
      trustedGatePath: path.join(root, 'trusted', 'gate.sh'),
    }),
    db,
  );
  const previewManager = new PreviewManager({
    workspacesRoot,
    previewRoot: path.join(root, 'preview'),
    spawner: new FakeProcessSpawner(),
    prober: new FakeReadinessProber(1),
    portAllocator: new FakePortAllocator(48_000),
    readinessPollMs: 1,
    bridgeProxy: {
      async start({ port }) {
        return { url: `http://localhost:${port}`, async close() {} };
      },
    },
  });
  const app = createApp({ chatStore, previewManager });

  cleanup.push(async () => {
    previewManager.dispose();
    await db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspacesRoot, db, chatStore, previewManager, app };
}

// A local git repo standing in for the factory's git-daemon source. `gateExit`
// is the exit code the seeded app's own gate.sh returns; `gateStdout` is what
// it prints, so the red path can assert on the gate tail.
async function makeSeedRepo(
  root: string,
  opts: { gateExit: number; gateStdout?: string },
): Promise<{ dir: string; sha: string; url: string }> {
  const dir = path.join(root, `seed-source-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'seed@test.local']);
  await git(dir, ['config', 'user.name', 'Seed Source']);
  await writeFile(path.join(dir, 'index.html'), 'seed content\n');
  const gate = `#!/usr/bin/env bash\n${
    opts.gateStdout ? `echo "${opts.gateStdout}"\n` : ''
  }exit ${opts.gateExit}\n`;
  await writeFile(path.join(dir, 'gate.sh'), gate);
  await chmod(path.join(dir, 'gate.sh'), 0o755);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'seed baseline']);
  const sha = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  return { dir, sha, url: `file://${dir}` };
}

async function postChat(
  context: Context,
  body: Record<string, unknown>,
): Promise<Response> {
  return context.app.request('/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Directly cut a version commit + row, mirroring version-chat-lifecycle.test's
// helper — a real turn needs a live harness, which these tests do not exercise.
async function commitVersion(
  context: Context,
  chatId: string,
  message: string,
  mutate: (workspaceDir: string) => Promise<void>,
): Promise<string> {
  const workspaceDir = context.chatStore.getWorkspaceDir(chatId)!;
  await mutate(workspaceDir);
  const commit = await gitCommit(workspaceDir, message);
  const generationId = await context.db.beginGeneration(chatId, message);
  await context.db.finishGeneration(generationId, 'green');
  await context.db.insertVersion(chatId, generationId, commit, message);
  return commit;
}

async function listVersionIds(
  context: Context,
  chatId: string,
): Promise<Array<{ id: string; commit: string; message: string }>> {
  const response = await context.app.request(`/chats/${chatId}/versions`);
  return (await response.json()) as Array<{
    id: string;
    commit: string;
    message: string;
  }>;
}

describe('POST /chats seed', () => {
  it('seeds a workspace from a git source, gates it green, and records provenance', async () => {
    const context = await makeContext();
    const seed = await makeSeedRepo(context.root, { gateExit: 0 });

    const response = await postChat(context, {
      title: 'REQ-2136 preview edits',
      seed: { kind: 'git', url: seed.url, ref: seed.sha },
    });
    expect(response.status).toBe(201);
    const { chatId } = (await response.json()) as { chatId: string };

    const workspaceDir = context.chatStore.getWorkspaceDir(chatId)!;
    // On branch main, at the seed sha, with the seed's files (no template copy).
    expect((await git(workspaceDir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(
      seed.sha,
    );
    expect(
      (await git(workspaceDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(),
    ).toBe('main');
    expect(await readFile(path.join(workspaceDir, 'index.html'), 'utf8')).toBe(
      'seed content\n',
    );
    // The seed commit is the workspace root — the golden baseline was skipped.
    expect(
      (await git(workspaceDir, ['rev-list', '--max-parents=0', 'HEAD'])).stdout.trim(),
    ).toBe(seed.sha);

    // Provenance is exposed on the summary and the list payload.
    const summary = await (await context.app.request(`/chats/${chatId}`)).json();
    expect(summary).toMatchObject({
      seedUrl: seed.url,
      seedRef: seed.sha,
    });
    const list = (await (await context.app.request('/chats')).json()) as Array<{
      chatId: string;
      seedUrl: string | null;
      seedRef: string | null;
    }>;
    expect(list.find((chat) => chat.chatId === chatId)).toMatchObject({
      seedUrl: seed.url,
      seedRef: seed.sha,
    });
  });

  it('rejects a red seed with 422 and the gate tail, leaving no chat or workspace', async () => {
    const context = await makeContext();
    const seed = await makeSeedRepo(context.root, {
      gateExit: 1,
      gateStdout: 'GATE RED: seeded build is broken',
    });

    const response = await postChat(context, {
      seed: { kind: 'git', url: seed.url, ref: seed.sha },
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; gateOutput: string };
    expect(body.error).toBe('Seed gate failed');
    expect(body.gateOutput).toContain('GATE RED: seeded build is broken');

    // Nothing persisted, and the workspace directory was cleaned up.
    expect(await context.db.listChats()).toEqual([]);
    const remaining = await readdir(context.workspacesRoot).catch(() => []);
    expect(remaining).toEqual([]);
  });

  it('leaves seed metadata null for a template-born chat', async () => {
    const context = await makeContext();
    const response = await postChat(context, { title: 'plain chat' });
    expect(response.status).toBe(201);
    const { chatId } = (await response.json()) as { chatId: string };

    const summary = await (await context.app.request(`/chats/${chatId}`)).json();
    expect(summary).toMatchObject({ seedUrl: null, seedRef: null });
  });

  it('rejects a malformed seed with 400 before touching the workspace', async () => {
    const context = await makeContext();
    const badKind = await postChat(context, {
      seed: { kind: 'svn', url: 'file:///x', ref: 'abc' },
    });
    expect(badKind.status).toBe(400);
    const missingRef = await postChat(context, {
      seed: { kind: 'git', url: 'file:///x' },
    });
    expect(missingRef.status).toBe(400);
    expect(await context.db.listChats()).toEqual([]);
  });
});

describe('POST /chats/:chatId/versions/:versionId/export', () => {
  it('exports a version chain against the seed ref and the bundle round-trips', async () => {
    const context = await makeContext();
    const seed = await makeSeedRepo(context.root, { gateExit: 0 });
    const response = await postChat(context, {
      seed: { kind: 'git', url: seed.url, ref: seed.sha },
    });
    const { chatId } = (await response.json()) as { chatId: string };

    const v1 = await commitVersion(context, chatId, 'Version one', async (dir) => {
      await writeFile(path.join(dir, 'index.html'), 'v1 content\n');
    });
    const v2 = await commitVersion(context, chatId, 'Version two', async (dir) => {
      await writeFile(path.join(dir, 'index.html'), 'v2 content\n');
      await writeFile(path.join(dir, 'added.txt'), 'new file\n');
    });
    const versions = await listVersionIds(context, chatId);
    expect(versions.map((v) => v.commit)).toEqual([v1, v2]);

    const exportResponse = await context.app.request(
      `/chats/${chatId}/versions/${versions[1]!.id}/export`,
      { method: 'POST' },
    );
    expect(exportResponse.status).toBe(200);
    const bundleResult = (await exportResponse.json()) as {
      bundle: string;
      seedRef: string;
      versions: Array<{ sha: string; message: string }>;
    };

    expect(bundleResult.seedRef).toBe(seed.sha);
    expect(bundleResult.versions).toEqual([
      { sha: v1, message: 'Version one' },
      { sha: v2, message: 'Version two' },
    ]);
    expect(bundleResult.bundle.length).toBeGreaterThan(0);

    // Round-trip: mimic the factory, which already holds the seed ref. Fetch it
    // from the source, then unbundle the thin bundle onto it and verify the
    // full checkpoint chain and file contents replay 1:1.
    const bundleFile = path.join(context.root, 'export.bundle');
    await writeFile(bundleFile, Buffer.from(bundleResult.bundle, 'base64'));
    const replay = path.join(context.root, `replay-${randomUUID()}`);
    await mkdir(replay, { recursive: true });
    await git(replay, ['init', '-b', 'main']);
    await git(replay, ['fetch', seed.dir, seed.sha]);
    await git(replay, [
      'fetch',
      bundleFile,
      '+refs/heads/*:refs/remotes/bundle/*',
    ]);

    const chain = (
      await git(replay, ['log', '--reverse', '--format=%H %s', `${seed.sha}..${v2}`])
    ).stdout.trim();
    expect(chain).toBe(`${v1} Version one\n${v2} Version two`);
    expect((await git(replay, ['show', `${v2}:index.html`])).stdout).toBe(
      'v2 content\n',
    );
    expect((await git(replay, ['show', `${v2}:added.txt`])).stdout).toBe(
      'new file\n',
    );
  });

  it('anchors a non-seeded export at the baseline commit', async () => {
    const context = await makeContext();
    const { chatId } = (await (await postChat(context, {})).json()) as {
      chatId: string;
    };
    const workspaceDir = context.chatStore.getWorkspaceDir(chatId)!;
    const baseline = (
      await git(workspaceDir, ['rev-list', '--max-parents=0', 'HEAD'])
    ).stdout.trim();

    const v1 = await commitVersion(context, chatId, 'Only edit', async (dir) => {
      await writeFile(path.join(dir, 'hello.txt'), 'edited\n');
    });
    const versions = await listVersionIds(context, chatId);

    const exportResponse = await context.app.request(
      `/chats/${chatId}/versions/${versions[0]!.id}/export`,
      { method: 'POST' },
    );
    const bundleResult = (await exportResponse.json()) as {
      seedRef: string;
      versions: Array<{ sha: string; message: string }>;
    };
    expect(bundleResult.seedRef).toBe(baseline);
    expect(bundleResult.versions).toEqual([{ sha: v1, message: 'Only edit' }]);
  });

  it('404s for an unknown chat or a version outside the chat', async () => {
    const context = await makeContext();
    const { chatId } = (await (await postChat(context, {})).json()) as {
      chatId: string;
    };
    await commitVersion(context, chatId, 'v', async (dir) => {
      await writeFile(path.join(dir, 'hello.txt'), 'x\n');
    });

    const unknownChat = await context.app.request(
      '/chats/not-a-chat/versions/whatever/export',
      { method: 'POST' },
    );
    expect(unknownChat.status).toBe(404);

    const unknownVersion = await context.app.request(
      `/chats/${chatId}/versions/not-a-version/export`,
      { method: 'POST' },
    );
    expect(unknownVersion.status).toBe(404);

    // A version id that belongs to a DIFFERENT chat must not export here.
    const otherChat = (await (await postChat(context, {})).json()) as {
      chatId: string;
    };
    const otherCommit = await commitVersion(
      context,
      otherChat.chatId,
      'other',
      async (dir) => {
        await writeFile(path.join(dir, 'hello.txt'), 'y\n');
      },
    );
    expect(otherCommit).toBeTruthy();
    const [otherVersion] = await listVersionIds(context, otherChat.chatId);
    const crossChat = await context.app.request(
      `/chats/${chatId}/versions/${otherVersion!.id}/export`,
      { method: 'POST' },
    );
    expect(crossChat.status).toBe(404);
  });
});
