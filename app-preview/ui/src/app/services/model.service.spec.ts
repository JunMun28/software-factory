import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelService } from './model.service';

describe('ModelService', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the live catalog and persists a selected model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        models: [
          { id: 'openai/gpt-5.4', provider: 'openai', name: 'gpt-5.4' },
          { id: 'google/gemini-2.5-pro', provider: 'google', name: 'gemini-2.5-pro' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = TestBed.inject(ModelService);

    await service.loadModels();
    service.selectModel('openai/gpt-5.4');

    expect(fetchMock).toHaveBeenCalledWith('/api/models');
    expect(service.models()).toHaveLength(2);
    expect(service.selectedModel()).toBe('openai/gpt-5.4');
    expect(service.selectedLabel()).toBe('gpt-5.4');
    expect(localStorage.getItem('ng-v0-model')).toBe('openai/gpt-5.4');
  });

  it('falls back to Auto when a saved model is no longer available', async () => {
    localStorage.setItem('ng-v0-model', 'removed/old-model');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          models: [{ id: 'openai/gpt-5.4', provider: 'openai', name: 'gpt-5.4' }],
        }),
      ),
    );
    const service = TestBed.inject(ModelService);

    await service.loadModels();

    expect(service.selectedModel()).toBeNull();
    expect(service.selectedLabel()).toBe('Auto');
    expect(localStorage.getItem('ng-v0-model')).toBeNull();
  });

  it('keeps Auto available when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', {});

    expect(() => TestBed.inject(ModelService)).not.toThrow();
    expect(TestBed.inject(ModelService).selectedModel()).toBeNull();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
