import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from './database.service';

describe('DatabaseService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads read-only workspace database data through the API proxy', async () => {
    const body = {
      connected: true,
      engine: 'SQLite',
      path: 'backend/app.db',
      tables: [{ name: 'item', columns: [], rows: [{ id: 1, name: 'Alpha' }] }],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({});
    const service = TestBed.inject(DatabaseService);

    await service.load('chat-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/chats/chat-1/database');
    expect(service.inspection()).toEqual(body);
    expect(service.selectedTable()?.name).toBe('item');
    expect(service.error()).toBeNull();
  });
});
