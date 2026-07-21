import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { ChatService } from '../../services/chat.service';
import { WorkspaceShellService } from '../../services/workspace-shell.service';
import type { ChatVersion } from '../../types/orchestrator-events';
import { ChatConversation } from './chat-conversation';

describe('ChatConversation', () => {
  it('exposes the activity stream as a polite log and errors assertively', async () => {
    await TestBed.configureTestingModule({
      imports: [ChatConversation],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatConversation);
    const chatService = TestBed.inject(ChatService);
    chatService.error.set('Generation failed');
    fixture.detectChanges();

    const scroller: HTMLElement = fixture.nativeElement.querySelector('[role="log"]');
    const errorElement: HTMLElement = fixture.nativeElement.querySelector('[data-chat-error]');

    expect(scroller.getAttribute('aria-live')).toBe('polite');
    expect(scroller.getAttribute('aria-relevant')).toContain('additions');
    expect(scroller.contains(errorElement)).toBe(false);
    expect(errorElement.getAttribute('role')).toBe('alert');
    expect(errorElement.getAttribute('aria-live')).toBe('assertive');
    expect(errorElement.textContent).toContain('Generation failed');
  });

  it('renders a loaded server turn as in progress and shows notices without red error styling', async () => {
    await TestBed.configureTestingModule({
      imports: [ChatConversation],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatConversation);
    const chatService = TestBed.inject(ChatService);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ turns: [runningTurnHistory('generation-1')] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    chatService.setActiveChat('chat-1');
    chatService.notice.set('A turn is already running for this chat');

    await chatService.loadTurnHistory('chat-1');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Working');
    const notice: HTMLElement = fixture.nativeElement.querySelector('[data-chat-notice]');
    expect(notice.textContent).toContain('A turn is already running for this chat');
    expect(fixture.nativeElement.querySelector('[data-chat-error]')).toBeNull();
  });

  it('hides the jump-to-latest pill while pinned to a running turn', async () => {
    await TestBed.configureTestingModule({
      imports: [ChatConversation],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatConversation);
    const chatService = TestBed.inject(ChatService);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ turns: [runningTurnHistory('generation-1')] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    chatService.setActiveChat('chat-1');

    await chatService.loadTurnHistory('chat-1');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-jump-to-latest]')).toBeNull();
  });

  it('shows the jump-to-latest pill after scrolling up during a running turn', async () => {
    await TestBed.configureTestingModule({
      imports: [ChatConversation],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatConversation);
    const chatService = TestBed.inject(ChatService);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ turns: [runningTurnHistory('generation-1')] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    chatService.setActiveChat('chat-1');
    chatService.chats.set([
      { chatId: 'chat-1', projectId: 'project-1', title: null, status: 'running', versions: [] },
    ]);

    await chatService.loadTurnHistory('chat-1');
    fixture.detectChanges();
    const scroller: HTMLDivElement = fixture.nativeElement.querySelector('[role="log"]');
    Object.defineProperties(scroller, {
      scrollTop: { configurable: true, value: 100, writable: true },
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 200 },
    });

    scroller.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-jump-to-latest]')).toBeTruthy();
  });

  it('re-pins and hides the jump-to-latest pill when clicked', async () => {
    await TestBed.configureTestingModule({
      imports: [ChatConversation],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatConversation);
    const chatService = TestBed.inject(ChatService);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ turns: [runningTurnHistory('generation-1')] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    chatService.setActiveChat('chat-1');
    chatService.chats.set([
      { chatId: 'chat-1', projectId: 'project-1', title: null, status: 'running', versions: [] },
    ]);

    await chatService.loadTurnHistory('chat-1');
    fixture.detectChanges();
    const scroller: HTMLDivElement = fixture.nativeElement.querySelector('[role="log"]');
    Object.defineProperties(scroller, {
      scrollTop: { configurable: true, value: 100, writable: true },
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 200 },
    });
    scroller.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    const jumpButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-jump-to-latest]',
    );
    jumpButton.click();
    fixture.detectChanges();

    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(fixture.nativeElement.querySelector('[data-jump-to-latest]')).toBeNull();
  });

  it('renders an inline turn version chip and keeps the modal reachable via shared shell state', async () => {
    await TestBed.configureTestingModule({
      imports: [ChatConversation],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatConversation);
    const chatService = TestBed.inject(ChatService);
    const shell = TestBed.inject(WorkspaceShellService);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/chats/chat-1/turns') {
          return new Response(JSON.stringify({ turns: [versionedTurnHistory()] }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === '/api/chats/chat-1/versions') {
          return new Response(
            JSON.stringify([
              {
                id: 'version-1',
                seq: 1,
                commit: 'abcdef123456',
                message: 'Dashboard version',
                restoredFromVersionId: null,
                createdAt: '2026-07-16T08:00:00.000Z',
                diffStat: { additions: 12, deletions: 3 },
                files: [{ path: 'src/app/home.ts', status: 'modified' }],
              },
            ]),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    chatService.setActiveChat('chat-1');
    await chatService.loadTurnHistory('chat-1');
    await chatService.loadVersions('chat-1');
    fixture.detectChanges();

    const chip: HTMLElement = fixture.nativeElement.querySelector('[data-version-chip]');
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain('Dashboard version');
    expect(chip.textContent).toContain('v1');
    expect(chip.textContent).toContain('+12');

    shell.openVersionHistory();
    fixture.detectChanges();

    const dialog: HTMLElement = fixture.nativeElement.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog.hasAttribute('focustrap')).toBe(true);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(dialog.textContent).toContain('Version 1');
    });
  });

  it('confirms an inline version restore before restoring it', async () => {
    await TestBed.configureTestingModule({
      imports: [ChatConversation],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatConversation);
    const chatService = TestBed.inject(ChatService);
    const version: ChatVersion = {
      id: 'version-1',
      seq: 1,
      commit: 'abcdef123456',
      message: 'Dashboard version',
      restoredFromVersionId: null,
      createdAt: '2026-07-16T08:00:00.000Z',
      diffStat: { additions: 12, deletions: 3 },
      files: [{ path: 'src/app/home.ts', status: 'modified' }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/chats/chat-1/turns') {
          return new Response(JSON.stringify({ turns: [versionedTurnHistory()] }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === '/api/chats/chat-1/versions') {
          return new Response(JSON.stringify([version]), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    chatService.setActiveChat('chat-1');
    await chatService.loadTurnHistory('chat-1');
    await chatService.loadVersions('chat-1');
    const restoreSpy = vi.spyOn(chatService, 'restoreVersion').mockResolvedValue(version);
    fixture.detectChanges();

    const restoreButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-version-restore]',
    );
    restoreButton.click();
    fixture.detectChanges();

    const dialog: HTMLElement = fixture.nativeElement.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('Restore this version?');

    const confirmButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-confirm-dialog-confirm]',
    );
    confirmButton.click();

    await vi.waitFor(() => {
      expect(restoreSpy).toHaveBeenCalledWith('chat-1', 'version-1');
    });
  });

});

function runningTurnHistory(generationId: string) {
  return {
    turn_number: 1,
    generationId,
    prompt: 'Build while I reload',
    narration: '',
    result: 'running',
    gate_output_tail: null,
    started_at: '2026-07-16T08:00:00.000Z',
    finished_at: null,
    version_commit: null,
    version_message: null,
  };
}

function versionedTurnHistory() {
  return {
    turn_number: 1,
    generationId: 'generation-1',
    prompt: 'Build a dashboard',
    narration: 'Done.',
    result: 'green',
    gate_output_tail: null,
    started_at: '2026-07-16T08:00:00.000Z',
    finished_at: '2026-07-16T08:01:00.000Z',
    version_commit: 'abcdef123456',
    version_message: 'Dashboard version',
  };
}
