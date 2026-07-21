import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import axe from 'axe-core';

import { ChatService } from '../../services/chat.service';
import { WorkspaceShellService } from '../../services/workspace-shell.service';
import { WorkspaceToolbar } from './workspace-toolbar';

describe('WorkspaceToolbar', () => {
  it('switches among the four workspace tools with tab semantics', async () => {
    await TestBed.configureTestingModule({
      imports: [WorkspaceToolbar],
      providers: [provideRouter([])],
    }).compileComponents();

    const fixture = TestBed.createComponent(WorkspaceToolbar);
    const shell = TestBed.inject(WorkspaceShellService);
    fixture.detectChanges();

    const codeButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Code"]',
    );
    expect(codeButton).toBeTruthy();
    codeButton.click();
    fixture.detectChanges();

    expect(shell.activeTool()).toBe('code');
    expect(codeButton.getAttribute('aria-selected')).toBe('true');
    expect(fixture.nativeElement.querySelectorAll('[role="tab"]')).toHaveLength(4);
    expect(fixture.nativeElement.textContent).toContain('Publish');
    const unavailableLabels = [
      'Add to favorites — unavailable',
      'More workspace actions — unavailable',
      'Share workspace — unavailable',
      'Publish workspace — unavailable',
    ];
    for (const label of unavailableLabels) {
      const button: HTMLButtonElement = fixture.nativeElement.querySelector(
        `[aria-label="${label}"]`,
      );
      expect(button.disabled).toBe(true);
    }

    const openSidebar: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Open sidebar"]',
    );
    expect(openSidebar).toBeTruthy();
    openSidebar.click();
    expect(shell.mobileSidebarOpen()).toBe(true);
  });

  it('opens rename and delete actions from the workspace chat title', async () => {
    await TestBed.configureTestingModule({
      imports: [WorkspaceToolbar],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(WorkspaceToolbar);
    const chatService = TestBed.inject(ChatService);
    chatService.chats.set([
      {
        chatId: 'chat-1',
        projectId: 'local-workspace',
        title: 'Reading tracker',
        status: 'idle',
        versions: [],
      },
    ]);
    chatService.activeChatId.set('chat-1');
    fixture.detectChanges();

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Open chat actions for Reading tracker"]',
    );
    expect(trigger).toBeTruthy();
    trigger.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-rename-chat]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-delete-chat]')).toBeTruthy();
  });

  it('shows a "seeded from" badge only for a seeded chat', async () => {
    await TestBed.configureTestingModule({
      imports: [WorkspaceToolbar],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(WorkspaceToolbar);
    const chatService = TestBed.inject(ChatService);

    // template-born chat: no badge
    chatService.chats.set([
      { chatId: 'c1', projectId: 'local-workspace', title: 'Plain', status: 'idle', versions: [] },
    ]);
    chatService.activeChatId.set('c1');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('seeded from');

    // seeded chat: badge derives the rid from the git-daemon URL basename
    chatService.chats.set([
      {
        chatId: 'c2',
        projectId: 'local-workspace',
        title: 'Sticky filters',
        status: 'idle',
        versions: [],
        seedUrl: 'git://api:9418/req-2136',
        seedRef: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      },
    ]);
    chatService.activeChatId.set('c2');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('seeded from REQ-2136');
  });

  it('has no automated accessibility violations', async () => {
    await TestBed.configureTestingModule({
      imports: [WorkspaceToolbar],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(WorkspaceToolbar);
    fixture.detectChanges();

    const result = await axe.run(fixture.nativeElement, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(result.violations).toEqual([]);
  });
});
