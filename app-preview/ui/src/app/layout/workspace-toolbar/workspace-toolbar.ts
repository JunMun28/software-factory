import { Component, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCode2,
  lucideDatabase,
  lucideExternalLink,
  lucideEllipsis,
  lucideEye,
  lucideGitCommitHorizontal,
  lucideGitFork,
  lucideGlobe2,
  lucideMousePointer2,
  lucidePanelLeftOpen,
  lucideRefreshCw,
  lucideShare2,
  lucideStar,
} from '@ng-icons/lucide';

import { ChatActions } from '../../chats/chat-actions/chat-actions';
import { ChatService } from '../../services/chat.service';
import { PreviewService } from '../../services/preview.service';
import {
  WorkspaceShellService,
  type WorkspaceTool,
} from '../../services/workspace-shell.service';

const TOOLS: Array<{
  id: WorkspaceTool;
  label: string;
  icon: string;
}> = [
  { id: 'preview', label: 'Preview', icon: 'lucideEye' },
  { id: 'design', label: 'Design', icon: 'lucideMousePointer2' },
  { id: 'code', label: 'Code', icon: 'lucideCode2' },
  { id: 'database', label: 'Database', icon: 'lucideDatabase' },
];

@Component({
  selector: 'app-workspace-toolbar',
  imports: [ChatActions, NgIcon],
  providers: [
    provideIcons({
      lucideCode2,
      lucideDatabase,
      lucideEllipsis,
      lucideExternalLink,
      lucideEye,
      lucideGitCommitHorizontal,
      lucideGitFork,
      lucideGlobe2,
      lucideMousePointer2,
      lucidePanelLeftOpen,
      lucideRefreshCw,
      lucideShare2,
      lucideStar,
    }),
  ],
  template: `
    <header class="grid h-[50px] shrink-0 grid-cols-[320px_minmax(0,1fr)] border-b border-border bg-background max-md:grid-cols-1">
      <div class="flex min-w-0 items-center gap-2 border-r border-border px-3 max-md:border-r-0">
        <button
          type="button"
          class="workspace-icon-button mobile-only"
          aria-label="Open sidebar"
          (click)="shell.openMobileSidebar()"
        >
          <ng-icon name="lucidePanelLeftOpen" size="16" />
        </button>
        @if (shell.sidebarCollapsed()) {
          <button
            type="button"
            class="workspace-icon-button desktop-only"
            aria-label="Expand sidebar"
            [attr.aria-expanded]="false"
            (click)="shell.toggleSidebar()"
          >
            <ng-icon name="lucidePanelLeftOpen" size="16" />
          </button>
        }
        <button
          type="button"
          class="workspace-icon-button"
          aria-label="Add to favorites — unavailable"
          title="Favorites are unavailable"
          disabled
        >
          <ng-icon name="lucideStar" size="16" />
        </button>
        @if (chatService.activeChat(); as chat) {
          <app-chat-actions [chat]="chat" variant="title" />
          @if (seedLabel(chat); as rid) {
            <span
              class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
              title="This chat was seeded from {{ rid }}"
            >
              <ng-icon name="lucideGitFork" size="12" />
              seeded from {{ rid }}
            </span>
          }
        } @else {
          <span class="min-w-0 truncate text-sm text-muted-foreground">New chat</span>
        }
      </div>

      <div class="relative flex min-w-0 items-center justify-between gap-3 px-3 max-md:hidden">
        <div
          class="inline-flex h-7 shrink-0 items-center rounded-md border border-border bg-card p-0.5"
          role="tablist"
          aria-label="Workspace tools"
        >
          @for (tool of tools; track tool.id) {
            <button
              type="button"
              class="workspace-tool-tab"
              role="tab"
              [attr.aria-label]="tool.label"
              [attr.aria-selected]="shell.activeTool() === tool.id"
              [class.workspace-tool-tab-active]="shell.activeTool() === tool.id"
              [title]="tool.label"
              (click)="shell.setTool(tool.id)"
            >
              <ng-icon [name]="tool.icon" size="15" />
            </button>
          }
        </div>

        <div class="mx-auto flex h-7 min-w-0 max-w-xl flex-1 items-center justify-center gap-2 rounded-md border border-border bg-card px-3 font-mono text-[11px] text-muted-foreground">
          @if (previewService.status().status === 'ready' && previewService.status().url; as url) {
            <span class="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true"></span>
            <span class="truncate">{{ url }}</span>
          } @else {
            <span class="truncate">Workspace dev server</span>
          }
        </div>

        <div class="flex shrink-0 items-center gap-1">
          @if (previewService.status().url; as url) {
            <a
              class="workspace-icon-button"
              [href]="url"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open preview in new tab"
              title="Open preview"
            >
              <ng-icon name="lucideExternalLink" size="15" />
            </a>
          }
          <button
            type="button"
            class="workspace-icon-button"
            aria-label="Restart preview"
            title="Restart preview"
            (click)="restartPreview()"
          >
            <ng-icon name="lucideRefreshCw" size="15" />
          </button>
          @if (chatService.activeChat()) {
            <button
              type="button"
              class="workspace-icon-button"
              aria-label="Version history"
              title="Version history"
              (click)="shell.openVersionHistory()"
            >
              <ng-icon name="lucideGitCommitHorizontal" size="16" />
            </button>
          }
          <button
            type="button"
            class="workspace-icon-button"
            aria-label="More workspace actions — unavailable"
            title="More workspace actions — unavailable"
            disabled
          >
            <ng-icon name="lucideEllipsis" size="16" />
          </button>
          <button
            type="button"
            class="workspace-icon-button"
            aria-label="Share workspace — unavailable"
            title="Share workspace — unavailable"
            disabled
          >
            <ng-icon name="lucideShare2" size="15" />
          </button>
          <button
            type="button"
            class="ml-1 inline-flex h-8 cursor-not-allowed items-center gap-1.5 rounded-md bg-muted px-3 text-xs font-semibold text-muted-foreground opacity-60"
            aria-label="Publish workspace — unavailable"
            title="Publish workspace — unavailable"
            disabled
          >
            <ng-icon name="lucideGlobe2" size="14" />
            <span>Publish</span>
          </button>
        </div>
      </div>
    </header>
  `,
})
export class WorkspaceToolbar {
  readonly chatService = inject(ChatService);
  readonly previewService = inject(PreviewService);
  readonly shell = inject(WorkspaceShellService);
  readonly tools = TOOLS;

  /** "seeded from REQ-2136" label from a seeded chat, or null for template chats.
   *  The rid is the last path segment of the seed URL (the factory's git-daemon
   *  repo, e.g. .../req-2136); anything else shows its bare basename. */
  seedLabel(chat: { seedUrl?: string | null; seedRef?: string | null }): string | null {
    if (!chat.seedRef) return null;
    const base = (chat.seedUrl ?? '').replace(/\.git$/, '').split('/').filter(Boolean).pop() ?? '';
    const match = base.match(/^req-(\d+)$/i);
    return match ? `REQ-${match[1]}` : base || 'a preview';
  }

  restartPreview(): void {
    void this.previewService.restart();
  }
}
