import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
  lucideChevronRight,
  lucideFileCode2,
  lucideFileMinus2,
  lucideFilePenLine,
  lucideFilePlus2,
  lucideFolder,
} from '@ng-icons/lucide';

import {
  buildFileTree,
  type FileStatus,
} from '../../lib/build-file-tree';
import { ChatService } from '../../services/chat.service';
import { FilesService } from '../../services/files.service';
import { WorkspaceShellService } from '../../services/workspace-shell.service';
import { DiffViewer } from '../diff-viewer/diff-viewer';

@Component({
  selector: 'app-files-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, NgIcon, DiffViewer],
  providers: [
    provideIcons({
      lucideChevronDown,
      lucideChevronRight,
      lucideFileCode2,
      lucideFileMinus2,
      lucideFilePenLine,
      lucideFilePlus2,
      lucideFolder,
    }),
  ],
  template: `
    <div class="flex h-full min-h-0 flex-col">
      <div class="grid min-h-0 flex-1 grid-cols-[250px_minmax(0,1fr)] max-md:grid-cols-1">
        <aside class="min-h-0 overflow-y-auto border-r border-border bg-card text-xs max-md:hidden">
          <div class="sticky top-0 z-10 flex h-10 items-center justify-between border-b border-border bg-card px-3">
            <span class="text-[11px] font-medium uppercase tracking-wide">Explorer</span>
            <span class="text-[10px] text-muted-foreground">Workspace</span>
          </div>
          <div class="p-2">
          @if (filesService.loadingTree()) {
            <p class="px-2 py-1 text-muted-foreground">Refreshing tree…</p>
          }

          @if (tree().length === 0 && !filesService.loadingTree()) {
            <p class="px-2 py-1 text-muted-foreground">No files yet.</p>
          }

          @for (node of tree(); track node.path) {
            <ng-container
              *ngTemplateOutlet="treeNode; context: { $implicit: node, depth: 0 }"
            ></ng-container>
          }
          </div>
        </aside>

        <div class="min-w-0 overflow-auto bg-background text-xs">
          @if (filesService.selectedPath(); as selectedPath) {
            <div class="sticky top-0 z-10 flex h-10 items-center border-b border-border bg-background px-4 font-mono text-[11px] text-muted-foreground">
              {{ selectedPath }}
            </div>
          }
          <div class="p-4">
          @if (filesService.detailError(); as error) {
            <p class="text-destructive">{{ error }}</p>
          } @else if (filesService.loadingDetail()) {
            <p class="text-muted-foreground">Loading file…</p>
          } @else if (filesService.selectedPath(); as selectedPath) {
            @if (filesService.fileDiff(); as diff) {
              <app-diff-viewer [diff]="diff" />
            } @else if (filesService.fileContent(); as content) {
              <div class="overflow-x-auto rounded-md border border-border bg-card p-0 font-mono text-[11px] leading-5">
                @for (line of contentLines(content); track $index) {
                  <div class="grid grid-cols-[3rem_minmax(0,1fr)] border-b border-border/40 last:border-b-0">
                    <span class="select-none px-2 py-0.5 text-right text-muted-foreground">{{
                      $index + 1
                    }}</span>
                    <span class="whitespace-pre px-2 py-0.5">{{ line }}</span>
                  </div>
                }
              </div>
            } @else {
              <p class="text-muted-foreground">Select a file to inspect its content or diff.</p>
            }
          } @else {
            <div class="flex min-h-[60vh] items-center justify-center text-muted-foreground">
              Select a file from the explorer.
            </div>
          }
          </div>
        </div>
      </div>
    </div>

    <ng-template #treeNode let-node let-depth="depth">
      <div [style.padding-left.px]="depth * 8">
        @if (node.isDirectory) {
          <button
            type="button"
            class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-muted/60"
            (click)="toggleDirectory(node.path)"
          >
            <ng-icon [name]="isExpanded(node.path) ? 'lucideChevronDown' : 'lucideChevronRight'" size="11" />
            <ng-icon name="lucideFolder" size="12" />
            <span class="truncate">{{ node.name }}/</span>
          </button>
          @if (isExpanded(node.path)) {
            @for (child of node.children; track child.path) {
              <ng-container
                *ngTemplateOutlet="treeNode; context: { $implicit: child, depth: depth + 1 }"
              ></ng-container>
            }
          }
        } @else {
          <button
            type="button"
            [attr.data-file-path]="node.path"
            [attr.aria-current]="filesService.selectedPath() === node.path ? 'true' : null"
            class="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-muted/60"
            [class.bg-muted]="filesService.selectedPath() === node.path"
            [class.line-through]="node.status === 'deleted'"
            (click)="selectFile(node.path, node.status)"
          >
            <ng-icon [name]="fileIcon(node.path)" size="12" [class]="turnMarkerClass(node.path) ?? ''" />
            <span class="truncate">{{ node.name }}</span>
          </button>
        }
      </div>
    </ng-template>
  `,
})
export class FilesPanel {
  readonly filesService = inject(FilesService);
  readonly chatService = inject(ChatService);
  readonly shell = inject(WorkspaceShellService);

  readonly expandedDirs = signal<Record<string, boolean>>({});

  readonly tree = computed(() => buildFileTree(this.filesService.files()));

  constructor() {
    effect(() => {
      const chatId = this.chatService.activeChatId();
      if (chatId) {
        this.filesService.attach(chatId);
      } else {
        this.filesService.detach();
      }
    });

    effect(() => {
      const tool = this.shell.activeTool();
      if (tool === 'code' && this.chatService.activeChatId()) {
        this.filesService.scheduleTreeRefresh(true);
      }
    });

    effect(() => {
      this.chatService.fileChangedTick();
      this.chatService.turnFinishedTick();
      this.chatService.turnStartedTick();
      if (this.chatService.activeChatId()) {
        this.filesService.scheduleTreeRefresh();
      }
    });

    effect(() => {
      const tick = this.chatService.fileChangedTick();
      const selectedPath = this.filesService.selectedPath();
      const touched = this.chatService.currentTurnTouchedFiles();
      if (!selectedPath || !tick) {
        return;
      }
      if (selectedPath in touched) {
        void this.filesService.refreshSelectedFile();
      }
    });
  }

  selectFile(path: string, status?: FileStatus): void {
    if (!status) {
      return;
    }
    void this.filesService.selectFile(path, status);
  }

  toggleDirectory(path: string): void {
    this.expandedDirs.update((state) => ({
      ...state,
      [path]: !state[path],
    }));
  }

  isExpanded(path: string): boolean {
    return this.expandedDirs()[path] ?? true;
  }

  turnMarkerClass(path: string): string | null {
    const kind = this.chatService.currentTurnTouchedFiles()[path];
    if (!kind) {
      return null;
    }
    switch (kind) {
      case 'created':
        return 'bg-emerald-500';
      case 'modified':
        return 'bg-amber-400';
      case 'deleted':
        return 'bg-destructive';
      default:
        return null;
    }
  }

  fileIcon(path: string): string {
    switch (this.chatService.currentTurnTouchedFiles()[path]) {
      case 'created':
        return 'lucideFilePlus2';
      case 'modified':
        return 'lucideFilePenLine';
      case 'deleted':
        return 'lucideFileMinus2';
      default:
        return 'lucideFileCode2';
    }
  }

  contentLines(content: string): string[] {
    return content.split('\n');
  }
}
