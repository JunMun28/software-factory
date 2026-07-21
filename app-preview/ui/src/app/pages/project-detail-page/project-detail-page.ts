import { Component, OnInit, inject, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideBox, lucideExternalLink, lucidePlus } from '@ng-icons/lucide';
import { ActivatedRoute, RouterLink } from '@angular/router';

import {
  ProjectService,
  type ProjectDetails,
} from '../../services/project.service';

@Component({
  selector: 'app-project-detail-page',
  imports: [NgIcon, RouterLink],
  providers: [provideIcons({ lucideArrowLeft, lucideBox, lucideExternalLink, lucidePlus })],
  template: `
    <section class="mx-auto min-h-full w-full max-w-[1160px] px-8 py-8 max-sm:px-4">
      <header class="flex items-center gap-3 border-b border-border pb-5">
        <a routerLink="/projects" class="workspace-icon-button" aria-label="Back to projects"><ng-icon name="lucideArrowLeft" size="16" /></a>
        <div class="min-w-0 flex-1">
          <p class="text-xs text-muted-foreground">Projects</p>
          <h1 class="truncate text-xl font-semibold">{{ project()?.name || 'Project' }}</h1>
        </div>
        <a routerLink="/" class="inline-flex h-9 items-center gap-2 rounded-md bg-foreground px-3 text-sm font-medium text-background">
          <ng-icon name="lucidePlus" size="15" /> New Chat
        </a>
      </header>

      @if (loading()) {
        <p class="py-16 text-center text-sm text-muted-foreground" aria-live="polite">Loading project…</p>
      } @else if (!project()) {
        <div class="mt-8 rounded-lg border border-dashed border-border px-6 py-14 text-center">
          <p class="text-sm font-medium">{{ projectService.error() || 'Project not found' }}</p>
          <a routerLink="/projects" class="mt-3 inline-block text-sm text-muted-foreground hover:text-foreground">Return to projects</a>
        </div>
      } @else {
        <div class="mt-8 space-y-7">
          <article class="min-h-44 rounded-lg border border-border bg-card p-5">
            <div class="flex items-center gap-3">
              <span class="flex size-10 items-center justify-center rounded-md bg-muted"><ng-icon name="lucideBox" size="19" /></span>
              <div>
                <h2 class="font-medium">{{ project()!.name }}</h2>
                <p class="text-xs text-muted-foreground">{{ project()!.chatCount }} {{ project()!.chatCount === 1 ? 'chat' : 'chats' }}</p>
              </div>
            </div>
            <div class="mt-5 rounded-md border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
              Preview and database services start from each chat workspace.
            </div>
          </article>

          <section>
            <div class="flex items-center justify-between px-1">
              <h2 class="text-sm font-medium">Recent Chats</h2>
              <a routerLink="/chats" class="text-xs text-muted-foreground hover:text-foreground">View All</a>
            </div>
            <div class="mt-3 min-h-44 space-y-1 rounded-lg border border-border bg-card p-4">
              @if (project()!.chats.length === 0) {
                <div class="py-10 text-center text-sm text-muted-foreground">No chats yet<br /><span class="text-xs">Start a new chat to begin building</span></div>
              } @else {
                @for (chat of project()!.chats; track chat.chatId) {
                  <a [routerLink]="['/chats', chat.chatId]" class="flex items-center justify-between rounded-md border-b border-border px-3 py-2 text-sm last:border-b-0 hover:bg-muted">
                    <span class="truncate">{{ chat.title || chat.chatId.slice(0, 8) }}</span>
                    <ng-icon class="text-muted-foreground" name="lucideExternalLink" size="14" />
                  </a>
                }
              }
            </div>
          </section>
        </div>
      }
    </section>
  `,
})
export class ProjectDetailPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  readonly projectService = inject(ProjectService);
  readonly project = signal<ProjectDetails | null>(null);
  readonly loading = signal(true);

  async ngOnInit(): Promise<void> {
    const projectId = this.route.snapshot.paramMap.get('projectId');
    if (!projectId) {
      this.loading.set(false);
      return;
    }

    this.project.set(await this.projectService.loadProject(projectId));
    this.loading.set(false);
  }
}
