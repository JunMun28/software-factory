import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFilter,
  lucideFolder,
  lucideSearch,
  lucideStar,
} from '@ng-icons/lucide';
import { RouterLink } from '@angular/router';

import { ChatActions } from '../../chats/chat-actions/chat-actions';
import { ChatService } from '../../services/chat.service';

@Component({
  selector: 'app-chats-page',
  imports: [ChatActions, NgIcon, RouterLink],
  providers: [
    provideIcons({ lucideFilter, lucideFolder, lucideSearch, lucideStar }),
  ],
  template: `
    <section class="mx-auto min-h-full w-full max-w-[1160px] px-8 py-10 max-sm:px-4 max-sm:py-6">
      <h1 class="text-3xl font-semibold tracking-tight">Chats</h1>

      <div class="mt-7 flex items-center gap-2">
        <label class="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-card px-3">
          <ng-icon class="text-muted-foreground" name="lucideSearch" size="15" />
          <span class="sr-only">Search chats</span>
          <input
            class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Search chats"
            placeholder="Search chats..."
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
        </label>
        <button
          type="button"
          class="workspace-icon-button"
          aria-label="Folders — coming soon"
          title="Folders — coming soon"
          disabled
        >
          <ng-icon name="lucideFolder" size="16" />
        </button>
        <button
          type="button"
          class="workspace-icon-button"
          aria-label="Filter chats — coming soon"
          title="Filter chats — coming soon"
          disabled
        >
          <ng-icon name="lucideFilter" size="16" />
        </button>
      </div>

      <div class="mt-5 overflow-hidden rounded-lg border border-border">
        <div class="grid grid-cols-[minmax(0,1fr)_200px_120px_36px] gap-3 border-b border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground max-md:grid-cols-[minmax(0,1fr)_90px_32px]">
          <span>Name</span>
          <span class="max-md:hidden">Project</span>
          <span>Updated</span>
          <span></span>
        </div>

        @if (filteredChats().length === 0 && chatService.loadingChats()) {
          <div class="px-5 py-14 text-center text-sm text-muted-foreground">Loading chats…</div>
        } @else if (filteredChats().length === 0 && query().trim()) {
          <div class="px-5 py-14 text-center text-sm text-muted-foreground">No chats match this search.</div>
        } @else if (filteredChats().length === 0) {
          <div class="px-5 py-14 text-center text-sm text-muted-foreground">No chats yet. Start one to build an app.</div>
        } @else {
          @for (chat of filteredChats(); track chat.chatId) {
            <div class="grid min-h-14 grid-cols-[minmax(0,1fr)_200px_120px_36px] items-center gap-3 border-b border-border px-4 last:border-b-0 hover:bg-muted/30 max-md:grid-cols-[minmax(0,1fr)_90px_32px]">
              <a [routerLink]="['/chats', chat.chatId]" class="min-w-0 truncate text-sm font-medium hover:underline">
                {{ chat.title || chat.chatId.slice(0, 8) }}
              </a>
              <span class="truncate text-xs text-muted-foreground max-md:hidden">Local workspace</span>
              <span class="text-xs text-muted-foreground">{{ chat.status === 'running' ? 'Running' : 'Local' }}</span>
              <app-chat-actions [chat]="chat" />
            </div>
          }
        }
      </div>
    </section>
  `,
})
export class ChatsPage implements OnInit {
  readonly chatService = inject(ChatService);
  readonly query = signal('');
  readonly filteredChats = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return query
      ? this.chatService.visibleChats().filter((chat) =>
          (chat.title || chat.chatId).toLocaleLowerCase().includes(query),
        )
      : this.chatService.visibleChats();
  });

  ngOnInit(): void {
    if (!this.chatService.chats().length && !this.chatService.loadingChats()) {
      void this.chatService.loadChats();
    }
  }
}
