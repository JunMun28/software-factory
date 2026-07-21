import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFileDiff,
  lucideGitCommitHorizontal,
  lucideGitFork,
  lucideLoaderCircle,
  lucideRotateCcw,
  lucideX,
} from '@ng-icons/lucide';

import { FocusTrap } from '../../lib/focus-trap';
import { shortSha } from '../../models/turn';
import { DiffViewer } from '../../panels/diff-viewer/diff-viewer';
import { ChatService } from '../../services/chat.service';
import type { ChatVersion, VersionDiffFile } from '../../types/orchestrator-events';
import { ConfirmDialog } from '../confirm-dialog/confirm-dialog';

@Component({
  selector: 'app-version-history-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmDialog, DatePipe, DiffViewer, FocusTrap, NgIcon],
  providers: [
    provideIcons({
      lucideFileDiff,
      lucideGitCommitHorizontal,
      lucideGitFork,
      lucideLoaderCircle,
      lucideRotateCcw,
      lucideX,
    }),
  ],
  template: `
    <div
      class="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 px-4 py-6"
      (click)="closed.emit()"
    >
      <section
        focusTrap
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-history-title"
        class="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
        (click)="$event.stopPropagation()"
        (focusTrapEscape)="closed.emit()"
      >
        <header class="flex shrink-0 items-start gap-4 border-b border-border px-5 py-4">
          <div class="min-w-0 flex-1">
            <h2 id="version-history-title" class="text-lg font-semibold">Version history</h2>
            <p class="mt-1 text-sm text-muted-foreground">
              Restore a checkpoint, fork it into a new chat, or inspect exactly what changed.
            </p>
          </div>
          <button
            type="button"
            class="workspace-icon-button"
            aria-label="Close version history"
            (click)="closed.emit()"
          >
            <ng-icon name="lucideX" size="16" />
          </button>
        </header>

        <div class="min-h-0 overflow-y-auto p-4">
          @if (error(); as message) {
            <p
              class="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {{ message }}
            </p>
          }

          @if (loading()) {
            <div
              class="flex items-center gap-2 px-2 py-10 text-sm text-muted-foreground"
              role="status"
            >
              <ng-icon class="animate-spin" name="lucideLoaderCircle" size="15" />
              Loading version history…
            </div>
          } @else if (versions().length === 0) {
            <p class="px-2 py-10 text-center text-sm text-muted-foreground">No versions yet.</p>
          } @else {
            <div class="space-y-3">
              @for (version of versions(); track version.id) {
                <article class="rounded-lg border border-border bg-card">
                  <div class="flex flex-wrap items-start gap-3 p-4">
                    <span
                      class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted"
                    >
                      <ng-icon name="lucideGitCommitHorizontal" size="15" />
                    </span>
                    <div class="min-w-48 flex-1">
                      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <h3 class="text-sm font-semibold">Version {{ version.seq }}</h3>
                        <code class="text-[11px] text-muted-foreground">{{
                          shortSha(version.commit)
                        }}</code>
                      </div>
                      <p class="mt-1 text-sm">{{ version.message }}</p>
                      <p class="mt-1 text-xs text-muted-foreground">
                        {{ version.createdAt | date: 'medium' }}
                        @if (version.restoredFromVersionId) {
                          · Restored from an earlier version
                        }
                      </p>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                        [attr.aria-label]="'View diff for version ' + version.seq"
                        [disabled]="busyVersionId() !== null"
                        (click)="viewDiff(version)"
                      >
                        <ng-icon name="lucideFileDiff" size="13" /> View diff
                      </button>
                      <button
                        type="button"
                        class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                        [attr.aria-label]="'Fork version ' + version.seq"
                        [disabled]="busyVersionId() !== null"
                        (click)="fork(version)"
                      >
                        <ng-icon name="lucideGitFork" size="13" /> Fork
                      </button>
                      <button
                        type="button"
                        class="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-2.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
                        [attr.aria-label]="'Restore version ' + version.seq"
                        [disabled]="busyVersionId() !== null"
                        (click)="pendingRestoreVersionId.set(version)"
                      >
                        @if (busyVersionId() === version.id) {
                          <ng-icon class="animate-spin" name="lucideLoaderCircle" size="13" />
                        } @else {
                          <ng-icon name="lucideRotateCcw" size="13" />
                        }
                        Restore
                      </button>
                    </div>
                  </div>

                  @if (diffVersionId() === version.id) {
                    <div class="border-t border-border bg-background/50 p-4">
                      @if (loadingDiff()) {
                        <p class="text-xs text-muted-foreground" role="status">Loading diff…</p>
                      } @else if (diffFiles().length === 0) {
                        <p class="text-xs text-muted-foreground">
                          This version has no file changes.
                        </p>
                      } @else {
                        <div class="space-y-4">
                          @for (file of diffFiles(); track file.path) {
                            <section>
                              <div class="mb-2 flex items-center gap-2 text-xs">
                                <span class="font-mono font-medium">{{ file.path }}</span>
                                <span class="text-muted-foreground">{{ file.status }}</span>
                              </div>
                              <app-diff-viewer [diff]="file.diff" />
                            </section>
                          }
                        </div>
                      }
                    </div>
                  }
                </article>
              }
            </div>
          }
        </div>
      </section>
    </div>

    @if (pendingRestoreVersionId(); as version) {
      <app-confirm-dialog
        title="Restore this version?"
        description="Your current work is saved as a new version first."
        confirmLabel="Restore"
        [busy]="busyVersionId() === version.id"
        (confirmed)="confirmRestore(version)"
        (dismissed)="pendingRestoreVersionId.set(null)"
      />
    }
  `,
})
export class VersionHistoryPanel implements OnInit {
  private readonly chatService = inject(ChatService);

