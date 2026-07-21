import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreviewService } from './preview.service';

describe('PreviewService', () => {
  let service: PreviewService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PreviewService);
    vi.useFakeTimers();
  });

  afterEach(() => {
    service.detach();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refreshes preview status and reconnects when the event stream ends', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chats/chat-1/preview' && init?.method === 'POST') {
        return jsonResponse({ status: 'ready', url: '/preview/chat-1/' });
      }
      if (url === '/api/chats/chat-1/events') {
        return new Response('');
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    service.attach('chat-1');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();

    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => String(input) === '/api/chats/chat-1/preview' && init?.method === 'POST',
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === '/api/chats/chat-1/events').length,
    ).toBeGreaterThanOrEqual(2);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
