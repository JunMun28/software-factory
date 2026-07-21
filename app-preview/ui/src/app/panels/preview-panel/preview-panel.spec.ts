import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatService } from '../../services/chat.service';
import { PreviewService } from '../../services/preview.service';
import type { PreviewStatus } from '../../types/orchestrator-events';
import { PreviewPanel } from './preview-panel';

describe('PreviewPanel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes an element update API for optimistic Design mode changes', () => {
    const prototype = PreviewPanel.prototype as unknown as Record<string, unknown>;

    expect(typeof prototype['updateElement']).toBe('function');
  });

  it('exposes a transient hover API for the layer tree', () => {
    const prototype = PreviewPanel.prototype as unknown as Record<string, unknown>;

    expect(typeof prototype['hoverElement']).toBe('function');
  });

  it('offers a restart when preview startup exceeds 30 seconds and clears it when ready', async () => {
    vi.useFakeTimers();
    const chatService = {
      activeChatId: signal<string | null>('chat-1'),
      activeChat: signal({
        chatId: 'chat-1',
        projectId: 'local-workspace',
        title: 'Dashboard',
        status: 'running' as const,
        versions: [],
      }),
      currentTurnTouchedFiles: signal<Record<string, 'created' | 'modified' | 'deleted'>>({
        'frontend/src/app/app.ts': 'modified',
      }),
      previewReloadTick: signal(0),
    };
    const previewService = {
      status: signal<PreviewStatus>({ status: 'starting' }),
      attach: vi.fn(),
      detach: vi.fn(),
      restart: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [PreviewPanel],
      providers: [
        { provide: ChatService, useValue: chatService },
        { provide: PreviewService, useValue: previewService },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(PreviewPanel);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain(
      'The preview is taking longer than expected.',
    );

    vi.advanceTimersByTime(30_000);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'The preview is taking longer than expected.',
    );
    const restartButton: HTMLButtonElement = fixture.nativeElement.querySelector('button');
    expect(restartButton.textContent).toContain('Restart preview');
    restartButton.click();
    expect(previewService.restart).toHaveBeenCalledOnce();

    previewService.status.set({ status: 'stopped' });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'The preview is taking longer than expected.',
    );

    previewService.status.set({ status: 'ready', url: 'http://localhost:1234' });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain(
      'The preview is taking longer than expected.',
    );
  });

  it('hides the golden template until generated frontend files exist', async () => {
    const chatService = {
      activeChatId: signal<string | null>('chat-1'),
      activeChat: signal({
        chatId: 'chat-1',
        projectId: 'local-workspace',
        title: 'Dashboard',
        status: 'running' as const,
        versions: [],
      }),
      currentTurnTouchedFiles: signal<Record<string, 'created' | 'modified' | 'deleted'>>(
        {},
      ),
      previewReloadTick: signal(0),
    };
    const previewService = {
      status: signal<PreviewStatus>({ status: 'ready', url: 'http://localhost:1234' }),
      attach: vi.fn(),
      detach: vi.fn(),
      restart: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [PreviewPanel],
      providers: [
        { provide: ChatService, useValue: chatService },
        { provide: PreviewService, useValue: previewService },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(PreviewPanel);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Your app will appear here');
    expect(fixture.nativeElement.querySelector('iframe')).toBeNull();

    chatService.currentTurnTouchedFiles.set({ 'backend/app/main.py': 'modified' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('iframe')).toBeNull();

    chatService.currentTurnTouchedFiles.set({
      'backend/app/main.py': 'modified',
      'frontend/src/app/app.ts': 'modified',
    });
    fixture.detectChanges();
    const iframe: HTMLIFrameElement = fixture.nativeElement.querySelector('iframe');
    const readyStatus: HTMLElement = fixture.nativeElement.querySelector(
      '[data-preview-status="ready"]',
    );
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-same-origin');
    expect(readyStatus.getAttribute('role')).toBe('status');
    expect(readyStatus.getAttribute('aria-live')).toBe('polite');

    chatService.previewReloadTick.set(1);
    fixture.detectChanges();
    const reloadedIframe: HTMLIFrameElement = fixture.nativeElement.querySelector('iframe');
    expect(reloadedIframe.src).toContain('ng-preview=1');
    expect(reloadedIframe.getAttribute('sandbox')).toBe(
      'allow-scripts allow-forms allow-same-origin',
    );

    previewService.status.set({ status: 'failed', error: 'Preview process exited' });
    fixture.detectChanges();
    const failedStatus: HTMLElement = fixture.nativeElement.querySelector(
      '[data-preview-status="failed"]',
    );
    expect(failedStatus.getAttribute('role')).toBe('status');
    expect(failedStatus.getAttribute('aria-live')).toBe('assertive');
    expect(failedStatus.textContent).toContain('Preview process exited');
  });

  it('keeps the loaded iframe mounted while the preview starts updating', async () => {
    vi.useFakeTimers();
    const { fixture, previewService } = await createReadyPreviewFixture();
    const iframeBefore: HTMLIFrameElement = fixture.nativeElement.querySelector('iframe');
    const srcBefore = iframeBefore.src;

    previewService.status.set({ status: 'starting' });
    fixture.detectChanges();

    const iframeDuringUpdate: HTMLIFrameElement =
      fixture.nativeElement.querySelector('iframe');
    const updatingStatus: HTMLElement = fixture.nativeElement.querySelector(
      '[data-preview-updating]',
    );
    expect(iframeDuringUpdate).toBe(iframeBefore);
    expect(iframeDuringUpdate.src).toBe(srcBefore);
    expect(updatingStatus).toBeTruthy();
    expect(updatingStatus.textContent).toContain('Updating preview…');
    expect(
      fixture.nativeElement.querySelector('[data-preview-status="ready"]'),
    ).toBeNull();

    vi.advanceTimersByTime(30_000);
    fixture.detectChanges();

    const slowUpdatingStatus: HTMLElement = fixture.nativeElement.querySelector(
      '[data-preview-updating]',
    );
    const restartButton = slowUpdatingStatus.querySelector('button');
    expect(slowUpdatingStatus.textContent).toContain(
      'The preview is taking longer than expected.',
    );
    expect(restartButton?.textContent).toContain('Restart preview');
  });

  it('removes the loaded iframe when the preview fails', async () => {
    const { fixture, previewService } = await createReadyPreviewFixture();

    expect(fixture.nativeElement.querySelector('iframe')).toBeTruthy();

    previewService.status.set({ status: 'failed', error: 'Preview process exited' });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('iframe')).toBeNull();
    expect(fixture.componentInstance.iframeSrc()).toBeNull();
  });

  it('removes the previous preview when switching chats through stopped', async () => {
    const { fixture, chatService, previewService } = await createReadyPreviewFixture();
    const previousIframe: HTMLIFrameElement = fixture.nativeElement.querySelector('iframe');

    expect(previousIframe.src).toContain('http://localhost:1234');

    chatService.activeChatId.set('chat-2');
    chatService.activeChat.set({
      chatId: 'chat-2',
      projectId: 'local-workspace',
      title: 'Second dashboard',
      status: 'running' as const,
      versions: [],
    });
    previewService.status.set({ status: 'stopped' });
    fixture.detectChanges();

    expect(previewService.attach).toHaveBeenLastCalledWith('chat-2');
    expect(fixture.nativeElement.querySelector('iframe')).toBeNull();
    expect(fixture.componentInstance.iframeSrc()).toBeNull();
  });
});

async function createReadyPreviewFixture() {
  const chatService = {
    activeChatId: signal<string | null>('chat-1'),
    activeChat: signal({
      chatId: 'chat-1',
      projectId: 'local-workspace',
      title: 'Dashboard',
      status: 'running' as const,
      versions: [],
    }),
    currentTurnTouchedFiles: signal<Record<string, 'created' | 'modified' | 'deleted'>>({
      'frontend/src/app/app.ts': 'modified',
    }),
    previewReloadTick: signal(0),
  };
  const previewService = {
    status: signal<PreviewStatus>({ status: 'ready', url: 'http://localhost:1234' }),
    attach: vi.fn(),
    detach: vi.fn(),
    restart: vi.fn(),
  };
  await TestBed.configureTestingModule({
    imports: [PreviewPanel],
    providers: [
      { provide: ChatService, useValue: chatService },
      { provide: PreviewService, useValue: previewService },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(PreviewPanel);
  fixture.detectChanges();

  return { fixture, chatService, previewService };
}
