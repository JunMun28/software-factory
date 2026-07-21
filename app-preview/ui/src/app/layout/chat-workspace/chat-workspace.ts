import { Component, inject, OnInit } from '@angular/core';

import { ChatConversation } from '../../chats/chat-conversation/chat-conversation';
import { ChatSidebar } from '../../chats/chat-sidebar/chat-sidebar';
import { RightPanel } from '../../panels/right-panel/right-panel';
import { ChatService } from '../../services/chat.service';
import { WorkspaceShellService } from '../../services/workspace-shell.service';
import { WorkspaceToolbar } from '../workspace-toolbar/workspace-toolbar';

@Component({
  selector: 'app-chat-workspace',
  imports: [ChatConversation, ChatSidebar, RightPanel, WorkspaceToolbar],
  template: `
    <a
      href="#main-content"
      class="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
    >
      Skip to main content
    </a>
    <div class="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <app-chat-sidebar />

      <div class="flex min-w-0 flex-1 flex-col">
        <app-workspace-toolbar />

        <div class="hidden h-11 shrink-0 border-b border-border bg-background p-2 max-md:block">
          <div
            class="grid h-full grid-cols-2 rounded-md border border-border bg-card p-0.5"
            role="tablist"
            aria-label="Mobile workspace panes"
          >
            <button
              type="button"
              role="tab"
              aria-label="Show chat"
              [attr.aria-selected]="shell.mobilePane() === 'chat'"
              class="rounded text-sm text-muted-foreground"
              [class.bg-muted]="shell.mobilePane() === 'chat'"
              [class.text-foreground]="shell.mobilePane() === 'chat'"
              (click)="shell.setMobilePane('chat')"
            >
              Chat
            </button>
            <button
              type="button"
              role="tab"
              aria-label="Show preview"
              [attr.aria-selected]="shell.mobilePane() === 'preview'"
              class="rounded text-sm text-muted-foreground"
              [class.bg-muted]="shell.mobilePane() === 'preview'"
              [class.text-foreground]="shell.mobilePane() === 'preview'"
              (click)="shell.setMobilePane('preview')"
            >
              Preview
            </button>
          </div>
        </div>

        <main
          id="main-content"
          tabindex="-1"
          class="flex min-h-0 min-w-0 flex-1"
          [attr.data-mobile-pane]="shell.mobilePane()"
        >
          <app-chat-conversation />
          <app-right-panel />
        </main>
      </div>
    </div>
  `,
})
export class ChatWorkspace implements OnInit {
  private readonly chatService = inject(ChatService);
  readonly shell = inject(WorkspaceShellService);

  ngOnInit(): void {
    void this.chatService.loadChats();
  }
}
