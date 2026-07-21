import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, Routes } from '@angular/router';
import axe from 'axe-core';
import { afterEach, vi } from 'vitest';

import { ChatService } from '../../services/chat.service';
import { WorkspaceShellService } from '../../services/workspace-shell.service';
import { ChatSidebar } from './chat-sidebar';

@Component({ template: '' })
class RouteStub {}

describe('ChatSidebar', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function createFixture(routes: Routes = []) {
    await TestBed.configureTestingModule({
      imports: [ChatSidebar],
      providers: [provideRouter(routes)],
    }).compileComponents();

    const fixture = TestBed.createComponent(ChatSidebar);
    fixture.detectChanges();
    return fixture;
  }

  it('uses real links for the v0 route model without persisting an empty chat', async () => {
    const fixture = await createFixture();
    const chatService = TestBed.inject(ChatService);
    const createChat = vi.spyOn(chatService, 'createChat');

    const links = (name: string) =>
      fixture.nativeElement.querySelector(`[data-nav="${name}"]`) as HTMLAnchorElement;

    expect(links('new-chat').getAttribute('href')).toBe('/');
    expect(links('new-chat').querySelector('ng-icon')).toBeNull();
    expect(links('home').getAttribute('href')).toBe('/');
    expect(links('projects').getAttribute('href')).toBe('/projects');
    expect(links('chats').getAttribute('href')).toBe('/chats');
    expect(links('design-systems').getAttribute('href')).toBe('/design-systems');
    expect(links('templates').getAttribute('href')).toBe('/templates');
    expect(links('more').getAttribute('href')).toBe('/chats');

    links('new-chat').click();
    expect(createChat).not.toHaveBeenCalled();
  });

  it('opens a focused command palette and restores Search focus after Escape', async () => {
    vi.useFakeTimers();
    const fixture = await createFixture();
    const chatService = TestBed.inject(ChatService);
    chatService.chats.set([
      { chatId: 'chat-1', projectId: 'local-workspace', title: 'Reading tracker', status: 'idle', versions: [] },
    ]);
    fixture.detectChanges();

    const searchButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Search"]',
    );
    searchButton.focus();
    searchButton.click();
    fixture.detectChanges();
    await vi.runAllTimersAsync();

    const dialog: HTMLElement = fixture.nativeElement.querySelector('[role="dialog"]');
    const searchInput: HTMLInputElement = dialog.querySelector(
      '[aria-label="Search navigation and chats"]',
    )!;
    expect(dialog).toBeTruthy();
    expect(document.activeElement).toBe(searchInput);
    expect(dialog.textContent).toContain('Quick Actions');
    expect(dialog.textContent).toContain('New Chat');
    expect(dialog.textContent).toContain('Projects');
    expect(dialog.textContent).toContain('All Recent Chats');
    expect(dialog.textContent).toContain('Design Systems');
    expect(dialog.textContent).toContain('Templates');
    expect(dialog.textContent).toContain('Reading tracker');

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(searchButton);
  });

  it('marks the closed mobile sidebar inert and removes that state when opened', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const fixture = await createFixture();

    const sidebar: HTMLElement = fixture.nativeElement.querySelector('aside');
    const sidebarLinks = Array.from(sidebar.querySelectorAll('a'));
    expect(sidebar.hasAttribute('inert')).toBe(true);
    expect(sidebar.getAttribute('aria-hidden')).toBe('true');
    expect(sidebarLinks.length).toBeGreaterThan(0);
    expect(sidebarLinks.every((link) => link.closest('[inert]') === sidebar)).toBe(true);

    TestBed.inject(WorkspaceShellService).openMobileSidebar();
    fixture.detectChanges();

    expect(sidebar.hasAttribute('inert')).toBe(false);
    expect(sidebar.hasAttribute('aria-hidden')).toBe(false);
  });

  it('exposes the active product route with aria-current', async () => {
    const fixture = await createFixture([{ path: 'projects', component: RouteStub }]);
    await TestBed.inject(Router).navigateByUrl('/projects');
    fixture.detectChanges();

    const projects: HTMLAnchorElement = fixture.nativeElement.querySelector(
      '[data-nav="projects"]',
    );
    const home: HTMLAnchorElement = fixture.nativeElement.querySelector('[data-nav="home"]');
    expect(projects.getAttribute('aria-current')).toBe('page');
    expect(home.hasAttribute('aria-current')).toBe(false);
  });

  it('matches the v0 navigation labels and collapses the global rail', async () => {
    const fixture = await createFixture();
    const shell = TestBed.inject(WorkspaceShellService);
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Personal');
    const workspaceLabel: HTMLElement = fixture.nativeElement.querySelector(
      '[data-testid="workspace-label"]',
    );
    expect(workspaceLabel.textContent).toContain('Personal');
    expect(workspaceLabel.querySelector('ng-icon')).toBeNull();
    expect(text).toContain('Projects');
    expect(text).toContain('Design Systems');
    expect(text).toContain('Recent Chats');

    const collapseButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Collapse sidebar"]',
    );
    expect(collapseButton).toBeTruthy();
    collapseButton.click();
    expect(shell.sidebarCollapsed()).toBe(true);
  });

  it('shows a chat-list error instead of an empty state', async () => {
    const fixture = await createFixture();
    const chatService = TestBed.inject(ChatService);
    chatService.error.set('Failed to load chats (503)');
    fixture.detectChanges();

    const error: HTMLElement = fixture.nativeElement.querySelector('[data-chat-list-error]');
    expect(error.textContent).toContain('Failed to load chats (503)');
    expect(fixture.nativeElement.textContent).not.toContain('No chats yet');
  });

  it('has no automated accessibility violations', async () => {
    const fixture = await createFixture();

    const result = await axe.run(fixture.nativeElement, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(result.violations).toEqual([]);
  });
});
