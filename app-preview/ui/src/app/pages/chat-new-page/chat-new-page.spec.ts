import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatService } from '../../services/chat.service';
import { ChatNewPage } from './chat-new-page';

type CreateResult = { chatId: string } | { error: string; gateOutput?: string };

function setup(query: Record<string, string>, result?: CreateResult) {
  const createSeededChat = vi.fn(() => Promise.resolve(result ?? { chatId: 'new-1' }));
  TestBed.configureTestingModule({
    imports: [ChatNewPage],
    providers: [
      provideRouter([]),
      { provide: ChatService, useValue: { createSeededChat } },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: { get: (k: string) => query[k] ?? null } } },
      },
    ],
  });
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(ChatNewPage);
  return { fixture, createSeededChat, navigate };
}

describe('ChatNewPage', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('creates a seeded chat from the query params and navigates into it', async () => {
    const { fixture, createSeededChat, navigate } = setup(
      { seed: 'REQ-2136', url: 'git://api:9418/req-2136', ref: 'deadbeef' },
      { chatId: 'chat-9' },
    );
    fixture.detectChanges(); // runs ngOnInit
    await fixture.whenStable();

    expect(createSeededChat).toHaveBeenCalledWith({
      title: 'REQ-2136 preview edits',
      seed: { kind: 'git', url: 'git://api:9418/req-2136', ref: 'deadbeef' },
    });
    expect(navigate).toHaveBeenCalledWith(['/chats', 'chat-9']);
  });

  it('shows the gate output (not a spinner) when the seed is red', async () => {
    const { fixture, navigate } = setup(
      { seed: 'REQ-2136', url: 'git://api:9418/req-2136', ref: 'deadbeef' },
      { error: 'Seed gate failed', gateOutput: 'FAILED tests/test_app.py::test_home' },
    );
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(navigate).not.toHaveBeenCalled();
    expect(root.textContent).toContain("doesn't build yet");
    expect(root.textContent).toContain('FAILED tests/test_app.py::test_home');
    expect(root.textContent).not.toContain('Setting up your editor');
  });

  it('errors without calling the orchestrator when the link lacks a source', async () => {
    const { fixture, createSeededChat, navigate } = setup({ seed: 'REQ-2136' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(createSeededChat).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(root.textContent).toContain('missing its source');
  });
});
