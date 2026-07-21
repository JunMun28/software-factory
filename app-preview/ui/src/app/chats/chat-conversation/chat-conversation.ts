import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowDown, lucideArrowUp, lucidePlus, lucideSquare } from '@ng-icons/lucide';

import { ChatService } from '../../services/chat.service';
import { WorkspaceShellService } from '../../services/workspace-shell.service';
import { ConfirmDialog } from '../confirm-dialog/confirm-dialog';
import { TurnBlock } from '../turn-block/turn-block';
import { VersionHistoryPanel } from '../version-history-panel/version-history-panel';

@Component({
  selector: 'app-chat-conversation',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmDialog, NgIcon, TurnBlock, VersionHistoryPanel],
  providers: [provideIcons({ lucideArrowDown, lucideArrowUp, lucidePlus, lucideSquare })],
  // The host element is a flex item of the shell's <main>; without these
  // classes it shrinks to content width and the layout is not full width.
  host: { class: 'flex h-full w-80 min-w-0 shrink-0 max-md:w-full' },
  template: `
    <section
      class="relative flex h-full min-w-0 flex-1 flex-col border-r border-border bg-background"
    >
      <div
        #scroller
        class="flex-1 space-y-3 overflow-y-auto px-3 py-3"
        role="log"
        aria-label="Generation activity"
        aria-live="polite"
        aria-relevant="additions text"
        (scroll)="onScroll()"
      >
        @if (chatService.activeTurns().length === 0) {
          <div
            class="flex min-h-full items-center justify-center px-6 text-center text-sm text-muted-foreground"
          >
            Ask the agent to build or change your app.
          </div>
        }

        @for (row of turnRows(); track $index; let turnIndex = $index) {
          <app-turn-block
            [turn]="row.turn"
            [versionDetail]="row.version"
            [restoreBusy]="restoringVersionId() === row.version?.id"
            (toggleGate)="toggleGate(turnIndex)"
            (restoreVersion)="restoreVersion($event)"
          />
        }
      </div>

      @if (showJumpToLatest()) {
        <button
          type="button"
          data-jump-to-latest
          class="absolute bottom-16 left-1/2 z-10 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium shadow-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          (click)="jumpToLatest()"
        >
          <ng-icon name="lucideArrowDown" size="13" /> Jump to latest
        </button>
      }

      <div class="shrink-0 space-y-2 px-3 pb-1">
        @if (chatService.error(); as error) {
          <div
            data-chat-error
            class="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            {{ error }}
          </div>
        }

        @if (chatService.notice(); as notice) {
          <div
            data-chat-notice
            class="rounded-md border border-border bg-muted/60 px-4 py-3 text-sm text-foreground"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {{ notice }}
          </div>
        }
      </div>

      <footer class="shrink-0 px-2 pb-2">
        <form
          class="flex min-h-[42px] items-end gap-1 rounded-xl border border-input bg-card p-1 shadow-xs focus-within:border-ring"
          (submit)="submitPrompt($event)"
        >
          <button
            type="button"
            class="workspace-icon-button mb-0.5 shrink-0"
            aria-label="Add attachment"
            title="Add attachment"
          >
            <ng-icon name="lucidePlus" size="16" />
          </button>
          <label class="min-w-0 flex-1">
            <span class="sr-only">Prompt</span>
            <textarea
              #promptInput
              class="max-h-32 min-h-8 w-full resize-none bg-transparent px-1.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
              [disabled]="chatService.turnRunning()"
              [value]="prompt()"
              (input)="prompt.set($any($event.target).value)"
              (keydown.enter)="onEnter($event)"
              placeholder="Describe what you want the agent to build or change…"
            ></textarea>
          </label>
          @if (chatService.turnRunning()) {
            <!-- The turn streams to completion; the orchestrator exposes no
                 interrupt endpoint yet, so this stop control is an honest,
                 disabled facade (matching Publish/Share) rather than a lie. -->
            <button
              type="button"
              data-stop-generation
              class="workspace-icon-button mb-0.5 shrink-0 bg-muted text-muted-foreground"
              aria-label="Stop generation — unavailable"
              title="Generation runs to completion"
              disabled
            >
              <ng-icon name="lucideSquare" size="14" />
            </button>
          } @else {
            <button
              type="submit"
              data-send-prompt
              class="workspace-icon-button mb-0.5 shrink-0 bg-primary text-primary-foreground disabled:opacity-40"
              [disabled]="!prompt().trim()"
              aria-label="Send prompt"
              title="Send prompt"
            >
              <ng-icon name="lucideArrowUp" size="16" />
            </button>
          }
        </form>
      </footer>
    </section>

    @if (pendingRestoreVersionId()) {
      <app-confirm-dialog
        title="Restore this version?"
        description="Your current work is saved as a new version first."
        confirmLabel="Restore"
        [busy]="!!restoringVersionId()"
        (confirmed)="confirmRestoreVersion()"
        (dismissed)="pendingRestoreVersionId.set(null)"
      />
    }

    @if (shell.versionHistoryOpen() && chatService.activeChatId(); as chatId) {
      <app-version-history-panel [chatId]="chatId" (closed)="shell.closeVersionHistory()" />
    }
  `,
})
export class ChatConversation {
  readonly chatService = inject(ChatService);
  readonly shell = inject(WorkspaceShellService);
  private readonly route = inject(ActivatedRoute);
  private readonly stickToBottom = signal(true);

