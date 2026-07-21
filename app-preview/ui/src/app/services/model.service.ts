import { Injectable, computed, signal } from '@angular/core';

import { errorMessage } from '../lib/http-error';

const STORAGE_KEY = 'ng-v0-model';

export interface ModelOption {
  id: string;
  provider: string;
  name: string;
}

@Injectable({ providedIn: 'root' })
export class ModelService {
  readonly models = signal<ModelOption[]>([]);
  readonly selectedModel = signal<string | null>(readStoredModel());
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly selectedLabel = computed(() => {
    const selected = this.selectedModel();
    if (!selected) {
      return 'Auto';
    }
    return this.models().find((model) => model.id === selected)?.name ?? 'Auto';
  });

  private loadPromise?: Promise<void>;

  loadModels(): Promise<void> {
    if (this.models().length > 0) {
      return Promise.resolve();
    }
    this.loadPromise ??= this.fetchModels();
    return this.loadPromise;
  }

  retry(): Promise<void> {
    this.loadPromise = undefined;
    return this.loadModels();
  }

  selectModel(model: string | null): void {
    if (model && !this.models().some((item) => item.id === model)) {
      return;
    }
    this.selectedModel.set(model);
    if (model) {
      writeStoredModel(model);
    } else {
      removeStoredModel();
    }
  }

  private async fetchModels(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const response = await fetch('/api/models');
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to load models'));
      }
      const body = (await response.json()) as { models: ModelOption[] };
      this.models.set(body.models);
      const selected = this.selectedModel();
      if (selected && !body.models.some((model) => model.id === selected)) {
        this.selectModel(null);
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to load models');
      this.loadPromise = undefined;
    } finally {
      this.loading.set(false);
    }
  }
}

function readStoredModel(): string | null {
  try {
    return typeof globalThis.localStorage?.getItem === 'function'
      ? globalThis.localStorage.getItem(STORAGE_KEY)
      : null;
  } catch {
    return null;
  }
}

function writeStoredModel(model: string): void {
  try {
    if (typeof globalThis.localStorage?.setItem === 'function') {
      globalThis.localStorage.setItem(STORAGE_KEY, model);
    }
  } catch {
    // Storage is an optional preference; model selection still works in memory.
  }
}

function removeStoredModel(): void {
  try {
    if (typeof globalThis.localStorage?.removeItem === 'function') {
      globalThis.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage is an optional preference; Auto still works without it.
  }
}
