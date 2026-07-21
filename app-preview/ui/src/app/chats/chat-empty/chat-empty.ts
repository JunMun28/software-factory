import { Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUp,
  lucideBox,
  lucideCheck,
  lucideChevronDown,
  lucideFolder,
  lucideLoaderCircle,
  lucideMic,
  lucidePlus,
  lucideRefreshCw,
  lucideSearch,
} from '@ng-icons/lucide';
import { RouterLink } from '@angular/router';

import { FocusTrap } from '../../lib/focus-trap';
import { ChatService } from '../../services/chat.service';
import { ModelService } from '../../services/model.service';
import { ProjectService } from '../../services/project.service';
import { filterByName } from '../../lib/name-filter';

@Component({
  selector: 'app-chat-empty',
  imports: [NgIcon, RouterLink, FocusTrap],
  providers: [
    provideIcons({
      lucideArrowUp,
      lucideBox,
      lucideCheck,
      lucideChevronDown,
      lucideFolder,
      lucideLoaderCircle,
      lucideMic,
      lucidePlus,
      lucideRefreshCw,
      lucideSearch,
    }),
  ],
  host: { class: 'flex h-full min-w-0 flex-1' },
  template: `
    <section class="flex h-full min-w-0 flex-1 items-center justify-center px-6 pb-[10vh]">
      <div class="w-full max-w-[690px] space-y-5">
        <h1 class="text-center text-[30px] font-semibold tracking-[-0.03em]">
          What do you want to create?
        </h1>

        <form
          class="relative rounded-xl border border-border bg-card p-3 shadow-sm focus-within:border-muted-foreground/50"
          (submit)="start($event)"
        >
          <label>
            <span class="sr-only">Ask ng-v0 to build</span>
            <textarea
              autofocus
              class="min-h-20 w-full resize-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
              [disabled]="starting()"
              [value]="prompt()"
              (input)="prompt.set($any($event.target).value)"
              (keydown.enter)="onEnter($event)"
              placeholder="Ask ng-v0 to build…"
            ></textarea>
          </label>
          <div class="flex items-center gap-1 pt-2">
            <button
              type="button"
              class="workspace-icon-button"
              aria-label="Add attachment — unavailable"
              title="Add attachment — unavailable"
              disabled
            >
              <ng-icon name="lucidePlus" size="17" />
            </button>
            <button
              type="button"
              data-testid="model-trigger"
              class="inline-flex h-8 max-w-48 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-haspopup="menu"
              [attr.aria-expanded]="modelMenuOpen()"
              [attr.aria-label]="'Select model, ' + modelService.selectedLabel()"
              (click)="toggleModelMenu($event)"
            >
              <ng-icon name="lucideBox" size="15" />
              <span class="truncate">{{ modelService.selectedLabel() }}</span>
              <ng-icon name="lucideChevronDown" size="13" />
            </button>
            <button
              type="button"
              data-testid="project-trigger"
              class="ml-auto inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-haspopup="menu"
              [attr.aria-expanded]="projectMenuOpen()"
              [attr.aria-label]="
                'Select project, ' + (projectService.selectedProject()?.name || 'Project')
              "
              (click)="toggleProjectMenu($event)"
            >
              <span class="max-w-40 truncate">{{
                projectService.selectedProject()?.name || 'Project'
              }}</span>
              <ng-icon name="lucideChevronDown" size="12" />
            </button>
            <button
              type="button"
              class="workspace-icon-button"
              aria-label="Use voice input — unavailable"
              title="Use voice input — unavailable"
              disabled
            >
              <ng-icon name="lucideMic" size="16" />
            </button>
            <button
              type="submit"
              class="workspace-icon-button bg-foreground text-background disabled:opacity-35"
              [disabled]="starting() || !prompt().trim()"
              [attr.aria-label]="starting() ? 'Creating chat' : 'Start building'"
            >
              @if (starting()) {
                <ng-icon class="animate-spin" name="lucideLoaderCircle" size="16" />
              } @else {
                <ng-icon name="lucideArrowUp" size="16" />
              }
            </button>
          </div>

          @if (modelMenuOpen()) {
            <div
              focusTrap
              role="menu"
              aria-label="Available models"
              class="absolute bottom-14 left-10 z-50 w-[min(360px,calc(100%-1.5rem))] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
              (click)="$event.stopPropagation()"
              (focusTrapEscape)="closeModelMenu()"
            >
              <div class="border-b border-border p-2">
                <label
                  class="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-2.5 focus-within:ring-2 focus-within:ring-ring"
                >
                  <ng-icon name="lucideSearch" size="14" class="text-muted-foreground" />
                  <span class="sr-only">Search models</span>
                  <input
                    autoFocusTarget
                    class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    placeholder="Search models…"
                    [value]="modelQuery()"
                    (input)="modelQuery.set($any($event.target).value)"
                  />
                </label>
              </div>

              <div class="max-h-72 overflow-y-auto p-1.5">
                <button
                  type="button"
                  role="menuitem"
                  data-model-id="auto"
                  class="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  (click)="selectModel(null)"
                >
                  <span
                    class="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground"
                    ><ng-icon name="lucideBox" size="14"
                  /></span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-medium">Auto</span>
                    <span class="block text-xs text-muted-foreground">Let OpenCode choose</span>
                  </span>
                  @if (!modelService.selectedModel()) {
                    <ng-icon name="lucideCheck" size="15" />
                  }
                </button>

                @if (modelService.loading()) {
                  <p class="px-3 py-5 text-center text-xs text-muted-foreground" aria-live="polite">
                    Loading available models…
                  </p>
                } @else if (modelService.error()) {
                  <div class="px-3 py-4 text-center">
                    <p class="text-xs text-muted-foreground">Models could not be loaded.</p>
                    <button
                      type="button"
                      class="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:bg-muted"
                      (click)="retryModels()"
                    >
                      <ng-icon name="lucideRefreshCw" size="13" /> Retry
                    </button>
                  </div>
                } @else {
                  @for (model of filteredModels(); track model.id) {
                    <button
                      type="button"
                      role="menuitem"
                      [attr.data-model-id]="model.id"
                      class="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                      (click)="selectModel(model.id)"
                    >
                      <span
                        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
                        >{{ model.provider.slice(0, 2) }}</span
                      >
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm font-medium">{{ model.name }}</span>
                        <span class="block truncate text-xs text-muted-foreground">{{
                          model.provider
                        }}</span>
                      </span>
                      @if (modelService.selectedModel() === model.id) {
                        <ng-icon name="lucideCheck" size="15" />
                      }
                    </button>
                  } @empty {
                    <p class="px-3 py-5 text-center text-xs text-muted-foreground">
                      No models match “{{ modelQuery() }}”.
                    </p>
                  }
                }
              </div>
            </div>
          }

          @if (projectMenuOpen()) {
            <div
              focusTrap
              role="menu"
              aria-label="Available projects"
              class="absolute right-14 top-[calc(100%+0.25rem)] z-50 w-[262px] overflow-hidden rounded-[10px] border border-border bg-popover text-popover-foreground shadow-lg"
              (click)="$event.stopPropagation()"
              (focusTrapEscape)="closeProjectMenu()"
            >
              <div class="border-b border-border p-2">
                <label
                  class="flex h-8 items-center gap-2 px-1.5 text-muted-foreground focus-within:text-foreground"
                >
                  <ng-icon name="lucideSearch" size="16" />
                  <span class="sr-only">Search projects</span>
                  <input
                    autoFocusTarget
                    class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    placeholder="Search projects…"
                    [value]="projectQuery()"
                    (input)="projectQuery.set($any($event.target).value)"
                  />
                </label>
              </div>

              <div class="max-h-52 overflow-y-auto p-1">
                @if (projectService.loading()) {
                  <p class="px-3 py-5 text-center text-xs text-muted-foreground" aria-live="polite">
                    Loading projects…
                  </p>
                } @else if (projectService.error()) {
                  <div class="px-3 py-4 text-center">
                    <p class="text-xs text-muted-foreground">Projects could not be loaded.</p>
                    <button
                      type="button"
                      class="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:bg-muted"
                      (click)="retryProjects()"
                    >
                      <ng-icon name="lucideRefreshCw" size="13" /> Retry
                    </button>
                  </div>
                } @else {
                  @for (project of filteredProjects(); track project.id) {
                    <button
                      type="button"
                      role="menuitemradio"
                      [attr.aria-checked]="projectService.selectedProjectId() === project.id"
                      [attr.data-project-id]="project.id"
                      class="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                      [class.bg-muted]="projectService.selectedProjectId() === project.id"
                      (click)="selectProject(project.id)"
                    >
                      <ng-icon name="lucideFolder" size="15" class="text-muted-foreground" />
                      <span class="min-w-0 flex-1 truncate">{{ project.name }}</span>
                      @if (projectService.selectedProjectId() === project.id) {
                        <ng-icon name="lucideCheck" size="16" class="text-muted-foreground" />
                      }
                    </button>
                  } @empty {
                    <p class="px-3 py-5 text-center text-xs text-muted-foreground">
                      No projects match “{{ projectQuery() }}”.
                    </p>
                  }
                }
              </div>

              <div class="border-t border-border p-2">
                <a
                  routerLink="/projects"
                  class="flex h-8 w-full items-center justify-center gap-2 rounded-md border border-border text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  (click)="closeProjectMenu()"
                >
                  <ng-icon name="lucidePlus" size="17" />
                  <span>New Project</span>
                </a>
              </div>
            </div>
          }
        </form>
      </div>
    </section>
  `,
})
export class ChatEmpty implements OnInit {
  private readonly chatService = inject(ChatService);
  readonly modelService = inject(ModelService);
  readonly projectService = inject(ProjectService);

