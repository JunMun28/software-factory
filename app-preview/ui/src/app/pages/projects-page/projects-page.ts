import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFolderKanban, lucidePlus, lucideSearch, lucideX } from '@ng-icons/lucide';
import { RouterLink } from '@angular/router';

import { FocusTrap } from '../../lib/focus-trap';
import { filterByName } from '../../lib/name-filter';
import { ProjectService } from '../../services/project.service';

@Component({
  selector: 'app-projects-page',
  imports: [NgIcon, RouterLink, FocusTrap],
  providers: [provideIcons({ lucideFolderKanban, lucidePlus, lucideSearch, lucideX })],
  template: `
    <section class="mx-auto min-h-full w-full max-w-[1160px] px-8 py-10 max-sm:px-4 max-sm:py-6">
      <h1 class="text-3xl font-semibold tracking-tight">Projects</h1>

      <div class="mt-7 flex items-center gap-2">
        <label class="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-card px-3">
          <ng-icon class="text-muted-foreground" name="lucideSearch" size="15" />
          <span class="sr-only">Search projects</span>
          <input
            class="min-w-0 flex-1 bg-transparent text-sm outline-none"
            aria-label="Search projects"
            placeholder="Search projects..."
            [value]="query()"
            (input)="query.set(($any($event.target)).value)"
          />
        </label>
        <button
          type="button"
          aria-label="Create project"
          class="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          (click)="openCreateDialog()"
        >
          <ng-icon name="lucidePlus" size="15" /> Project
        </button>
      </div>

      <div class="mt-8 grid grid-cols-3 gap-5 max-lg:grid-cols-2 max-sm:grid-cols-1">
        @for (project of filteredProjects(); track project.id) {
          <article class="overflow-hidden rounded-lg border border-border bg-card">
            <a [routerLink]="['/projects', project.id]" [attr.aria-label]="'Open ' + project.name" class="flex aspect-[16/9] items-center justify-center border-b border-border bg-muted/25 text-muted-foreground hover:bg-muted/40">
              <ng-icon name="lucideFolderKanban" size="42" />
            </a>
            <div class="flex items-center gap-3 p-4">
              <span class="flex size-9 items-center justify-center rounded-full bg-muted text-foreground"><ng-icon name="lucideFolderKanban" size="17" /></span>
              <div class="min-w-0 flex-1">
                <a [routerLink]="['/projects', project.id]" class="block truncate text-sm font-medium hover:underline">{{ project.name }}</a>
                <p class="mt-0.5 text-xs text-muted-foreground">{{ project.chatCount }} {{ project.chatCount === 1 ? 'chat' : 'chats' }}</p>
              </div>
            </div>
          </article>
        } @empty {
          <div class="col-span-full rounded-lg border border-dashed border-border px-6 py-14 text-center">
            <p class="text-sm font-medium">No projects found</p>
            <p class="mt-1 text-xs text-muted-foreground">Try a different search.</p>
          </div>
        }
      </div>

      @if (projectService.error()) {
        <p class="mt-4 text-sm text-destructive" role="alert">{{ projectService.error() }}</p>
      }
    </section>

    @if (createDialogOpen()) {
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4"
        (click)="closeCreateDialog()"
      >
        <section
          focusTrap
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-project-title"
          class="w-full max-w-[420px] rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl"
          (click)="$event.stopPropagation()"
          (focusTrapEscape)="closeCreateDialog()"
        >
          <header class="flex items-start gap-4">
            <div class="min-w-0 flex-1">
              <h2 id="create-project-title" class="text-lg font-semibold">Create project</h2>
              <p class="mt-1 text-sm text-muted-foreground">Give this project a name. You can select it when starting a new chat.</p>
            </div>
            <button type="button" class="workspace-icon-button" aria-label="Close create project" (click)="closeCreateDialog()">
              <ng-icon name="lucideX" size="16" />
            </button>
          </header>

          <form class="mt-5" (submit)="createProject($event)">
            <label class="block text-sm font-medium" for="project-name">Project name</label>
            <input
              id="project-name"
              autoFocusTarget
              aria-label="Project name"
              class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
              placeholder="e.g. Client portal"
              [value]="projectName()"
              (input)="projectName.set(($any($event.target)).value)"
            />
            <div class="mt-6 flex justify-end gap-2">
              <button type="button" class="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted" (click)="closeCreateDialog()">Cancel</button>
              <button type="submit" class="inline-flex h-9 items-center rounded-md bg-foreground px-3 text-sm font-medium text-background disabled:opacity-40" [disabled]="projectService.creating() || !projectName().trim()">Create project</button>
            </div>
          </form>
        </section>
      </div>
    }
  `,
})
export class ProjectsPage implements OnInit {
  readonly projectService = inject(ProjectService);
  readonly query = signal('');
  readonly createDialogOpen = signal(false);
  readonly projectName = signal('');
  readonly filteredProjects = computed(() => {
    return filterByName(this.projectService.projects(), this.query());
  });

  ngOnInit(): void {
    void this.projectService.loadProjects();
  }

  closeCreateDialog(): void {
    this.createDialogOpen.set(false);
    this.projectName.set('');
  }

  openCreateDialog(): void {
    this.projectName.set('');
    this.createDialogOpen.set(true);
  }

  async createProject(event: Event): Promise<void> {
    event.preventDefault();
    const project = await this.projectService.createProject(this.projectName());
    if (!project) {
      return;
    }
    this.closeCreateDialog();
  }
}
