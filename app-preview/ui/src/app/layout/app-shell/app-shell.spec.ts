import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceShellService } from '../../services/workspace-shell.service';
import { AppShell } from './app-shell';

describe('AppShell', () => {
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
      imports: [AppShell],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('hosts full-width product pages without builder workspace chrome', () => {
    const fixture = TestBed.createComponent(AppShell);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-chat-sidebar')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('router-outlet')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-workspace-toolbar')).toBeNull();
    expect(fixture.nativeElement.querySelector('[aria-label="Workspace tools"]')).toBeNull();
  });

  it('offers a first-focusable skip link targeting the main landmark', () => {
    const fixture = TestBed.createComponent(AppShell);
    fixture.detectChanges();

    const firstFocusable: HTMLAnchorElement = fixture.nativeElement.querySelector('a');
    const main: HTMLElement = fixture.nativeElement.querySelector('main');
    expect(firstFocusable.textContent?.trim()).toBe('Skip to main content');
    expect(firstFocusable.getAttribute('href')).toBe('#main-content');
    expect(main.id).toBe('main-content');
    expect(main.getAttribute('tabindex')).toBe('-1');
  });

  it('restores the product sidebar from the page when it is collapsed', () => {
    const fixture = TestBed.createComponent(AppShell);
    const shell = TestBed.inject(WorkspaceShellService);
    shell.toggleSidebar();
    fixture.detectChanges();

    const expandButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Expand sidebar"]',
    );
    expect(expandButton).toBeTruthy();
    expandButton.click();

    expect(shell.sidebarCollapsed()).toBe(false);
  });

  it('opens the product navigation drawer from index pages on mobile', () => {
    const fixture = TestBed.createComponent(AppShell);
    const shell = TestBed.inject(WorkspaceShellService);
    fixture.detectChanges();

    const openButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Open sidebar"]',
    );
    expect(openButton).toBeTruthy();
    openButton.click();

    expect(shell.mobileSidebarOpen()).toBe(true);
  });
});
