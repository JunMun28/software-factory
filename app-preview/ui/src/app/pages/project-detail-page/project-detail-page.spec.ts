import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectDetailPage } from './project-detail-page';

describe('ProjectDetailPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads a custom project id from the route and renders its server chats', async () => {
    const project = {
      id: 'project-42',
      name: 'Client portal',
      isDefault: false,
      chatCount: 1,
      createdAt: '2026-07-16T01:00:00.000Z',
      chats: [
        {
          chatId: 'chat-7',
          projectId: 'project-42',
          title: 'Build the portal',
          status: 'idle',
          versions: [],
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(project));
    vi.stubGlobal('fetch', fetchMock);
    await TestBed.configureTestingModule({
      imports: [ProjectDetailPage],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ projectId: 'project-42' }) } },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ProjectDetailPage);

    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain('Client portal');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-42');
    expect(fixture.nativeElement.textContent).toContain('Recent Chats');
    expect(fixture.nativeElement.textContent).toContain('Build the portal');
    expect(fixture.nativeElement.querySelector('a[href="/chats/chat-7"]')).toBeTruthy();
    expect(
      fixture.nativeElement.querySelector('a[href="/projects"]')?.getAttribute('aria-label'),
    ).toBe('Back to projects');
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