  readonly prompt = signal('');
  readonly pendingRestoreVersionId = signal<string | null>(null);
  readonly restoringVersionId = signal<string | null>(null);
  readonly showJumpToLatest = computed(
    () => !this.stickToBottom() && this.chatService.turnRunning(),
  );

  readonly turnRows = computed(() => {
    const byCommit = this.chatService.activeVersionsByCommit();
    return this.chatService.activeTurns().map((turn) => ({
      turn,
      version: turn.version?.commit ? (byCommit.get(turn.version.commit) ?? null) : null,
    }));
  });

  private readonly scroller = viewChild<ElementRef<HTMLDivElement>>('scroller');
  private readonly promptInput = viewChild<ElementRef<HTMLTextAreaElement>>('promptInput');
  private pendingScrollFrame: ReturnType<typeof requestAnimationFrame> | null = null;

  constructor() {
    this.route.paramMap.subscribe((params) => {
      const chatId = params.get('id');
      if (chatId) {
        this.chatService.setActiveChat(chatId);
        this.stickToBottom.set(true);
        void this.chatService.hydrateChat(chatId);
        queueMicrotask(() => this.promptInput()?.nativeElement.focus());
      }
    });

    // Follow the stream like a terminal: stay pinned to the newest activity
    // unless the user has scrolled up to read something.
    effect(() => {
      this.chatService.streamActivityTick();
      this.chatService.activeTurns();
      const element = this.scroller()?.nativeElement;
      if (element && this.stickToBottom() && this.pendingScrollFrame === null) {
        this.pendingScrollFrame = requestAnimationFrame(() => {
          this.pendingScrollFrame = null;
          element.scrollTop = element.scrollHeight;
        });
      }
    });
  }

  onScroll(): void {
    const element = this.scroller()?.nativeElement;
    if (!element) {
      return;
    }
    this.stickToBottom.set(
      element.scrollHeight - element.scrollTop - element.clientHeight < 48,
    );
  }

  jumpToLatest(): void {
    this.stickToBottom.set(true);
    const element = this.scroller()?.nativeElement;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }

  onEnter(event: Event): void {
    const keyboard = event as KeyboardEvent;
    if (keyboard.shiftKey) {
      return;
    }
    keyboard.preventDefault();
    this.submitPrompt(event);
  }

  submitPrompt(event: Event): void {
    event.preventDefault();
    const chatId = this.chatService.activeChatId();
    const value = this.prompt().trim();
    if (!chatId || !value || this.chatService.turnRunning()) {
      return;
    }

    this.prompt.set('');
    this.stickToBottom.set(true);
    void this.chatService.sendTurn(chatId, value);
  }

  restoreVersion(versionId: string): void {
    this.pendingRestoreVersionId.set(versionId);
  }

  async confirmRestoreVersion(): Promise<void> {
    const chatId = this.chatService.activeChatId();
    const versionId = this.pendingRestoreVersionId();
    if (!chatId || !versionId) {
      this.pendingRestoreVersionId.set(null);
      return;
    }

    if (this.restoringVersionId()) {
      return;
    }

    this.restoringVersionId.set(versionId);
    try {
      await this.chatService.restoreVersion(chatId, versionId);
    } finally {
      this.pendingRestoreVersionId.set(null);
      this.restoringVersionId.set(null);
    }
  }

  toggleGate(turnIndex: number): void {
    const chatId = this.chatService.activeChatId();
    if (!chatId) {
      return;
    }
    this.chatService.toggleGateExpanded(chatId, turnIndex);
  }
}
