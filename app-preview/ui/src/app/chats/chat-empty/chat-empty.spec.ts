import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatService } from '../../services/chat.service';
import { ModelService } from '../../services/model.service';
import { ProjectService } from '../../services/project.service';
import { ChatEmpty } from './chat-empty';

describe('ChatEmpty', () => {
  beforeEach(async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    await TestBed.configureTestingModule({
      imports: [ChatEmpty],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('matches the prompt-first v0 Home and New Chat surface', () => {
    const fixture = TestBed.createComponent(ChatEmpty);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain(
      'What do you want to create?',
    );
    const composer: HTMLTextAreaElement = fixture.nativeElement.querySelector('textarea');
    expect(composer.getAttribute('placeholder')).toBe('Ask ng-v0 to build…');
    expect(fixture.nativeElement.textContent).not.toContain('Golden Template');
  });

  it('marks attachment and voice input as unavailable', () => {
    const fixture = TestBed.createComponent(ChatEmpty);
    fixture.detectChanges();

    const attachment: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Add attachment — unavailable"]',
    );
    const voice: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Use voice input — unavailable"]',
    );

    expect(attachment.disabled).toBe(true);
    expect(voice.disabled).toBe(true);
  });

  it('persists a chat only after a non-empty prompt is submitted', async () => {
    const fixture = TestBed.createComponent(ChatEmpty);
    const service = TestBed.inject(ChatService);
    const projectService = TestBed.inject(ProjectService);
    projectService.projects.set([
      {
        id: 'project-42',
        name: 'Client portal',
        isDefault: true,
        chatCount: 0,
        createdAt: '2026-07-16T00:00:00.000Z',
      },
    ]);
    projectService.selectProject('project-42');
    vi.spyOn(service, 'createChat').mockResolvedValue('chat-1');
    const sendTurn = vi.spyOn(service, 'sendTurn').mockResolvedValue();
    fixture.detectChanges();

    await fixture.componentInstance.start(new Event('submit'));
    expect(service.createChat).not.toHaveBeenCalled();

    fixture.componentInstance.prompt.set('Build a dashboard');
    await fixture.componentInstance.start(new Event('submit'));

    expect(service.createChat).toHaveBeenCalledOnce();
    expect(service.createChat).toHaveBeenCalledWith('project-42');
    expect(sendTurn).toHaveBeenCalledWith('chat-1', 'Build a dashboard');
  });

  it('shows progress feedback while creating a chat', async () => {
    const fixture = TestBed.createComponent(ChatEmpty);
    const service = TestBed.inject(ChatService);
    const projectService = TestBed.inject(ProjectService);
    projectService.projects.set([
      {
        id: 'project-42',
        name: 'Client portal',
        isDefault: true,
        chatCount: 0,
        createdAt: '2026-07-16T00:00:00.000Z',
      },
    ]);
    projectService.selectProject('project-42');
    let resolveCreate!: (chatId: string | null) => void;
    const createChat = new Promise<string | null>((resolve) => {
      resolveCreate = resolve;
    });
    vi.spyOn(service, 'createChat').mockReturnValue(createChat);
    vi.spyOn(service, 'sendTurn').mockResolvedValue();
    fixture.componentInstance.prompt.set('Build a dashboard');
    fixture.detectChanges();

    const start = fixture.componentInstance.start(new Event('submit'));
    await Promise.resolve();
    fixture.detectChanges();

    const submit: HTMLButtonElement = fixture.nativeElement.querySelector('button[type="submit"]');
    expect(submit.querySelector('ng-icon[name="lucideLoaderCircle"]')).toBeTruthy();
    expect(submit.querySelector('ng-icon[name="lucideArrowUp"]')).toBeNull();

    resolveCreate('chat-1');
    await start;
    fixture.detectChanges();

    expect(submit.querySelector('ng-icon[name="lucideLoaderCircle"]')).toBeNull();
    expect(submit.querySelector('ng-icon[name="lucideArrowUp"]')).toBeTruthy();
  });

  it('opens a focused project selector and restores its trigger after Escape', async () => {
    vi.useFakeTimers();
    const projectService = TestBed.inject(ProjectService);
    projectService.projects.set([
      {
        id: 'local-workspace',
        name: 'Local workspace',
        isDefault: true,
        chatCount: 2,
        createdAt: '2026-07-16T00:00:00.000Z',
      },
      {
        id: 'project-42',
        name: 'Client portal',
        isDefault: false,
        chatCount: 0,
        createdAt: '2026-07-16T01:00:00.000Z',
      },
    ]);
    projectService.selectProject('local-workspace');
    const fixture = TestBed.createComponent(ChatEmpty);
    fixture.detectChanges();

    const trigger: HTMLButtonElement | null = fixture.nativeElement.querySelector(
      '[data-testid="project-trigger"]',
    );
    expect(trigger).toBeTruthy();
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');

    trigger?.focus();
    trigger?.click();
    fixture.detectChanges();
    await vi.runAllTimersAsync();

    const menu: HTMLElement | null = fixture.nativeElement.querySelector(
      '[aria-label="Available projects"]',
    );
    expect(menu).toBeTruthy();
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(menu?.textContent).toContain('Local workspace');
    expect(menu?.textContent).toContain('Client portal');
    expect(
      menu?.querySelector('[data-project-id="local-workspace"] ng-icon[name="lucideCheck"]'),
    ).toBeTruthy();
    expect(menu?.querySelector('a[href="/projects"]')?.textContent).toContain('New Project');

    const search: HTMLInputElement = menu!.querySelector('input')!;
    expect(document.activeElement).toBe(search);
    search.value = 'missing';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(menu?.textContent).toContain('No projects match');

    search.value = 'client';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const clientProject: HTMLButtonElement | null = menu!.querySelector(
      '[data-project-id="project-42"]',
    );
    clientProject?.click();
    fixture.detectChanges();

    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.textContent).toContain('Client portal');
    expect(trigger?.getAttribute('aria-label')).toContain('Client portal');

    trigger?.click();
    fixture.detectChanges();
    await vi.runAllTimersAsync();
    const reopenedMenu: HTMLElement = fixture.nativeElement.querySelector(
      '[aria-label="Available projects"]',
    );
    reopenedMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('shows project loading and retries a project load error', () => {
    const projectService = TestBed.inject(ProjectService);
    projectService.projects.set([
      {
        id: 'local-workspace',
        name: 'Local workspace',
        isDefault: true,
        chatCount: 2,
        createdAt: '2026-07-16T00:00:00.000Z',
      },
    ]);
    const fixture = TestBed.createComponent(ChatEmpty);
    fixture.detectChanges();

    projectService.loading.set(true);
    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-testid="project-trigger"]',
    );
    trigger.click();
    fixture.detectChanges();

    const menu: HTMLElement = fixture.nativeElement.querySelector(
      '[aria-label="Available projects"]',
    );
    expect(menu.textContent).toContain('Loading projects…');

    projectService.loading.set(false);
    projectService.error.set('Failed to load projects');
    fixture.detectChanges();

    expect(menu.textContent).toContain('Projects could not be loaded.');
    const loadProjects = vi.spyOn(projectService, 'loadProjects');
    const retry: HTMLButtonElement = Array.from(menu.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Retry'),
    )!;
    retry.click();

    expect(loadProjects).toHaveBeenCalledOnce();
  });

  it('opens the focused model menu and restores its trigger after Escape', async () => {
    vi.useFakeTimers();
    const modelService = TestBed.inject(ModelService);
    modelService.models.set([{ id: 'openai/gpt-5.4', provider: 'openai', name: 'gpt-5.4' }]);
    const fixture = TestBed.createComponent(ChatEmpty);
    fixture.detectChanges();

    const trigger: HTMLButtonElement | null = fixture.nativeElement.querySelector(
      '[data-testid="model-trigger"]',
    );
    expect(trigger).toBeTruthy();
    trigger?.focus();
    trigger?.click();
    fixture.detectChanges();
    await vi.runAllTimersAsync();

    const menu: HTMLElement = fixture.nativeElement.querySelector('[role="menu"]');
    expect(menu).toBeTruthy();
    expect(document.activeElement).toBe(menu.querySelector('input'));
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');

    const option: HTMLButtonElement | null = fixture.nativeElement.querySelector(
      '[data-model-id="openai/gpt-5.4"]',
    );
    expect(option).toBeTruthy();
    option?.click();
    fixture.detectChanges();

    expect(modelService.selectedModel()).toBe('openai/gpt-5.4');
    expect(trigger?.textContent).toContain('gpt-5.4');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');

    trigger?.click();
    fixture.detectChanges();
    await vi.runAllTimersAsync();
    const reopenedMenu: HTMLElement = fixture.nativeElement.querySelector('[role="menu"]');
    reopenedMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('has no automated accessibility violations', async () => {
    const fixture = TestBed.createComponent(ChatEmpty);
    fixture.detectChanges();

    const result = await axe.run(fixture.nativeElement, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(result.violations).toEqual([]);
  });
});
