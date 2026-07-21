import { Injectable, signal } from '@angular/core';

export type WorkspaceTool = 'preview' | 'design' | 'code' | 'database';
export type MobilePane = 'chat' | 'preview';

@Injectable({ providedIn: 'root' })
export class WorkspaceShellService {
  readonly sidebarCollapsed = signal(false);
  readonly mobileSidebarOpen = signal(false);
  readonly activeTool = signal<WorkspaceTool>('preview');
  readonly mobilePane = signal<MobilePane>('preview');
  readonly versionHistoryOpen = signal(false);

  openVersionHistory(): void {
    this.versionHistoryOpen.set(true);
  }

  closeVersionHistory(): void {
    this.versionHistoryOpen.set(false);
  }

  toggleSidebar(): void {
    this.sidebarCollapsed.update((collapsed) => !collapsed);
  }

  openMobileSidebar(): void {
    this.sidebarCollapsed.set(false);
    this.mobileSidebarOpen.set(true);
  }

  closeMobileSidebar(): void {
    this.mobileSidebarOpen.set(false);
  }

  setTool(tool: WorkspaceTool): void {
    this.activeTool.set(tool);
    this.mobilePane.set('preview');
  }

  setMobilePane(pane: MobilePane): void {
    this.mobilePane.set(pane);
  }
}
