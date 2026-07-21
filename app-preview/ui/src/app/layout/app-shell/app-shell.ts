import { Component, inject, OnInit } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePanelLeftOpen } from '@ng-icons/lucide';
import { RouterOutlet } from '@angular/router';

import { ChatSidebar } from '../../chats/chat-sidebar/chat-sidebar';
import { ChatService } from '../../services/chat.service';
import { WorkspaceShellService } from '../../services/workspace-shell.service';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, ChatSidebar, NgIcon],
  providers: [provideIcons({ lucidePanelLeftOpen })],
  template: `
    <a
      href="#main-content"
      class="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
    >
      Skip to main content
    </a>
    <div class="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <app-chat-sidebar />
      <main id="main-content" tabindex="-1" class="relative min-h-0 min-w-0 flex-1 overflow-auto">
        <button
          type="button"
          class="workspace-icon-button mobile-only absolute left-3 top-3 z-40"
          aria-label="Open sidebar"
          (click)="shell.openMobileSidebar()"
        >
          <ng-icon name="lucidePanelLeftOpen" size="16" />
        </button>
        @if (shell.sidebarCollapsed()) {
          <button
            type="button"
            class="workspace-icon-button desktop-only absolute left-3 top-3 z-40"
            aria-label="Expand sidebar"
            (click)="shell.toggleSidebar()"
          >
            <ng-icon name="lucidePanelLeftOpen" size="16" />
          </button>
        }
        <router-outlet />
      </main>
    </div>
  `,
})
export class AppShell implements OnInit {
  private readonly chatService = inject(ChatService);
  readonly shell = inject(WorkspaceShellService);

  ngOnInit(): void {
    void this.chatService.loadChats();
  }
}
