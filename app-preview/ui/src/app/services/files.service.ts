import { Injectable, signal } from '@angular/core';

import type { FileStatus, WorkspaceFileEntry } from '../lib/build-file-tree';
import { errorMessage } from '../lib/http-error';

@Injectable({ providedIn: 'root' })
export class FilesService {
  readonly files = signal<WorkspaceFileEntry[]>([]);
  readonly loadingTree = signal(false);
  readonly loadingDetail = signal(false);
  readonly selectedPath = signal<string | null>(null);
  readonly selectedStatus = signal<FileStatus | null>(null);
  readonly fileContent = signal<string | null>(null);
  readonly fileDiff = signal<string | null>(null);
  readonly detailError = signal<string | null>(null);

  private activeChatId: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private treeRequestId = 0;
  private detailRequestId = 0;
  private treeAbort: AbortController | null = null;
  private detailAbort: AbortController | null = null;

  attach(chatId: string): void {
    if (this.activeChatId === chatId) {
      return;
    }

    this.detach();
    this.activeChatId = chatId;
    this.scheduleTreeRefresh(true);
  }

  detach(): void {
    this.clearRefreshTimer();
    this.treeAbort?.abort();
    this.detailAbort?.abort();
    this.treeAbort = null;
    this.detailAbort = null;
    this.activeChatId = null;
    this.files.set([]);
    this.selectedPath.set(null);
    this.selectedStatus.set(null);
    this.fileContent.set(null);
    this.fileDiff.set(null);
    this.detailError.set(null);
    this.loadingTree.set(false);
    this.loadingDetail.set(false);
  }

  scheduleTreeRefresh(immediate = false): void {
    if (!this.activeChatId) {
      return;
    }

    this.clearRefreshTimer();
    const delay = immediate ? 0 : 300;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshTree();
    }, delay);
  }

  async selectFile(path: string, status: FileStatus): Promise<void> {
    this.selectedPath.set(path);
    this.selectedStatus.set(status);
    await this.loadFileDetail(path, status);
  }

  async refreshSelectedFile(): Promise<void> {
    const path = this.selectedPath();
    const status = this.selectedStatus();
    if (!path || !status) {
      return;
    }
    await this.loadFileDetail(path, status);
  }

  private async refreshTree(): Promise<void> {
    const chatId = this.activeChatId;
    if (!chatId) {
      return;
    }

    this.treeAbort?.abort();
    const controller = new AbortController();
    this.treeAbort = controller;
    const requestId = ++this.treeRequestId;
    this.loadingTree.set(true);

    try {
      const response = await fetch(`/api/chats/${chatId}/files`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to load files'));
      }

      const body = (await response.json()) as { files: WorkspaceFileEntry[] };
      if (requestId !== this.treeRequestId || controller.signal.aborted) {
        return;
      }

      this.files.set(body.files ?? []);
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      this.detailError.set(
        error instanceof Error ? error.message : 'Failed to load file tree',
      );
    } finally {
      if (requestId === this.treeRequestId) {
        this.loadingTree.set(false);
      }
    }
  }

  private async loadFileDetail(path: string, status: FileStatus): Promise<void> {
    const chatId = this.activeChatId;
    if (!chatId) {
      return;
    }

    this.detailAbort?.abort();
    const controller = new AbortController();
    this.detailAbort = controller;
    const requestId = ++this.detailRequestId;
    this.loadingDetail.set(true);
    this.detailError.set(null);

    try {
      if (status === 'unchanged') {
        const response = await fetch(
          `/api/chats/${chatId}/files/content?path=${encodeURIComponent(path)}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          throw new Error(await errorMessage(response, 'Failed to load file content'));
        }
        const body = (await response.json()) as { content: string };
        if (requestId !== this.detailRequestId || controller.signal.aborted) {
          return;
        }
        this.fileDiff.set(null);
        this.fileContent.set(body.content);
        return;
      }

      const response = await fetch(
        `/api/chats/${chatId}/files/diff?path=${encodeURIComponent(path)}`,
        { signal: controller.signal },
      );
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to load file diff'));
      }
      const body = (await response.json()) as { diff: string };
      if (requestId !== this.detailRequestId || controller.signal.aborted) {
        return;
      }
      this.fileContent.set(null);
      this.fileDiff.set(body.diff ?? '');
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      this.fileContent.set(null);
      this.fileDiff.set(null);
      this.detailError.set(
        error instanceof Error ? error.message : 'Failed to load file detail',
      );
    } finally {
      if (requestId === this.detailRequestId) {
        this.loadingDetail.set(false);
      }
    }
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
