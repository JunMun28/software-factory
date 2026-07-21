import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionService, type ConnectionSummary } from './connection.service';

const existingConnection: ConnectionSummary = {
  id: 'connection-1',
  chatId: 'chat-1',
  name: 'warehouse',
  kind: 'snowflake',
  config: {
    account: 'acme.us-east-1',
    database: 'analytics',
    schema: 'public',
    user: 'reporter',
  },
  createdAt: '2026-07-18T00:00:00.000Z',
};

const createdConnection: ConnectionSummary = {
  id: 'connection-2',
  chatId: 'chat-1',
  name: 'orders',
  kind: 'mssql',
  config: {
    host: 'sql.internal',
    port: '1433',
    database: 'orders',
    user: 'reader',
  },
  createdAt: '2026-07-18T01:00:00.000Z',
};

const otherChatConnection: ConnectionSummary = {
  ...existingConnection,
  id: 'connection-3',
  chatId: 'chat-2',
};

describe('ConnectionService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads connections through the API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ connections: [existingConnection] }));
    vi.stubGlobal('fetch', fetchMock);
    const service = TestBed.inject(ConnectionService);

    await service.load('chat-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/chats/chat-1/connections');
    expect(service.connections()).toEqual([existingConnection]);
    expect(service.error()).toBeNull();
    expect(service.loading()).toBe(false);
  });

  it('clears connection and test state when loading a different chat', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ connections: [otherChatConnection] }));
    vi.stubGlobal('fetch', fetchMock);
    const service = TestBed.inject(ConnectionService);
    service.connections.set([existingConnection]);
    service.testResults.set({ warehouse: { ok: true, latencyMs: 42 } });

    const load = service.load('chat-2');

    expect(service.connections()).toEqual([]);
    expect(service.testResults()).toEqual({});
    await load;
    expect(service.connections()).toEqual([otherChatConnection]);
  });

  it('does not append a create response after the active chat changes', async () => {
    const pending = deferredResponse();
    vi.stubGlobal('fetch', switchingFetch(pending));
    const service = TestBed.inject(ConnectionService);
    await service.load('chat-1');

    const create = service.create('chat-1', {
      name: 'orders',
      kind: 'mssql',
      host: 'sql.internal',
      database: 'orders',
      user: 'reader',
      password: 'secret',
    });
    await service.load('chat-2');
    pending.resolve(jsonResponse(createdConnection, 201));

    await expect(create).resolves.toEqual({ ok: true, connection: createdConnection });
    expect(service.connections()).toEqual([otherChatConnection]);
  });

  it('does not remove a same-named connection after the active chat changes', async () => {
    const pending = deferredResponse();
    vi.stubGlobal('fetch', switchingFetch(pending));
    const service = TestBed.inject(ConnectionService);
    await service.load('chat-1');

    const remove = service.remove('chat-1', existingConnection.name);
    await service.load('chat-2');
    pending.resolve(new Response(null, { status: 204 }));

    await expect(remove).resolves.toEqual({ ok: true });
    expect(service.connections()).toEqual([otherChatConnection]);
  });

  it('does not store a test response after the active chat changes', async () => {
    const pending = deferredResponse();
    vi.stubGlobal('fetch', switchingFetch(pending));
    const service = TestBed.inject(ConnectionService);
    await service.load('chat-1');

    const test = service.test('chat-1', existingConnection.name);
    await service.load('chat-2');
    pending.resolve(jsonResponse({ ok: true, latencyMs: 42 }));

    await test;
    expect(service.testResults()).toEqual({});
  });

  it('creates and appends a connection without persisting its password in signals', async () => {
    const password = 'super-secret-password';
    const payload = {
      name: 'orders',
      kind: 'mssql',
      host: 'sql.internal',
      port: '1433',
      database: 'orders',
      user: 'reader',
      password,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(createdConnection, 201));
    vi.stubGlobal('fetch', fetchMock);
    const service = TestBed.inject(ConnectionService);
    service.connections.set([existingConnection]);

    const result = await service.create('chat-1', payload);

    expect(fetchMock).toHaveBeenCalledWith('/api/chats/chat-1/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(result).toEqual({ ok: true, connection: createdConnection });
    expect(service.connections()).toEqual([existingConnection, createdConnection]);
    expect(
      JSON.stringify({
        connections: service.connections(),
        loading: service.loading(),
        error: service.error(),
        testResults: service.testResults(),
        testingName: service.testingName(),
        deletingName: service.deletingName(),
      }),
    ).not.toContain(password);
  });

  it('returns structured validation errors without mutating connections', async () => {
    const errors = [{ path: 'host', message: 'Host is required' }];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ errors }, 422));
    vi.stubGlobal('fetch', fetchMock);
    const service = TestBed.inject(ConnectionService);
    service.connections.set([existingConnection]);

    const result = await service.create('chat-1', {
      name: 'orders',
      kind: 'mssql',
      host: '',
      database: 'orders',
      user: 'reader',
      password: 'secret',
    });

    expect(result).toEqual({ ok: false, errors });
    expect(service.connections()).toEqual([existingConnection]);
  });

  it('removes a connection after a successful delete', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = TestBed.inject(ConnectionService);
    service.connections.set([existingConnection, createdConnection]);

    const result = await service.remove('chat-1', existingConnection.name);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chats/chat-1/connections/warehouse',
      { method: 'DELETE' },
    );
    expect(result).toEqual({ ok: true });
    expect(service.connections()).toEqual([createdConnection]);
    expect(service.deletingName()).toBeNull();
  });

  it('stores a successful connection test result by name', async () => {
    const testResult = { ok: true, latencyMs: 42 };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(testResult));
    vi.stubGlobal('fetch', fetchMock);
    const service = TestBed.inject(ConnectionService);

    await service.test('chat-1', existingConnection.name);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chats/chat-1/connections/warehouse/test',
      { method: 'POST' },
    );
    expect(service.testResults()[existingConnection.name]).toEqual(testResult);
    expect(service.testingName()).toBeNull();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function switchingFetch(pending: { promise: Promise<Response> }) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method) {
      return pending.promise;
    }
    const connections = String(input).includes('/chat-1/')
      ? [existingConnection]
      : [otherChatConnection];
    return Promise.resolve(jsonResponse({ connections }));
  });
}
