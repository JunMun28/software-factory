import { Injectable, computed, signal } from '@angular/core';

import { errorMessage } from '../lib/http-error';
import type { ChatSummary } from '../types/orchestrator-events';

const SELECTED_PROJECT_KEY = 'ng-v0-selected-project-id';

export interface Project {
  id: string;
  name: string;
  isDefault: boolean;
  chatCount: number;
  createdAt: string;
}

export interface ProjectDetails extends Project {
  chats: ChatSummary[];
}

@Injectable({ providedIn: 'root' })
export class ProjectService {
  readonly projects = signal<Project[]>([]);
  readonly selectedProjectId = signal<string | null>(readSelectedProjectId());
  readonly selectedProject = computed(() => {
    const projects = this.projects();
    return (
      projects.find((project) => project.id === this.selectedProjectId()) ??
      projects.find((project) => project.isDefault) ??
      null
    );
  });
  readonly loading = signal(false);
  readonly creating = signal(false);
  readonly error = signal<string | null>(null);

  private loadPromise: Promise<void> | null = null;

  loadProjects(): Promise<void> {
    if (this.projects().length > 0) {
      return Promise.resolve();
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.loading.set(true);
    this.error.set(null);
    this.loadPromise = this.fetchProjects().finally(() => {
      this.loading.set(false);
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  async createProject(rawName: string): Promise<Project | null> {
    const name = rawName.trim().replace(/\s+/g, ' ');
    if (!name || this.creating()) {
      return null;
    }

    this.creating.set(true);
    this.error.set(null);
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to create project'));
      }
      const project = (await response.json()) as Project;
      this.projects.update((projects) => [...projects, project]);
      return project;
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to create project');
      return null;
    } finally {
      this.creating.set(false);
    }
  }

  async loadProject(projectId: string): Promise<ProjectDetails | null> {
    this.error.set(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Project not found');
        }
        throw new Error(await errorMessage(response, 'Failed to load project'));
      }
      return (await response.json()) as ProjectDetails;
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to load project');
      return null;
    }
  }

  selectProject(projectId: string): void {
    if (!this.projects().some((project) => project.id === projectId)) {
      return;
    }
    this.selectedProjectId.set(projectId);
    writeSelectedProjectId(projectId);
  }

  private async fetchProjects(): Promise<void> {
    try {
      const response = await fetch('/api/projects');
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to load projects'));
      }
      const projects = (await response.json()) as Project[];
      this.projects.set(projects);

      const selectedId = this.selectedProjectId();
      const selectedExists = projects.some((project) => project.id === selectedId);
      const nextSelectedId = selectedExists
        ? selectedId
        : (projects.find((project) => project.isDefault)?.id ?? projects[0]?.id ?? null);
      this.selectedProjectId.set(nextSelectedId);
      writeSelectedProjectId(nextSelectedId);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to load projects');
    }
  }
}

function readSelectedProjectId(): string | null {
  try {
    return globalThis.localStorage?.getItem?.(SELECTED_PROJECT_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeSelectedProjectId(projectId: string | null): void {
  try {
    if (projectId) {
      globalThis.localStorage?.setItem?.(SELECTED_PROJECT_KEY, projectId);
    } else {
      globalThis.localStorage?.removeItem?.(SELECTED_PROJECT_KEY);
    }
  } catch {
    // Selection remains available for the current session when storage is unavailable.
  }
}
