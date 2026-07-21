import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../services/project.service';
import { ProjectsPage } from './projects-page';

const serverProjects: Project[] = [
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
    chatCount: 1,
    createdAt: '2026-07-16T01:00:00.000Z',
  },
];

describe('ProjectsPage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    fetchMock = vi.fn().mockResolvedValue(jsonResponse(serverProjects));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists server projects with chat counts and openable detail links', async () => {
    const fixture = await createFixture();

    expect(fetchMock).toHaveBeenCalledWith('/api/projects');
    expect(fixture.nativeElement.textContent).toContain('Local workspace');
    expect(fixture.nativeElement.textContent).toContain('2 chats');
    expect(fixture.nativeElement.textContent).toContain('Client portal');
    expect(fixture.nativeElement.textContent).toContain('1 chat');
    expect(
      fixture.nativeElement.querySelector(
        'a[href="/projects/local-workspace"][aria-label="Open Local workspace"]',
      ),
    ).toBeTruthy();
    expect(
      fixture.nativeElement.querySelector(
        'a[href="/projects/project-42"][aria-label="Open Client portal"]',
      ),
    ).toBeTruthy();
  });

  it('keeps the create dialog focus trapped and restores its trigger on Escape', async () => {
    vi.useFakeTimers();
    const fixture = await createFixture();
    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Create project"]',
    );

    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    await vi.runAllTimersAsync();

    const dialog: HTMLElement = fixture.nativeElement.querySelector('[role="dialog"]');
    expect(dialog.hasAttribute('focustrap')).toBe(true);
    expect(document.activeElement).toBe(dialog.querySelector('[aria-label="Project name"]'));

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('creates through the API and shows the returned project without reloading', async () => {
    const created: Project = {
      id: 'server-generated-id',
      name: 'Keyboard project',
      isDefault: false,
      chatCount: 0,
      createdAt: '2026-07-16T02:00:00.000Z',
    };
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST' ? jsonResponse(created, 201) : jsonResponse(serverProjects),
    );
    const fixture = await createFixture();

    fixture.nativeElement.querySelector('[aria-label="Create project"]').click();
    fixture.detectChanges();
    const nameInput: HTMLInputElement = fixture.nativeElement.querySelector(
      '[aria-label="Project name"]',
    );
    nameInput.value = '  Keyboard project  ';
    nameInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    nameInput.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Keyboard project' }),
    });
    expect(fixture.nativeElement.textContent).toContain('Keyboard project');
    expect(
      fixture.nativeElement.querySelector('a[href="/projects/server-generated-id"]'),
    ).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/projects')).toHaveLength(2);
  });

  it('has no automated accessibility violations', async () => {
    const fixture = await createFixture();

    const result = await axe.run(fixture.nativeElement, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(result.violations).toEqual([]);
  });

  async function createFixture() {
    await TestBed.configureTestingModule({
      imports: [ProjectsPage],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ProjectsPage);
    fixture.detectChanges();
    await flushPromises();
    fixture.detectChanges();
    return fixture;
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
