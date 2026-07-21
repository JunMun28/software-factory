import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TurnState } from '../models/turn';
import type { OrchestratorEvent } from '../types/orchestrator-events';
import { ChatService } from './chat.service';
import { ModelService } from './model.service';

describe('ChatService', () => {
  let service: ChatService;
  let router: Router;

  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    service = TestBed.inject(ChatService);
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reuses the active untitled idle chat without posting a new chat', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    service.chats.set([
      { chatId: 'draft-1', projectId: 'project-1', title: null, status: 'idle', versions: [] },
    ]);
    service.activeChatId.set('draft-1');
    service.error.set('A previous create failed');

    await expect(service.createChat()).resolves.toBe('draft-1');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/chats', 'draft-1']);
    expect(service.error()).toBeNull();
  });

  it('shows the newest visible chat first', () => {
    service.chats.set([
      {
        chatId: 'oldest',
        projectId: 'project-1',
        title: 'Oldest chat',
        status: 'idle',
        versions: [],
      },
      {
        chatId: 'middle',
        projectId: 'project-1',
        title: 'Middle chat',
        status: 'idle',
        versions: [],
      },
      {
        chatId: 'latest',
        projectId: 'project-1',
        title: 'Latest chat',
        status: 'running',
        versions: [],
      },
    ]);

    expect(service.visibleChats().map((chat) => chat.chatId)).toEqual([
      'latest',
      'middle',
      'oldest',
    ]);
  });

  it('reuses an empty chat elsewhere in the list instead of creating another', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    service.chats.set([
      {
        chatId: 'used-chat',
        projectId: 'project-1',
        title: 'Build a dashboard',
        status: 'idle',
        versions: [],
      },
      { chatId: 'draft-1', projectId: 'project-1', title: null, status: 'idle', versions: [] },
    ]);
    service.activeChatId.set('used-chat');

    await expect(service.createChat()).resolves.toBe('draft-1');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/chats', 'draft-1']);
  });

  it('creates exactly one new chat in the selected project', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ chatId: 'new-chat' }, 201);
      }
      return jsonResponse([
        {
          chatId: 'used-chat',
          projectId: 'project-42',
          title: 'Build a dashboard',
          status: 'idle',
          versions: [],
        },
        { chatId: 'new-chat', projectId: 'project-42', title: null, status: 'idle', versions: [] },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);
    service.chats.set([
      {
        chatId: 'used-chat',
        projectId: 'project-42',
        title: 'Build a dashboard',
        status: 'idle',
        versions: [],
      },
    ]);
    service.activeChatId.set('used-chat');

    await expect(service.createChat('project-42')).resolves.toBe('new-chat');

    const postCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]).toEqual([
      '/api/chats',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'project-42' }),
      },
    ]);
    expect(router.navigate).toHaveBeenCalledWith(['/chats', 'new-chat']);
  });

  it('suppresses a second create while the first request is in flight', async () => {
    let resolveCreate!: (response: Response) => void;
    const createResponse = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return createResponse;
      }
      return Promise.resolve(
        jsonResponse([
          {
            chatId: 'new-chat',
            projectId: 'local-workspace',
            title: null,
            status: 'idle',
            versions: [],
          },
        ]),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = service.createChat();
    const second = service.createChat();

    await expect(second).resolves.toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);

    resolveCreate(jsonResponse({ chatId: 'new-chat' }, 201));
    await expect(first).resolves.toBe('new-chat');
  });

  it('createSeededChat posts the seed and returns the new chatId', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ chatId: 'seeded-1' }, 201);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await service.createSeededChat({
      title: 'REQ-2136 preview edits',
      seed: { kind: 'git', url: 'git://api:9418/req-2136', ref: 'deadbeef' },
    });

    expect(result).toEqual({ chatId: 'seeded-1' });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/api/chats');
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
      title: 'REQ-2136 preview edits',
      seed: { kind: 'git', url: 'git://api:9418/req-2136', ref: 'deadbeef' },
    });
  });

  it('createSeededChat returns the gate output when the seed is red (422)', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ error: 'Seed gate failed', gateOutput: 'FAILED test_home' }, 422);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await service.createSeededChat({
      title: 'REQ-2136 preview edits',
      seed: { kind: 'git', url: 'git://api:9418/req-2136', ref: 'deadbeef' },
    });

    expect(result).toEqual({ error: 'Seed gate failed', gateOutput: 'FAILED test_home' });
  });

  it('sends the selected runtime model with a turn', async () => {
    const modelService = TestBed.inject(ModelService);
    modelService.models.set([{ id: 'openai/gpt-5.4', provider: 'openai', name: 'gpt-5.4' }]);
    modelService.selectModel('openai/gpt-5.4');
    service.chats.set([
      {
        chatId: 'chat-1',
        projectId: 'project-1',
        title: 'Model test',
        status: 'idle',
        versions: [],
      },
    ]);
    service.activeChatId.set('chat-1');

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chats/chat-1/turns' && init?.method === 'POST') {
        return new Response('', { status: 200 });
      }
      if (url === '/api/chats/chat-1') {
        return jsonResponse({
          chatId: 'chat-1',
          title: 'Model test',
          status: 'idle',
          versions: [],
        });
      }
      if (url === '/api/chats') {
        return jsonResponse([
          { chatId: 'chat-1', title: 'Model test', status: 'idle', versions: [] },
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await service.sendTurn('chat-1', 'Build with the selected model');

    const post = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === '/api/chats/chat-1/turns' && init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      prompt: 'Build with the selected model',
      model: 'openai/gpt-5.4',
    });
  });

  it('lists versions and loads a historical per-file diff from the exact endpoints', async () => {
    const versions = [
      {
        id: 'version-1',
        seq: 1,
        commit: 'abcdef123456',
        message: 'Initial dashboard',
        restoredFromVersionId: null,
        createdAt: '2026-07-16T08:00:00.000Z',
      },
    ];
    const files = [
      {
        path: 'src/app.ts',
        status: 'modified' as const,
        diff: '@@ -1 +1 @@\n-old\n+new',
      },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/chats/chat-1/versions') {
        return jsonResponse(versions);
      }
      if (url === '/api/chats/chat-1/versions/version-1/diff') {
        return jsonResponse({ files });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.loadVersions('chat-1')).resolves.toEqual(versions);
    await expect(service.loadVersionDiff('chat-1', 'version-1')).resolves.toEqual(files);

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/chats/chat-1/versions');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/chats/chat-1/versions/version-1/diff');
  });

  it('restores a version and refreshes the active chat and turn history', async () => {
    service.setActiveChat('chat-1');
    const restoredVersion = {
      id: 'version-3',
      seq: 3,
      commit: 'restored123',
      message: 'Restore v1',
      restoredFromVersionId: 'version-1',
      createdAt: '2026-07-16T09:00:00.000Z',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chats/chat-1/versions/version-1/restore') {
        expect(init?.method).toBe('POST');
        return jsonResponse(restoredVersion, 201);
      }
      if (url === '/api/chats/chat-1') {
        return jsonResponse({
          chatId: 'chat-1',
          projectId: 'local-workspace',
          title: 'Restored chat',
          status: 'idle',
          turnRunning: false,
          runningGenerationId: null,
          versions: [{ commit: restoredVersion.commit, message: restoredVersion.message }],
        });
      }
      if (url === '/api/chats/chat-1/turns') {
        return jsonResponse({ turns: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.restoreVersion('chat-1', 'version-1')).resolves.toEqual(restoredVersion);

    expect(fetchMock).toHaveBeenCalledWith('/api/chats/chat-1/versions/version-1/restore', {
      method: 'POST',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/chats/chat-1');
    expect(fetchMock).toHaveBeenCalledWith('/api/chats/chat-1/turns');
  });

  it('forks a version, refreshes the chat list, and navigates to the returned chat', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chats/chat-1/versions/version-1/fork') {
        expect(init?.method).toBe('POST');
        return jsonResponse({ chatId: 'forked-chat' }, 201);
      }
      if (url === '/api/chats') {
        return jsonResponse([
          {
            chatId: 'forked-chat',
            projectId: 'local-workspace',
            title: 'Fork of Dashboard',
            status: 'idle',
            versions: [],
          },
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.forkVersion('chat-1', 'version-1')).resolves.toBe('forked-chat');

    expect(fetchMock).toHaveBeenCalledWith('/api/chats/chat-1/versions/version-1/fork', {
      method: 'POST',
    });
    expect(router.navigate).toHaveBeenCalledWith(['/chats', 'forked-chat']);
    expect(service.chats()[0]?.chatId).toBe('forked-chat');
  });

  it('renames a chat through PATCH and immediately updates every local title surface', async () => {
    service.chats.set([
      {
        chatId: 'chat-1',
        projectId: 'local-workspace',
        title: 'Old title',
        status: 'idle',
        versions: [],
      },
    ]);
    service.setActiveChat('chat-1');
    const updated = {
      chatId: 'chat-1',
      projectId: 'local-workspace',
      title: 'New title',
      status: 'idle' as const,
      versions: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(updated));
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.renameChat('chat-1', '  New title  ')).resolves.toEqual(updated);

    expect(fetchMock).toHaveBeenCalledWith('/api/chats/chat-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New title' }),
    });
    expect(service.activeChat()?.title).toBe('New title');
    expect(service.visibleChats()[0]?.title).toBe('New title');
  });

  it('deletes a chat through DELETE, removes it locally, and navigates home', async () => {
    service.chats.set([
      {
        chatId: 'chat-1',
        projectId: 'local-workspace',
        title: 'Disposable chat',
        status: 'idle',
        versions: [],
      },
    ]);
    service.setActiveChat('chat-1');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.deleteChat('chat-1')).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith('/api/chats/chat-1', { method: 'DELETE' });
    expect(service.chats()).toEqual([]);
    expect(service.activeChatId()).toBeNull();
    expect(router.navigate).toHaveBeenCalledWith(['/']);
  });

  it('handles a running-chat delete conflict without removing or navigating', async () => {
    service.chats.set([
      {
        chatId: 'chat-1',
        projectId: 'local-workspace',
        title: 'Running chat',
        status: 'running',
        versions: [],
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.deleteChat('chat-1')).resolves.toBe(false);

    expect(service.chats()).toHaveLength(1);
    expect(service.notice()).toBe('Wait for the running turn to finish before deleting this chat.');
    expect(router.navigate).not.toHaveBeenCalledWith(['/']);
  });

  it('hydrates a running turn and subscribes to its replay stream', async () => {
    service.setActiveChat('chat-1');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/chats/chat-1') {
        return jsonResponse({
          chatId: 'chat-1',
          projectId: 'project-1',
          title: 'Live generation',
          status: 'running',
          turnRunning: true,
          runningGenerationId: 'generation-7',
          versions: [],
        });
      }
      if (url === '/api/chats/chat-1/turns') {
        return jsonResponse({
          turns: [runningTurn('generation-7', 'Build a live dashboard')],
        });
      }
      if (url === '/api/chats/chat-1/generations/generation-7/events?since=0') {
        return new Response('');
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await service.hydrateChat('chat-1');
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chats/chat-1/generations/generation-7/events?since=0',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    expect(service.turnRunning()).toBe(true);
    expect(service.activeTurns()).toHaveLength(1);
    expect(service.activeTurns()[0]).toMatchObject({
      generationId: 'generation-7',
      prompt: 'Build a live dashboard',
      running: true,
    });

    service.setActiveChat('another-chat');
    expect(service.turnRunning()).toBe(false);
  });

  it('coalesces three narration events into a single turns-signal update', async () => {
    service.chats.set([
      {
        chatId: 'chat-1',
        projectId: 'project-1',
        title: 'Narration batching',
        status: 'idle',
        versions: [],
      },
    ]);
    service.setActiveChat('chat-1');
    const updateTurnSpy = vi.spyOn(
      service as unknown as {
        updateTurn: (
          chatId: string,
          turnIndex: number,
          updater: (turn: TurnState) => TurnState,
        ) => void;
      },
      'updateTurn',
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chats/chat-1/turns' && init?.method === 'POST') {
        return sseResponse([
          [1, { type: 'turn-started', chatId: 'chat-1', turnId: 'turn-123' }],
          [2, { type: 'narration', text: 'One ' }],
          [3, { type: 'narration', text: 'two ' }],
          [4, { type: 'narration', text: 'three' }],
        ]);
      }
      if (url === '/api/chats/chat-1') {
        return jsonResponse({
          chatId: 'chat-1',
          projectId: 'project-1',
          title: 'Narration batching',
          status: 'idle',
          turnRunning: false,
          runningGenerationId: null,
          versions: [],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await service.sendTurn('chat-1', 'Batch the narration');
    await flushMicrotasks();

    expect(updateTurnSpy).toHaveBeenCalledTimes(2);
    expect(service.activeTurns()[0]?.narration).toBe('One two three');
  });

  it('applies a buffered narration delta before a turn-finished event that follows it', async () => {
    service.chats.set([
      {
        chatId: 'chat-1',
        projectId: 'project-1',
        title: 'Narration ordering',
        status: 'idle',
        versions: [],
      },
    ]);
    service.setActiveChat('chat-1');
    const handleEventSideEffectsSpy = vi.spyOn(
      service as unknown as {
        handleEventSideEffects: (chatId: string, event: OrchestratorEvent) => void;
      },
      'handleEventSideEffects',
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chats/chat-1/turns' && init?.method === 'POST') {
        return sseResponse([
          [1, { type: 'turn-started', chatId: 'chat-1', turnId: 'turn-123' }],
          [2, { type: 'narration', text: 'Hello' }],
          [3, { type: 'turn-finished', turnId: 'turn-123', result: 'green' }],
        ]);
      }
      if (url === '/api/chats/chat-1') {
        return jsonResponse({
          chatId: 'chat-1',
          projectId: 'project-1',
          title: 'Narration ordering',
          status: 'idle',
          turnRunning: false,
          runningGenerationId: null,
          versions: [],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await service.sendTurn('chat-1', 'Preserve narration ordering');
    await flushMicrotasks();

    expect(handleEventSideEffectsSpy.mock.calls.map(([, event]) => event.type)).toEqual([
      'turn-started',
      'narration',
      'turn-finished',
    ]);
    expect(service.activeTurns()[0]?.narration).toBe('Hello');
    expect(service.activeTurns()[0]?.running).toBe(false);
    expect(service.activeTurns()[0]?.result).toBe('green');
  });

  it('resumes replay from the last event id without duplicating narration', async () => {
    vi.useFakeTimers();
    service.setActiveChat('chat-1');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/chats/chat-1') {
        return jsonResponse({
          chatId: 'chat-1',
          projectId: 'project-1',
          title: 'Replay test',
          status: 'running',
          turnRunning: true,
          runningGenerationId: 'generation-8',
          versions: [],
        });
      }
      if (url === '/api/chats/chat-1/turns') {
        return jsonResponse({ turns: [runningTurn('generation-8', 'Replay me')] });
      }
      if (url === '/api/chats/chat-1/generations/generation-8/events?since=0') {
        return sseResponse([
          [1, { type: 'turn-started', chatId: 'chat-1', turnId: 'generation-8' }],
          [2, { type: 'narration', text: 'Hello' }],
        ]);
      }
      if (url === '/api/chats/chat-1/generations/generation-8/events?since=2') {
        return sseResponse([
          [2, { type: 'narration', text: 'Hello' }],
          [3, { type: 'narration', text: ' world' }],
          [4, { type: 'turn-finished', turnId: 'generation-8', result: 'green' }],
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await service.hydrateChat('chat-1');
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(300);
      await flushMicrotasks();

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chats/chat-1/generations/generation-8/events?since=2',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(service.activeTurns()[0]?.narration).toBe('Hello world');
      expect(service.activeTurns()[0]?.running).toBe(false);
    } finally {
      service.setActiveChat('another-chat');
      vi.useRealTimers();
    }
  });

  it('carries the POST stream sequence onto the server generation id when reattaching', async () => {
    service.setActiveChat('chat-1');
    service.chats.set([
      {
        chatId: 'chat-1',
        projectId: 'project-1',
        title: 'Handoff test',
        status: 'idle',
        versions: [],
      },
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chats/chat-1/turns' && init?.method === 'POST') {
        return sseResponse([
          [1, { type: 'turn-started', chatId: 'chat-1', turnId: 'turn-123' }],
          [2, { type: 'narration', text: 'From the POST stream' }],
        ]);
      }
      if (url === '/api/chats/chat-1') {
        return jsonResponse({
          chatId: 'chat-1',
          projectId: 'project-1',
          title: 'Handoff test',
          status: 'running',
          turnRunning: true,
          runningGenerationId: 'generation-123',
          versions: [],
        });
      }
      if (url === '/api/chats/chat-1/generations/generation-123/events?since=2') {
        return sseResponse([[3, { type: 'turn-finished', turnId: 'turn-123', result: 'green' }]]);
      }
      if (url === '/api/chats') {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await service.sendTurn('chat-1', 'Continue after disconnect');
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chats/chat-1/generations/generation-123/events?since=2',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    await vi.waitFor(() => {
      expect(service.activeTurns()[0]?.running).toBe(false);
    });

    expect(service.activeTurns()[0]?.generationId).toBe('generation-123');
    expect(service.activeTurns()[0]?.narration).toBe('From the POST stream');
  });

  it('treats a 409 as a notice and attaches to the server turn instead of adding a red turn', async () => {
    service.setActiveChat('chat-1');
    service.chats.set([
      {
        chatId: 'chat-1',
        projectId: 'project-1',
        title: 'Existing chat',
        status: 'idle',
        versions: [],
      },
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chats/chat-1/turns' && init?.method === 'POST') {
        return new Response('', { status: 409 });
      }
      if (url === '/api/chats/chat-1') {
        return jsonResponse({
          chatId: 'chat-1',
          projectId: 'project-1',
          title: 'Existing chat',
          status: 'running',
          turnRunning: true,
          runningGenerationId: 'generation-9',
          versions: [],
        });
      }
      if (url === '/api/chats/chat-1/turns') {
        return jsonResponse({ turns: [runningTurn('generation-9', 'Server prompt')] });
      }
      if (url === '/api/chats/chat-1/generations/generation-9/events?since=0') {
        return new Response('');
      }
      if (url === '/api/chats') {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await service.sendTurn('chat-1', 'Colliding prompt');

    expect(service.notice()).toBe('A turn is already running for this chat');
    expect(service.error()).toBeNull();
    expect(service.activeTurns()).toHaveLength(1);
    expect(service.activeTurns()[0]).toMatchObject({
      prompt: 'Server prompt',
      running: true,
    });
    expect(service.activeTurns()[0]?.gate).toBeUndefined();
    expect(service.activeTurns()[0]?.result).toBeUndefined();

    service.setActiveChat('another-chat');
  });
});

function runningTurn(generationId: string, prompt: string) {
  return {
    turn_number: 1,
    generationId,
    prompt,
    narration: 'Working from the server.',
    result: 'running',
    gate_output_tail: null,
    started_at: '2026-07-16T08:00:00.000Z',
    finished_at: null,
    version_commit: null,
    version_message: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(events: Array<[number, object]>): Response {
  const body = events
    .map(
      ([id, event]) =>
        `id: ${id}\nevent: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
