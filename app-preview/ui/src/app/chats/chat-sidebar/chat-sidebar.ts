import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
  lucideHome,
  lucideLayoutTemplate,
  lucideMessageSquare,
  lucideMoon,
  lucidePanelLeftClose,
  lucidePanelsTopLeft,
  lucideSearch,
  lucideShapes,
  lucideSun,
  lucideX,
} from '@ng-icons/lucide';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { FocusTrap } from '../../lib/focus-trap';
import { ChatService } from '../../services/chat.service';
import { ThemeService } from '../../services/theme.service';
import { WorkspaceShellService } from '../../services/workspace-shell.service';

@Component({
  selector: 'app-chat-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, NgIcon, FocusTrap],
  providers: [
    provideIcons({
      lucideChevronDown,
      lucideHome,
      lucideLayoutTemplate,
      lucideMessageSquare,
      lucideMoon,
      lucidePanelLeftClose,
      lucidePanelsTopLeft,
      lucideSearch,
      lucideShapes,
      lucideSun,
      lucideX,
    }),
  ],
  template: `
    @if (!shell.sidebarCollapsed()) {
      @if (shell.mobileSidebarOpen()) {
        <button
          type="button"
          class="workspace-sidebar-backdrop"
          aria-label="Close sidebar"
          (click)="shell.closeMobileSidebar()"
        ></button>
      }
      <aside
        class="workspace-sidebar flex h-full w-[275px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
        [class.workspace-sidebar-mobile-open]="shell.mobileSidebarOpen()"
        [attr.inert]="mobileSidebarInert() ? '' : null"
        [attr.aria-hidden]="mobileSidebarInert() ? 'true' : null"
      >
        <div class="flex h-[50px] shrink-0 items-center gap-2 px-3">
          <img class="size-6 rounded-full" src="/personal-avatar.png" alt="Dana Reyes" />
          <span data-testid="workspace-label" class="min-w-0 flex-1 truncate text-sm font-medium">Personal</span>
          <button
            type="button"
            class="workspace-icon-button desktop-only"
            aria-label="Collapse sidebar"
            [attr.aria-expanded]="true"
            (click)="shell.toggleSidebar()"
          >
            <ng-icon name="lucidePanelLeftClose" size="16" />
          </button>
          <button
            type="button"
            class="workspace-icon-button mobile-only"
            aria-label="Close mobile sidebar"
            (click)="shell.closeMobileSidebar()"
          >
            <ng-icon name="lucidePanelLeftClose" size="16" />
          </button>
        </div>

        <div class="px-2">
        <a
          data-nav="new-chat"
          routerLink="/"
          (click)="shell.closeMobileSidebar()"
          class="relative flex h-9 w-full items-center justify-center rounded-md border border-border bg-card text-sm font-medium transition-colors hover:bg-muted"
        >
          New Chat
        </a>
        </div>

        <nav class="mt-3 space-y-0.5 px-2 text-sm text-muted-foreground" aria-label="Product navigation">
          <button type="button" class="sidebar-nav-row" aria-label="Search" (click)="openSearch()"><ng-icon name="lucideSearch" size="16" /><span>Search</span></button>
          <a data-nav="home" routerLink="/" routerLinkActive="bg-sidebar-accent text-sidebar-accent-foreground" ariaCurrentWhenActive="page" [routerLinkActiveOptions]="{ exact: true }" class="sidebar-nav-row" (click)="shell.closeMobileSidebar()"><ng-icon name="lucideHome" size="16" /><span>Home</span></a>
          <a data-nav="projects" routerLink="/projects" routerLinkActive="bg-sidebar-accent text-sidebar-accent-foreground" ariaCurrentWhenActive="page" class="sidebar-nav-row" (click)="shell.closeMobileSidebar()"><ng-icon name="lucidePanelsTopLeft" size="16" /><span>Projects</span></a>
          <a data-nav="chats" routerLink="/chats" routerLinkActive="bg-sidebar-accent text-sidebar-accent-foreground" ariaCurrentWhenActive="page" [routerLinkActiveOptions]="{ exact: true }" class="sidebar-nav-row" (click)="shell.closeMobileSidebar()"><ng-icon name="lucideMessageSquare" size="16" /><span>Chats</span></a>
          <a data-nav="design-systems" routerLink="/design-systems" routerLinkActive="bg-sidebar-accent text-sidebar-accent-foreground" ariaCurrentWhenActive="page" class="sidebar-nav-row" (click)="shell.closeMobileSidebar()"><ng-icon name="lucideShapes" size="16" /><span>Design Systems</span></a>
          <a data-nav="templates" routerLink="/templates" routerLinkActive="bg-sidebar-accent text-sidebar-accent-foreground" ariaCurrentWhenActive="page" class="sidebar-nav-row" (click)="shell.closeMobileSidebar()"><ng-icon name="lucideLayoutTemplate" size="16" /><span>Templates</span></a>
      </nav>

      <div class="flex-1 overflow-y-auto px-2 py-4">
        <p class="mb-7 flex items-center justify-between px-2 text-xs text-muted-foreground">
          <span>Favorites</span>
          <span aria-hidden="true">›</span>
        </p>
        <p class="mb-1 flex items-center justify-between px-2 text-xs text-muted-foreground">
          <span>Recent Chats</span>
          <ng-icon name="lucideChevronDown" size="13" />
        </p>
        @if (chatService.loadingChats()) {
          <p class="px-3 py-2 text-sm text-muted-foreground">Loading chats…</p>
        } @else if (chatService.error(); as error) {
          <p data-chat-list-error class="px-3 py-2 text-sm text-destructive">{{ error }}</p>
        } @else if (chatService.visibleChats().length === 0) {
          <p class="px-3 py-2 text-sm text-muted-foreground">No chats yet. Start one to build an app.</p>
        } @else {
          <nav class="space-y-1">
            @for (chat of chatService.visibleChats(); track chat.chatId) {
              <a
                [routerLink]="['/chats', chat.chatId]"
                (click)="shell.closeMobileSidebar()"
                routerLinkActive="bg-sidebar-accent text-sidebar-accent-foreground"
                class="flex h-8 items-center justify-between rounded-md px-2 text-sm transition-colors hover:bg-sidebar-accent/70"
              >
                <span class="truncate font-medium">{{ chat.title || chat.chatId.slice(0, 8) }}</span>
                @if (chat.status === 'running') {
                  <span class="ml-2 shrink-0 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                    running
                  </span>
                }
              </a>
            }
          </nav>
        }
        <a data-nav="more" routerLink="/chats" class="mt-1 flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground" (click)="shell.closeMobileSidebar()">
          <span aria-hidden="true">•••</span>
          <span>More</span>
        </a>
      </div>

      <div class="flex h-[50px] shrink-0 items-center gap-2 border-t border-sidebar-border px-3">
        <img class="size-6 rounded-full" src="/personal-avatar.png" alt="Dana Reyes" />
        <span class="min-w-0 flex-1 truncate text-sm">Dana Reyes</span>
        <button
          type="button"
          class="workspace-icon-button"
          [attr.aria-label]="themeService.theme() === 'dark' ? 'Use light mode' : 'Use dark mode'"
          (click)="themeService.toggle()"
        >
          <ng-icon [name]="themeService.theme() === 'dark' ? 'lucideSun' : 'lucideMoon'" size="15" />
        </button>
      </div>
    </aside>
    }

    @if (searchOpen()) {
      <div class="fixed inset-0 z-[80] flex items-start justify-center bg-black/65 px-4 pt-[14vh]" (click)="closeSearch()">
        <section
          focusTrap
          class="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-label="Command"
          (click)="$event.stopPropagation()"
          (focusTrapEscape)="closeSearch()"
        >
          <div class="flex h-12 items-center gap-3 border-b border-border px-4">
            <ng-icon class="text-muted-foreground" name="lucideSearch" size="17" />
            <input
              autoFocusTarget
              class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              aria-label="Search navigation and chats"
              placeholder="Search chats and commands…"
              [value]="searchQuery()"
              (input)="searchQuery.set($any($event.target).value)"
            />
            <button type="button" class="workspace-icon-button" aria-label="Close search" (click)="closeSearch()">
              <ng-icon name="lucideX" size="15" />
            </button>
          </div>

          <div class="max-h-[60vh] space-y-4 overflow-y-auto p-2">
            <div>
              <p class="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Quick Actions</p>
              <nav class="space-y-0.5">
                <a routerLink="/" class="sidebar-nav-row text-foreground" (click)="closeSearch()">New Chat</a>
                <a routerLink="/projects" class="sidebar-nav-row text-foreground" (click)="closeSearch()">Projects</a>
              </nav>
            </div>

            <div>
              <p class="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Navigation</p>
              <nav class="space-y-0.5">
                <a routerLink="/chats" class="sidebar-nav-row text-foreground" (click)="closeSearch()">All Recent Chats</a>
                <a routerLink="/design-systems" class="sidebar-nav-row text-foreground" (click)="closeSearch()">Design Systems</a>
                <a routerLink="/templates" class="sidebar-nav-row text-foreground" (click)="closeSearch()">Templates</a>
              </nav>
            </div>

            @if (chatService.visibleChats().length > 0) {
              <div>
                <p class="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Recent Chats</p>
                <nav class="space-y-0.5">
                  @for (chat of chatService.visibleChats(); track chat.chatId) {
                    @if (matchesSearch(chat.title || chat.chatId)) {
                      <a [routerLink]="['/chats', chat.chatId]" class="sidebar-nav-row text-foreground" (click)="closeSearch()">
                        <span class="truncate">{{ chat.title || chat.chatId.slice(0, 8) }}</span>
                      </a>
                    }
                  }
                </nav>
              </div>
            }
          </div>
        </section>
      </div>
    }
  `,
})
export class ChatSidebar {
  private readonly destroyRef = inject(DestroyRef);
  readonly chatService = inject(ChatService);
  readonly themeService = inject(ThemeService);
  readonly shell = inject(WorkspaceShellService);
  readonly searchOpen = signal(false);
  readonly searchQuery = signal('');
  private readonly mobileMediaQuery =
    typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia('(max-width: 767px)')
      : null;
  readonly mobileViewport = signal(this.mobileMediaQuery?.matches ?? false);
  readonly mobileSidebarInert = computed(
    () => this.mobileViewport() && !this.shell.mobileSidebarOpen(),
  );

  constructor() {
    const updateMobileViewport = (event: MediaQueryListEvent): void => {
      this.mobileViewport.set(event.matches);
    };
    this.mobileMediaQuery?.addEventListener('change', updateMobileViewport);
    this.destroyRef.onDestroy(() =>
      this.mobileMediaQuery?.removeEventListener('change', updateMobileViewport),
    );
  }

  openSearch(): void {
    this.searchQuery.set('');
    this.shell.closeMobileSidebar();
    this.searchOpen.set(true);
  }

  closeSearch(): void {
    this.searchOpen.set(false);
  }

  matchesSearch(value: string): boolean {
    return value.toLocaleLowerCase().includes(this.searchQuery().trim().toLocaleLowerCase());
  }
}
