import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatService } from '../../services/chat.service';
import { VersionHistoryPanel } from './version-history-panel';

describe('VersionHistoryPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists versions and renders a requested historical per-file diff', async () => {
    const versions = [
      {
        id: 'version-2',
        seq: 2,
        commit: 'abcdef123456',
        message: 'Add dashboard cards',
        restoredFromVersionId: null,
        createdAt: '2026-07-16T08:00:00.000Z',
      },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/chats/chat-1/versions') {
        return jsonResponse(versions);
      }
      if (url === '/api/chats/chat-1/versions/version-2/diff') {
        return jsonResponse({
          files: [
            {
              path: 'src/app.ts',
              status: 'modified',
              diff: '@@ -1 +1 @@\n-old title\n+new title',
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const fixture = await createFixture();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('Version 2');
    });
    expect(fixture.nativeElement.textContent).toContain('Version 2');
    expect(fixture.nativeElement.textContent).toContain('Add dashboard cards');
    fixture.nativeElement.querySelector('[aria-label="View diff for version 2"]').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('src/app.ts');
      expect(fixture.nativeElement.textContent).toContain('+new title');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/chats/chat-1/versions/version-2/diff');
  });

  it('restores and refreshes the version list, while fork navigates to the returned chat', async () => {
    const chatService = await configure();
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const restored = {
      id: 'version-3',
      seq: 3,
      commit: 'restored123',
      message: 'Restore v1',
      restoredFromVersionId: 'version-1',
      createdAt: '2026-07-16T09:00:00.000Z',
      diffStat: null,
      files: null,
    };
    const listSpy = vi
      .spyOn(chatService, 'loadVersions')
      .mockResolvedValueOnce([{ ...restored, id: 'version-1', seq: 1, message: 'Initial version' }])
      .mockResolvedValueOnce([restored]);
    const restoreSpy = vi.spyOn(chatService, 'restoreVersion').mockResolvedValue(restored);
    const forkSpy = vi.spyOn(chatService, 'forkVersion').mockResolvedValue('forked-chat');
    const fixture = TestBed.createComponent(VersionHistoryPanel);
    fixture.componentRef.setInput('chatId', 'chat-1');
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('Version 1');
    });

    fixture.nativeElement.querySelector('[aria-label="Restore version 1"]').click();
    fixture.detectChanges();
    expect(restoreSpy).not.toHaveBeenCalled();
    fixture.nativeElement.querySelector('[data-confirm-dialog-confirm]').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(restoreSpy).toHaveBeenCalledWith('chat-1', 'version-1');
      expect(listSpy).toHaveBeenCalledTimes(2);
      expect(fixture.nativeElement.textContent).toContain('Version 3');
    });

    fixture.nativeElement.querySelector('[aria-label="Fork version 3"]').click();
    await vi.waitFor(() => {
      expect(forkSpy).toHaveBeenCalledWith('chat-1', 'version-3');
    });
  });

  async function createFixture() {
    await configure();
    const fixture = TestBed.createComponent(VersionHistoryPanel);
    fixture.componentRef.setInput('chatId', 'chat-1');
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeTruthy();
    });
    return fixture;
  }

  async function configure(): Promise<ChatService> {
    await TestBed.configureTestingModule({
      imports: [VersionHistoryPanel],
      providers: [provideRouter([])],
    }).compileComponents();
    return TestBed.inject(ChatService);
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
