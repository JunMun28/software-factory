import { TestBed } from '@angular/core/testing';

import { WorkspaceShellService } from './workspace-shell.service';

describe('WorkspaceShellService', () => {
  let service: WorkspaceShellService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(WorkspaceShellService);
  });

  it('starts in the desktop preview workspace', () => {
    expect(service.sidebarCollapsed()).toBe(false);
    expect(service.activeTool()).toBe('preview');
    expect(service.mobilePane()).toBe('preview');
    expect(service.mobileSidebarOpen()).toBe(false);
  });

  it('opens and closes the product sidebar independently on mobile', () => {
    service.openMobileSidebar();
    expect(service.mobileSidebarOpen()).toBe(true);

    service.closeMobileSidebar();
    expect(service.mobileSidebarOpen()).toBe(false);
  });

  it('toggles the global sidebar without changing the active tool', () => {
    service.setTool('code');

    service.toggleSidebar();

    expect(service.sidebarCollapsed()).toBe(true);
    expect(service.activeTool()).toBe('code');
  });

  it('switches workspace tools and mobile panes independently', () => {
    service.setTool('database');
    service.setMobilePane('chat');

    expect(service.activeTool()).toBe('database');
    expect(service.mobilePane()).toBe('chat');
  });
});
