import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatStore } from '../src/chat-store.js';
import { createApp } from '../src/http/app.js';
import { PlatformDb } from '../src/platform-db.js';
import { PreviewManager } from '../src/preview-manager.js';
import type { GateRunner } from '../src/types.js';
import { LocalWorkspaceProvider } from '../src/workspace-provider.js';
import { FakeHarness } from './fake-harness.js';

const fixtureTemplate = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/template',
);

const greenGate: GateRunner = {
  run: async () => ({ green: true, output: 'GATE GREEN' }),
};

interface ProjectJson {
  id: string;
  name: string;
  isDefault: boolean;
  chatCount: number;
  createdAt: string;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

async function makeContext() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-projects-'));
  const db = await PlatformDb.open(path.join(root, 'platform.db'));
  const chatStore = new ChatStore(
    new LocalWorkspaceProvider(fixtureTemplate, path.join(root, 'workspaces')),
    FakeHarness.fromScripts([]),
    greenGate,
    db,
  );
  const app = createApp({
    chatStore,
    previewManager: new PreviewManager({
      workspacesRoot: path.join(root, 'workspaces'),
      previewRoot: path.join(root, 'preview'),
    }),
  });
  cleanup.push(async () => {
    await db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, db };
}

async function createProject(app: Awaited<ReturnType<typeof makeContext>>['app']) {
  const response = await app.request('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Client portal' }),
  });
  return {
    response,
    body: (await response.json()) as ProjectJson,
  };
}

describe('server-owned projects', () => {
  it('upgrades the old seeded project to the canonical local workspace without losing chats', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-legacy-project-'));
    const dbPath = path.join(root, 'platform.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(
      'CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    for (const file of readdirSync(path.resolve('migrations/sqlite')).sort()) {
      if (!file.endsWith('.sql')) {
        continue;
      }
      legacy.exec(readFileSync(path.resolve('migrations/sqlite', file), 'utf8'));
      legacy
        .prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
    }
    legacy
      .prepare(
        'INSERT INTO users (id, email, display_name, created_at) VALUES (?, NULL, ?, ?)',
      )
      .run('founder', 'Founder', '2026-01-01T00:00:00.000Z');
    legacy
      .prepare(
        'INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        'legacy-random-id',
        'founder',
        'Default project',
        '2026-01-01T00:00:00.000Z',
      );
    legacy
      .prepare(
        'INSERT INTO chats (id, project_id, title, workspace_ref, created_at, last_active_at) VALUES (?, ?, NULL, ?, ?, ?)',
      )
      .run(
        'chat-1',
        'legacy-random-id',
        '/tmp/workspace',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
    legacy.close();

    const upgraded = await PlatformDb.open(dbPath);

    expect(upgraded.defaultProjectId).toBe('local-workspace');
    expect(await upgraded.listProjects('founder')).toEqual([
      expect.objectContaining({
        id: 'local-workspace',
        name: 'Local workspace',
        chatCount: 1,
      }),
    ]);
    expect(await upgraded.listChats()).toEqual([
      expect.objectContaining({
        id: 'chat-1',
        project_id: 'local-workspace',
      }),
    ]);
    await upgraded.close();
    await rm(root, { recursive: true, force: true });
  });

  it('creates a project and lists the canonical default before the custom project', async () => {
    const { app } = await makeContext();

    const created = await createProject(app);
    const listResponse = await app.request('/projects');
    const projects = (await listResponse.json()) as ProjectJson[];

    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({
      id: expect.any(String),
      name: 'Client portal',
      isDefault: false,
      chatCount: 0,
      createdAt: expect.any(String),
    });
    expect(listResponse.status).toBe(200);
    expect(projects).toEqual([
      expect.objectContaining({
        id: 'local-workspace',
        name: 'Local workspace',
        isDefault: true,
        chatCount: 0,
      }),
      expect.objectContaining({
        id: created.body.id,
        name: 'Client portal',
        isDefault: false,
        chatCount: 0,
      }),
    ]);
  });

  it('persists a chat under the requested project and returns it from project details', async () => {
    const { app, db } = await makeContext();
    const project = await createProject(app);

    const createChatResponse = await app.request('/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.body.id,
        title: 'Landing page',
      }),
    });
    const createdChat = (await createChatResponse.json()) as { chatId: string };
    const chatResponse = await app.request(`/chats/${createdChat.chatId}`);
    const chat = (await chatResponse.json()) as {
      chatId: string;
      projectId: string;
      title: string;
    };
    const projectResponse = await app.request(`/projects/${project.body.id}`);
    const projectDetails = (await projectResponse.json()) as ProjectJson & {
      chats: Array<{ chatId: string; projectId: string; title: string }>;
    };

    expect(createChatResponse.status).toBe(201);
    expect(await db.listChats()).toContainEqual(
      expect.objectContaining({
        id: createdChat.chatId,
        project_id: project.body.id,
        title: 'Landing page',
      }),
    );
    expect(chatResponse.status).toBe(200);
    expect(chat).toMatchObject({
      chatId: createdChat.chatId,
      projectId: project.body.id,
      title: 'Landing page',
    });
    expect(projectResponse.status).toBe(200);
    expect(projectDetails).toMatchObject({
      id: project.body.id,
      chatCount: 1,
      chats: [
        expect.objectContaining({
          chatId: createdChat.chatId,
          projectId: project.body.id,
          title: 'Landing page',
        }),
      ],
    });
  });

  it('rejects chat creation for an unknown project', async () => {
    const { app } = await makeContext();

    const response = await app.request('/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'missing-project' }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Project not found' });
  });

  it('returns 404 for an unknown project detail', async () => {
    const { app } = await makeContext();

    const response = await app.request('/projects/missing-project');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Project not found' });
  });

  it('returns projectId from GET /chats for default and custom chats', async () => {
    const { app } = await makeContext();
    const project = await createProject(app);

    const defaultChat = await app.request('/chats', { method: 'POST' });
    const defaultBody = (await defaultChat.json()) as { chatId: string };
    const customChat = await app.request('/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.body.id }),
    });
    const customBody = (await customChat.json()) as { chatId: string };

    const response = await app.request('/chats');
    const chats = (await response.json()) as Array<{
      chatId: string;
      projectId: string;
    }>;

    expect(response.status).toBe(200);
    expect(chats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatId: defaultBody.chatId,
          projectId: 'local-workspace',
        }),
        expect.objectContaining({
          chatId: customBody.chatId,
          projectId: project.body.id,
        }),
      ]),
    );
  });

  it('rejects an empty project name', async () => {
    const { app } = await makeContext();

    const response = await app.request('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'name is required' });
  });
});