  readonly prompt = signal('');
  readonly starting = signal(false);
  readonly modelMenuOpen = signal(false);
  readonly modelQuery = signal('');
  readonly projectMenuOpen = signal(false);
  readonly projectQuery = signal('');
  readonly filteredModels = computed(() => {
    const query = this.modelQuery().trim().toLowerCase();
    if (!query) {
      return this.modelService.models();
    }
    return this.modelService
      .models()
      .filter(
        (model) =>
          model.name.toLowerCase().includes(query) ||
          model.provider.toLowerCase().includes(query) ||
          model.id.toLowerCase().includes(query),
      );
  });
  readonly filteredProjects = computed(() => {
    return filterByName(this.projectService.projects(), this.projectQuery());
  });

  ngOnInit(): void {
    void this.modelService.loadModels();
    void this.projectService.loadProjects();
  }

  @HostListener('document:click')
  closeMenus(): void {
    this.modelMenuOpen.set(false);
    this.projectMenuOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  closeMenusWithEscape(): void {
    this.closeMenus();
  }

  toggleModelMenu(event: Event): void {
    event.stopPropagation();
    this.closeProjectMenu();
    this.modelMenuOpen.update((open) => !open);
    if (!this.modelMenuOpen()) {
      this.modelQuery.set('');
    }
  }

  toggleProjectMenu(event: Event): void {
    event.stopPropagation();
    this.modelMenuOpen.set(false);
    this.modelQuery.set('');
    this.projectMenuOpen.update((open) => !open);
    if (!this.projectMenuOpen()) {
      this.projectQuery.set('');
    }
  }

  selectProject(projectId: string): void {
    this.projectService.selectProject(projectId);
    this.closeProjectMenu();
  }

  closeProjectMenu(): void {
    this.projectMenuOpen.set(false);
    this.projectQuery.set('');
  }

  closeModelMenu(): void {
    this.modelMenuOpen.set(false);
    this.modelQuery.set('');
  }

  selectModel(model: string | null): void {
    this.modelService.selectModel(model);
    this.modelMenuOpen.set(false);
    this.modelQuery.set('');
  }

  retryModels(): void {
    void this.modelService.retry();
  }

  retryProjects(): void {
    void this.projectService.loadProjects();
  }

  onEnter(event: Event): void {
    const keyboard = event as KeyboardEvent;
    if (keyboard.shiftKey) {
      return;
    }
    keyboard.preventDefault();
    this.start(event);
  }

  async start(event: Event): Promise<void> {
    event.preventDefault();
    await this.startChat();
  }

  private async startChat(): Promise<void> {
    const value = this.prompt().trim();
    if (!value || this.starting()) {
      return;
    }

    this.starting.set(true);
    try {
      await this.projectService.loadProjects();
      const projectId = this.projectService.selectedProject()?.id ?? 'local-workspace';
      const chatId = await this.chatService.createChat(projectId);
      if (chatId) {
        void this.chatService.sendTurn(chatId, value);
      }
    } finally {
      this.starting.set(false);
    }
  }
}
