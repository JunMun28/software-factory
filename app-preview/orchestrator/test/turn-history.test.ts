import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatStore } from '../src/chat-store.js';
import { createApp } from '../src/http/app.js';
import { git } from '../src/git.js';
import { PlatformDb } from '../src/platform-db.js';
import { PreviewManager } from '../src/preview-manager.js';
import type { GateRunner, WorkspaceProvider } from '../src/types.js';
import { FakeHarness } from './fake-harness.js';

const greenGate: GateRunner = {
  run: async () => ({ green: true, output: 'GATE GREEN' }),
};

describe('turn history API', () => {
  it('returns persisted assistant narration in the turn JSON shape', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-turn-history-'));
    const workspaceDir = path.join(root, 'chat-1');
    await mkdir(workspaceDir);
    const provider: WorkspaceProvider = {
      create: async () => workspaceDir,
    };
    const db = await PlatformDb.open(':memory:');
    await db.insertChat('chat-1', workspaceDir);
    const generationId = await db.beginGeneration('chat-1', 'Explain the result');
    await db.appendTurnEvent(generationId, {
      type: 'narration',
      text: 'First paragraph.\n\nSecond paragraph.',
    });
    await db.finishGeneration(generationId, 'no-change');
    const chatStore = new ChatStore(
      provider,
      FakeHarness.fromScripts([]),
      greenGate,
      db,
    );
    await chatStore.rehydrate();
    const app = createApp({
      chatStore,
      previewManager: new PreviewManager({
        workspacesRoot: root,
        previewRoot: path.join(root, 'preview'),
      }),
    });

    const response = await app.request('/chats/chat-1/turns');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      turns: [
        expect.objectContaining({
          prompt: 'Explain the result',
          narration: 'First paragraph.\n\nSecond paragraph.',
          result: 'no-change',
        }),
      ],
    });
    await db.close();
  });

  it('exposes a running generation and narration accumulated so far', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-running-turn-'));
    const workspaceDir = path.join(root, 'chat-1');
    await mkdir(workspaceDir);
    await git(workspaceDir, ['init']);
    await git(workspaceDir, ['config', 'user.email', 'test@example.com']);
    await git(workspaceDir, ['config', 'user.name', 'Test User']);
    await writeFile(path.join(workspaceDir, 'README.md'), 'baseline\n', 'utf8');
    await git(workspaceDir, ['add', 'README.md']);
    await git(workspaceDir, ['commit', '-m', 'baseline']);
    const provider: WorkspaceProvider = {
      create: async () => workspaceDir,
    };
    const db = await PlatformDb.open(':memory:');
    await db.insertChat('chat-1', workspaceDir);
    const chatStore = new ChatStore(
      provider,
      FakeHarness.fromScripts([
        { events: [{ type: 'narration', text: 'Still working' }] },
      ]),
      greenGate,
      db,
    );
    await chatStore.rehydrate();
    chatStore.beginTurn('chat-1');
    const liveTurn = chatStore.runTurn('chat-1', 'Build it');
    await liveTurn.next();
    await liveTurn.next();
    const app = createApp({
      chatStore,
      previewManager: new PreviewManager({
        workspacesRoot: root,
        previewRoot: path.join(root, 'preview'),
      }),
    });

    const turnsResponse = await app.request('/chats/chat-1/turns');
    const chatResponse = await app.request('/chats/chat-1');
    const turnsBody = (await turnsResponse.json()) as {
      turns: Array<{ generationId: string }>;
    };
    const chatBody = (await chatResponse.json()) as {
      turnRunning: boolean;
      runningGenerationId: string | null;
    };

    expect(turnsResponse.status).toBe(200);
    expect(turnsBody).toEqual({
      turns: [
        expect.objectContaining({
          generationId: expect.any(String),
          prompt: 'Build it',
          narration: 'Still working',
          result: 'running',
          finished_at: null,
        }),
      ],
    });
    expect(chatBody).toEqual(
      expect.objectContaining({
        turnRunning: true,
        runningGenerationId: turnsBody.turns[0]?.generationId,
      }),
    );

    await liveTurn.return(undefined);
    await db.close();
  });
});
