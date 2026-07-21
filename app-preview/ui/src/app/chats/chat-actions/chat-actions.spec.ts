import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatService } from '../../services/chat.service';
import { ChatActions } from './chat-actions';

describe('ChatActions', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renames through the focused dialog and updates the trigger title', async () => {
    const updated = {
      chatId: 'chat-1',
      projectId: 'local-workspace',
      title: 'Renamed dashboard',
      status: 'idle' as const,
      versions: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(updated));
    vi.stubGlobal('fetch', fetchMock);
    const { fixture, chatService } = await createFixture();
    chatService.chats.set([{ ...updated, title: 'Old dashboard' }]);
    fixture.componentRef.setInput('chat', chatService.chats()[0]);
    fixture.componentRef.setInput('variant', 'title');
    fixture.detectChanges();

    fixture.nativeElement
      .querySelector('[aria-label="Open chat actions for Old dashboard"]')
      .click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[role="menuitem"][data-rename-chat]').click();
    fixture.detectChanges();

    const dialog: HTMLElement = fixture.nativeElement.querySelector('[role="dialog"]');
    expect(dialog.hasAttribute('focustrap')).toBe(true);
    const input: HTMLInputElement = dialog.querySelector('[aria-label="Chat title"]')!;
    input.value = '  Renamed dashboard  ';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('Renamed dashboard');
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/chats/chat-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed dashboard' }),
    });
  });

  it('confirms deletion, removes the chat, and navigates home', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { fixture, chatService, router } = await createFixture();
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    chatService.chats.set([
      {
        chatId: 'chat-1',
        projectId: 'local-workspace',
        title: 'Disposable chat',
        status: 'idle',
        versions: [],
      },
    ]);
    fixture.componentRef.setInput('chat', chatService.chats()[0]);
    fixture.detectChanges();

    fixture.nativeElement
      .querySelector('[aria-label="Open chat actions for Disposable chat"]')
      .click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[role="menuitem"][data-delete-chat]').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-confirm-delete]').click();

    await vi.waitFor(() => expect(chatService.chats()).toEqual([]));
    expect(fetchMock).toHaveBeenCalledWith('/api/chats/chat-1', { method: 'DELETE' });
    expect(router.navigate).toHaveBeenCalledWith(['/']);
  });

  it('disables delete while the chat is running', async () => {
    const { fixture } = await createFixture();
    fixture.componentRef.setInput('chat', {
      chatId: 'chat-1',
      projectId: 'local-workspace',
      title: 'Running chat',
      status: 'running',
      versions: [],
    });
    fixture.detectChanges();

    fixture.nativeElement
      .querySelector('[aria-label="Open chat actions for Running chat"]')
      .click();
    fixture.detectChanges();

    const deleteButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[role="menuitem"][data-delete-chat]',
    );
    expect(deleteButton.disabled).toBe(true);
    expect(deleteButton.title).toContain('running');
  });

  async function createFixture() {
    await TestBed.configureTestingModule({
      imports: [ChatActions],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatActions);
    const chatService = TestBed.inject(ChatService);
    const router = TestBed.inject(Router);
    fixture.componentRef.setInput('chat', {
      chatId: 'chat-1',
      projectId: 'local-workspace',
      title: 'Dashboard',
      status: 'idle',
      versions: [],
    });
    fixture.detectChanges();
    return { fixture, chatService, router };
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
