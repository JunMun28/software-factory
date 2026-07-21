import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectService, type Project } from './project.service';

const defaultProject: Project = {
  id: 'local-workspace',
  name: 'Local workspace',
  isDefault: true,
  chatCount: 2,
  createdAt: '2026-07-16T00:00:00.000Z',
};

const customProject: Project = {
  id: 'project-42',
  name: 'Client portal',
  isDefault: false,
  chatCount: 0,
  createdAt: '2026-07-16T01:00:00.000Z',
};

describe('ProjectService', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads server projects and selects the default project', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([defaultProject, customProject]));
    vi.stubGlobal('fetch', fetchMock);
    const service = TestBed.inject(ProjectService);

    await service.loadProjects();

    expect(fetchMock).toHaveBeenCalledWith('/api/projects');
    expect(service.projects()).toEqual([defaultProject, customProject]);
    expect(service.selectedProject()).toEqual(defaultProject);
    expect(service.selectedProjectId()).toBe('local-workspace');
  });

  it('keeps only a valid cached selected project id', async () => {
    localStorage.setItem('ng-v0-selected-project-id', 'project-42');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([defaultProject, customProject])));
    const service = TestBed.inject(ProjectService);

    await service.loadProjects();
    expect(service.selectedProject()).toEqual(customProject);

    service.selectProject('missing');
    expect(service.selectedProject()).toEqual(customProject);
    expect(localStorage.getItem('ng-v0-selected-project-id')).toBe('project-42');
  });

  it('creates a project through the API and adds it to the signal immediately', async () => {
    const created = { ...customProject, id: 'server-generated-id' };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse(created, 201);
      }
      return jsonResponse([defaultProject]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = TestBed.inject(ProjectService);
    await service.loadProjects();

    await expect(service.createProject('  Client portal  ')).resolves.toEqual(created);

    expect(fetchMock).toHaveBeenCalledWith('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Client portal' }),
    });
    expect(service.projects()).toEqual([defaultProject, created]);
  });

  it('loads project details by the server id', async () => {
    const details = {
      ...customProject,
      chats: [
        {
          chatId: 'chat-7',
          projectId: customProject.id,
          title: 'Build the portal',
          status: 'idle' as const,
          versions: [],
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(details));
    vi.stubGlobal('fetch', fetchMock);
    const service = TestBed.inject(ProjectService);

    await expect(service.loadProject('project-42')).resolves.toEqual(details);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-42');
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
