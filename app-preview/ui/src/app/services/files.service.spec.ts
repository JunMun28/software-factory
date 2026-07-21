import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesService } from './files.service';

describe('FilesService file details', () => {
  let service: FilesService;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({});
    service = TestBed.inject(FilesService);
    service.attach('chat-1');
  });

  afterEach(() => {
    service.detach();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads unchanged file content through the API proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ path: 'backend/app/__init__.py', content: 'app content' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await service.selectFile('backend/app/__init__.py', 'unchanged');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chats/chat-1/files/content?path=backend%2Fapp%2F__init__.py',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(service.fileContent()).toBe('app content');
  });

  it('loads changed file diffs through the API proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ path: 'frontend/src/app/app.ts', diff: '@@ -1 +1 @@' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await service.selectFile('frontend/src/app/app.ts', 'modified');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chats/chat-1/files/diff?path=frontend%2Fsrc%2Fapp%2Fapp.ts',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(service.fileDiff()).toBe('@@ -1 +1 @@');
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
