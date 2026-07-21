import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatStore } from '../src/chat-store.js';
import { git } from '../src/git.js';
import { createApp } from '../src/http/app.js';
import { PlatformDb } from '../src/platform-db.js';
import { PreviewManager } from '../src/preview-manager.js';
import type { GateRunner, OrchestratorEvent, WorkspaceProvider } from '../src/types.js';
import { FakeHarness } from './fake-harness.js';

const greenGate: GateRunner = {
  run: async () => ({ green: true, output: 'GATE GREEN' }),
};

interface SseFrame {
  event: string;
  id: string | null;
  data: OrchestratorEvent;
}

async function makeContext(events: OrchestratorEvent[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-turn-events-'));
  const workspaceDir = path.join(root, 'chat-1');
  await mkdir(workspaceDir);
  await git(workspaceDir, ['init']);
  await git(workspaceDir, ['config', 'user.email', 'test@example.com']);
  await git(workspaceDir, ['config', 'user.name', 'Test User']);
  await writeFile(path.join(workspaceDir, 'README.md'), 'baseline\n', 'utf8');
  await git(workspaceDir, ['add', 'README.md']);
  await git(workspaceDir, ['commit', '-m', 'baseline']);

  const provider: WorkspaceProvider = { create: async () => workspaceDir };
  const db = await PlatformDb.open(':memory:');
  await db.insertChat('chat-1', workspaceDir);
  const harnessEvents = events.filter(
    (event): event is Extract<
      OrchestratorEvent,
      { type: 'narration' | 'tool' | 'file-changed' }
    > =>
      event.type === 'narration' ||
      event.type === 'tool' ||
      event.type === 'file-changed',
  );
  const chatStore = new ChatStore(
    provider,
    FakeHarness.fromScripts([{ events: harnessEvents }]),
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
  return { app, chatStore, db };
}

async function parseFrames(response: Response): Promise<SseFrame[]> {
  const raw = await response.text();
  return raw
    .split('\n\n')
    .map((chunk) => chunk.split('\n'))
    .filter((lines) => lines.some((line) => line.startsWith('data:')))
    .map((lines) => {
      const event = lines.find((line) => line.startsWith('event:'));
      const id = lines.find((line) => line.startsWith('id:'));
      const data = lines.find((line) => line.startsWith('data:'));
      if (!event || !data) {
        throw new Error(`Malformed SSE frame: ${lines.join('\n')}`);
      }
      return {
        event: event.slice('event:'.length).trim(),
        id: id?.slice('id:'.length).trim() ?? null,
        data: JSON.parse(data.slice('data:'.length).trim()) as OrchestratorEvent,
      };
    });
}

describe('durable turn event streams', () => {
  it('replays only events after since and writes each sequence as the SSE id', async () => {
    const { app, db } = await makeContext();
    const generationId = await db.beginGeneration('chat-1', 'Replay me');
    await db.appendTurnEvent(generationId, {
      type: 'turn-started',
      chatId: 'chat-1',
      turnId: 'turn-1',
    });
    await db.appendTurnEvent(generationId, { type: 'narration', text: 'Second' });
    await db.appendTurnEvent(generationId, {
      type: 'turn-finished',
      turnId: 'turn-1',
      result: 'no-change',
    });
    await db.finishGeneration(generationId, 'no-change');

    const response = await app.request(
      `/chats/chat-1/generations/${generationId}/events?since=1`,
    );
    const frames = await parseFrames(response);

    expect(response.status).toBe(200);
    expect(frames.map((frame) => frame.id)).toEqual(['2', '3']);
    expect(frames.map((frame) => frame.event)).toEqual([
      'narration',
      'turn-finished',
    ]);
    expect(frames.map((frame) => frame.data.type)).toEqual([
      'narration',
      'turn-finished',
    ]);
    await db.close();
  });

  it('tags the original POST turn stream with durable sequence ids', async () => {
    const { app, db } = await makeContext([
      { type: 'narration', text: 'Live narration' },
    ]);

    const response = await app.request('/chats/chat-1/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Build it' }),
    });
    const frames = await parseFrames(response);

    expect(response.status).toBe(200);
    expect(frames.length).toBeGreaterThan(2);
    expect(frames.map((frame) => frame.id)).toEqual(
      frames.map((_, index) => String(index + 1)),
    );
    expect(frames[0]?.data).toMatchObject({ type: 'turn-started' });
    expect(frames.at(-1)?.data).toMatchObject({ type: 'turn-finished' });
    await db.close();
  });

  it('reattaches to a running generation and receives later live events', async () => {
    const { app, chatStore, db } = await makeContext([
      { type: 'narration', text: 'Arrived after attach' },
    ]);
    chatStore.beginTurn('chat-1');
    const runningTurn = chatStore.runTurn('chat-1', 'Keep going');
    const started = await runningTurn.next();
    if (started.done) {
      throw new Error('Expected a running turn');
    }

    const response = await app.request(
      `/chats/chat-1/generations/${started.value.generationId}/events?since=1`,
    );
    const framesPromise = parseFrames(response);
    for await (const _event of runningTurn) {
      // Drive the existing generation while the replay endpoint is attached.
    }
    const frames = await framesPromise;

    expect(response.status).toBe(200);
    expect(frames.map((frame) => frame.id)).toEqual(
      frames.map((_, index) => String(index + 2)),
    );
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: { type: 'narration', text: 'Arrived after attach' },
        }),
        expect.objectContaining({
          data: expect.objectContaining({ type: 'turn-finished' }),
        }),
      ]),
    );
    await db.close();
  });

  it('does not drop events finalized while an older replay frame is in flight', async () => {
    const { chatStore, db } = await makeContext();
    chatStore.beginTurn('chat-1');
    const runningTurn = chatStore.runTurn('chat-1', 'Finish during replay');
    const started = await runningTurn.next();
    if (started.done) {
      throw new Error('Expected a running turn');
    }

    const replay = chatStore.observeTurnEvents(
      'chat-1',
      started.value.generationId,
    );
    const firstReplay = await replay.next();
    expect(firstReplay.value?.seq).toBe(1);

    for await (const _event of runningTurn) {
      // Finalize while the replay consumer is paused on sequence 1.
    }

    const tail = [];
    for await (const event of replay) {
      tail.push(event);
    }

    expect(tail.map((event) => event.seq)).toEqual(
      (await db.listTurnEvents(started.value.generationId, 1)).map(
        (event) => event.seq,
      ),
    );
    expect(tail.at(-1)?.event.type).toBe('turn-finished');
    await db.close();
  });
});
