import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatService } from '../../services/chat.service';
import { WorkspaceShellService, type WorkspaceTool } from '../../services/workspace-shell.service';
import { RightPanel } from './right-panel';

describe('RightPanel', () => {
  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/preview')) {
          return Promise.resolve(jsonResponse({ status: 'ready', url: 'http://preview.local' }));
        }
        if (url.endsWith('/events')) {
          return Promise.resolve(new Response('', { status: 200 }));
        }
        if (url.endsWith('/files')) {
          return Promise.resolve(jsonResponse({ files: [] }));
        }
        return Promise.resolve(jsonResponse({ connected: false, tables: [] }));
      }),
    );
    await TestBed.configureTestingModule({ imports: [RightPanel] }).compileComponents();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['preview', 'app-preview-panel'],
    ['design', 'app-design-panel'],
    ['code', 'app-files-panel'],
    ['database', 'app-database-panel'],
  ] as Array<[WorkspaceTool, string]>)('renders the %s work surface', (tool, selector) => {
    const fixture = TestBed.createComponent(RightPanel);
    const chatService = TestBed.inject(ChatService);
    const shell = TestBed.inject(WorkspaceShellService);
    chatService.setActiveChat('chat-1');
    shell.setTool(tool);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(selector)).toBeTruthy();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
