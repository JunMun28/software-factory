import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
  lucideEllipsis,
  lucidePencil,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';

import { FocusTrap } from '../../lib/focus-trap';
import { ChatService } from '../../services/chat.service';
import type { ChatSummary } from '../../types/orchestrator-events';

@Component({
  selector: 'app-chat-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FocusTrap, NgIcon],
  providers: [
    provideIcons({ lucideChevronDown, lucideEllipsis, lucidePencil, lucideTrash2, lucideX }),
  ],
  host: { class: 'relative min-w-0' },
  template: `
    @if (variant() === 'title') {
      <button
        type="button"
        class="flex min-w-0 max-w-full items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        [attr.aria-label]="'Open chat actions for ' + title()"
        [attr.aria-expanded]="menuOpen()"
        (click)="toggleMenu()"
      >
        <span class="truncate">{{ title() }}</span>
        <ng-icon class="shrink-0" name="lucideChevronDown" size="14" />
      </button>
    } @else {
      <button
        type="button"
        class="workspace-icon-button"
        [attr.aria-label]="'Open chat actions for ' + title()"
        [attr.aria-expanded]="menuOpen()"
        (click)="toggleMenu()"
      >
        <ng-icon name="lucideEllipsis" size="15" />
      </button>
    }

    @if (menuOpen()) {
      <div
        focusTrap
        role="menu"
        class="absolute left-0 top-full z-50 mt-1 w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        [class.left-auto]="variant() === 'icon'"
        [class.right-0]="variant() === 'icon'"
        (focusTrapEscape)="closeMenu()"
      >
        <button
          autoFocusTarget
          type="button"
          role="menuitem"
          data-rename-chat
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
          (click)="openRename()"
        >
          <ng-icon name="lucidePencil" size="14" /> Rename
        </button>
        <button
          type="button"
          role="menuitem"
          data-delete-chat
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          [disabled]="currentChat().status === 'running'"
          [title]="
            currentChat().status === 'running'
              ? 'Delete unavailable while a turn is running'
              : 'Delete chat'
          "
          (click)="openDelete()"
        >
          <ng-icon name="lucideTrash2" size="14" /> Delete
        </button>
      </div>
    }

    @if (dialog() === 'rename') {
      <div
        class="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 px-4"
        (click)="closeDialog()"
      >
        <section
          focusTrap
          role="dialog"
          aria-modal="true"
          aria-labelledby="rename-chat-title"
          class="w-full max-w-[420px] rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl"
          (click)="$event.stopPropagation()"
          (focusTrapEscape)="closeDialog()"
        >
          <header class="flex items-start gap-4">
            <div class="min-w-0 flex-1">
              <h2 id="rename-chat-title" class="text-lg font-semibold">Rename chat</h2>
              <p class="mt-1 text-sm text-muted-foreground">
                Choose a clear name for this workspace.
              </p>
            </div>
            <button
              type="button"
              class="workspace-icon-button"
              aria-label="Close rename chat"
              (click)="closeDialog()"
            >
              <ng-icon name="lucideX" size="16" />
            </button>
          </header>
          <form class="mt-5" (submit)="rename($event)">
            <label class="block text-sm font-medium" for="chat-title">Chat title</label>
            <input
              id="chat-title"
              autoFocusTarget
              aria-label="Chat title"
              class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              [value]="titleDraft()"
              (input)="titleDraft.set($any($event.target).value)"
            />
            @if (actionError(); as message) {
              <p class="mt-3 text-sm text-destructive" role="alert">{{ message }}</p>
            }
            <div class="mt-6 flex justify-end gap-2">
              <button
                type="button"
                class="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
                (click)="closeDialog()"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="inline-flex h-9 items-center rounded-md bg-foreground px-3 text-sm font-medium text-background disabled:opacity-40"
                [disabled]="busy() || !titleDraft().trim()"
              >
                Save
              </button>
            </div>
          </form>
        </section>
      </div>
    }

    @if (dialog() === 'delete') {
      <div
        class="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 px-4"
        (click)="closeDialog()"
      >
        <section
          focusTrap
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-chat-title"
          class="w-full max-w-[420px] rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl"
          (click)="$event.stopPropagation()"
          (focusTrapEscape)="closeDialog()"
        >
          <h2 id="delete-chat-title" class="text-lg font-semibold">Delete chat?</h2>
          <p class="mt-2 text-sm text-muted-foreground">
            “{{ title() }}” and its workspace history will be permanently deleted.
          </p>
          @if (actionError(); as message) {
            <p class="mt-3 text-sm text-destructive" role="alert">{{ message }}</p>
          }
          <div class="mt-6 flex justify-end gap-2">
            <button
              autoFocusTarget
              type="button"
              class="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
              (click)="closeDialog()"
            >
              Cancel
            </button>
            <button
              data-confirm-delete
              type="button"
              class="inline-flex h-9 items-center rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground disabled:opacity-40"
              [disabled]="busy()"
              (click)="deleteChat()"
            >
              Delete
            </button>
          </div>
        </section>
      </div>
    }
  `,
})
export class ChatActions {
  private readonly chatService = inject(ChatService);

  readonly chat = input.required<ChatSummary>();
  readonly variant = input<'title' | 'icon'>('icon');
  readonly menuOpen = signal(false);
  readonly dialog = signal<'rename' | 'delete' | null>(null);
  readonly titleDraft = signal('');
  readonly busy = signal(false);
  readonly actionError = signal<string | null>(null);
  readonly currentChat = computed(
    () =>
      this.chatService.chats().find((chat) => chat.chatId === this.chat().chatId) ?? this.chat(),
  );
  readonly title = computed(
    () => this.currentChat().title || this.currentChat().chatId.slice(0, 8),
  );

  toggleMenu(): void {
    this.menuOpen.update((open) => !open);
    this.actionError.set(null);
  }

  closeMenu(): void {
    this.menuOpen.set(false);
  }

  openRename(): void {
    this.closeMenu();
    this.titleDraft.set(this.title());
    this.actionError.set(null);
    this.dialog.set('rename');
  }

  openDelete(): void {
    if (this.currentChat().status === 'running') {
      return;
    }
    this.closeMenu();
    this.actionError.set(null);
    this.dialog.set('delete');
  }

  closeDialog(): void {
    if (this.busy()) {
      return;
    }
    this.dialog.set(null);
    this.actionError.set(null);
  }

  async rename(event: Event): Promise<void> {
    event.preventDefault();
    this.busy.set(true);
    this.actionError.set(null);
    const updated = await this.chatService.renameChat(this.currentChat().chatId, this.titleDraft());
    this.busy.set(false);
    if (updated) {
      this.dialog.set(null);
      return;
    }
    this.actionError.set(this.chatService.error() ?? 'Failed to rename chat');
  }

  async deleteChat(): Promise<void> {
    this.busy.set(true);
    this.actionError.set(null);
    const deleted = await this.chatService.deleteChat(this.currentChat().chatId);
    this.busy.set(false);
    if (deleted) {
      this.dialog.set(null);
      return;
    }
    this.actionError.set(
      this.chatService.notice() ?? this.chatService.error() ?? 'Failed to delete chat',
    );
  }
}
