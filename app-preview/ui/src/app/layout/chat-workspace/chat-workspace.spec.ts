import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceShellService } from '../../services/workspace-shell.service';
import { ChatWorkspace } from './chat-workspace';

describe('ChatWorkspace', () => {
  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await TestBed.configureTestingModule({
      imports: [ChatWorkspace],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('owns the builder toolbar, conversation, work surface, and mobile pane switcher', () => {
    const fixture = TestBed.createComponent(ChatWorkspace);
    const shell = TestBed.inject(WorkspaceShellService);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-chat-sidebar')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-workspace-toolbar')).toBeTruthy();
    expect(fixture.nativeElement.querySelectorAll('[role="tab"]')).toHaveLength(6);
    expect(fixture.nativeElement.querySelector('app-chat-conversation')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-right-panel')).toBeTruthy();

    const main: HTMLElement = fixture.nativeElement.querySelector('main');
    const chatButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Show chat"]',
    );
    chatButton.click();
    fixture.detectChanges();

    expect(shell.mobilePane()).toBe('chat');
    expect(main.dataset['mobilePane']).toBe('chat');
  });

  it('offers a first-focusable skip link targeting the workspace main landmark', () => {
    const fixture = TestBed.createComponent(ChatWorkspace);
    fixture.detectChanges();

    const firstFocusable: HTMLAnchorElement = fixture.nativeElement.querySelector('a');
    const main: HTMLElement = fixture.nativeElement.querySelector('main');
    expect(firstFocusable.textContent?.trim()).toBe('Skip to main content');
    expect(firstFocusable.getAttribute('href')).toBe('#main-content');
    expect(main.id).toBe('main-content');
    expect(main.getAttribute('tabindex')).toBe('-1');
  });
});