  readonly chatId = input.required<string>();
  readonly closed = output<void>();
  readonly versions = signal<ChatVersion[]>([]);
  readonly loading = signal(true);
  readonly loadingDiff = signal(false);
  readonly busyVersionId = signal<string | null>(null);
  readonly pendingRestoreVersionId = signal<ChatVersion | null>(null);
  readonly diffVersionId = signal<string | null>(null);
  readonly diffFiles = signal<VersionDiffFile[]>([]);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const versions = await this.chatService.loadVersions(this.chatId());
      this.versions.set(versions.slice().reverse());
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to load version history');
    } finally {
      this.loading.set(false);
    }
  }

  async viewDiff(version: ChatVersion): Promise<void> {
    if (this.diffVersionId() === version.id) {
      this.diffVersionId.set(null);
      this.diffFiles.set([]);
      return;
    }
    this.diffVersionId.set(version.id);
    this.diffFiles.set([]);
    this.loadingDiff.set(true);
    this.error.set(null);
    try {
      this.diffFiles.set(await this.chatService.loadVersionDiff(this.chatId(), version.id));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to load version diff');
    } finally {
      this.loadingDiff.set(false);
    }
  }

  async restore(version: ChatVersion): Promise<void> {
    this.busyVersionId.set(version.id);
    this.error.set(null);
    const restored = await this.chatService.restoreVersion(this.chatId(), version.id);
    if (restored) {
      this.diffVersionId.set(null);
      this.diffFiles.set([]);
      await this.refresh();
    } else {
      this.error.set(this.chatService.error() ?? 'Failed to restore version');
    }
    this.busyVersionId.set(null);
  }

  async confirmRestore(version: ChatVersion): Promise<void> {
    try {
      await this.restore(version);
    } finally {
      this.pendingRestoreVersionId.set(null);
    }
  }

  async fork(version: ChatVersion): Promise<void> {
    this.busyVersionId.set(version.id);
    this.error.set(null);
    const chatId = await this.chatService.forkVersion(this.chatId(), version.id);
    if (!chatId) {
      this.error.set(this.chatService.error() ?? 'Failed to fork version');
    }
    this.busyVersionId.set(null);
  }

  protected readonly shortSha = shortSha;
}
