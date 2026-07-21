import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatService } from '../../services/chat.service';
import { ChatsPage } from './chats-page';

describe('ChatsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists and filters chats on a dedicated index surface', async () => {
    await TestBed.configureTestingModule({
      imports: [ChatsPage],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatsPage);
    TestBed.inject(ChatService).chats.set([
      { chatId: 'chat-1', projectId: 'local-workspace', title: 'Reading tracker', status: 'idle', versions: [] },
      { chatId: 'chat-2', projectId: 'local-workspace', title: 'Pomodoro timer', status: 'running', versions: [] },
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain('Chats');
    expect(fixture.nativeElement.textContent).toContain('Name');
    expect(fixture.nativeElement.textContent).toContain('Project');
    expect(fixture.nativeElement.textContent).toContain('Updated');
    expect(fixture.nativeElement.querySelector('a[href="/chats/chat-1"]')).toBeTruthy();
    const actions: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Open chat actions for Reading tracker"]',
    );
    expect(actions).toBeTruthy();
    actions.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-rename-chat]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-delete-chat]')).toBeTruthy();

    const search: HTMLInputElement = fixture.nativeElement.querySelector(
      '[aria-label="Search chats"]',
    );
    search.value = 'Pomodoro';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('Reading tracker');
    expect(fixture.nativeElement.textContent).toContain('Pomodoro timer');
  });

  it('marks folders and advanced filtering as coming soon', async () => {
    await TestBed.configureTestingModule({
      imports: [ChatsPage],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatsPage);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([]), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    fixture.detectChanges();

    const folders: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Folders — coming soon"]',
    );
    const filters: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Filter chats — coming soon"]',
    );

    expect(folders.disabled).toBe(true);
    expect(filters.disabled).toBe(true);
  });

  it('shows a loading state while chats are loading', async () => {
    await TestBed.configureTestingModule({
      imports: [ChatsPage],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatsPage);
    const chatService = TestBed.inject(ChatService);
    chatService.loadingChats.set(true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([]), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Loading chats…');
  });

  it('shows the true empty state when there are no chats', async () => {
    await TestBed.configureTestingModule({
      imports: [ChatsPage],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ChatsPage);
    const chatService = TestBed.inject(ChatService);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([]), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    fixture.detectChanges();
    await vi.waitFor(() => expect(chatService.loadingChats()).toBe(false));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'No chats yet. Start one to build an app.',
    );
  });
});
