import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  INITIAL_RECONNECT_DELAY_MS,
  MAX_RECONNECT_DELAY_MS,
  abortableDelay,
  nextReconnectDelay,
} from './retry';

describe('abortableDelay', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves true after the requested delay', async () => {
    vi.useFakeTimers();
    const waiting = abortableDelay(250, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(250);

    await expect(waiting).resolves.toBe(true);
  });

  it('resolves false immediately when aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = abortableDelay(250, controller.signal);

    controller.abort();

    await expect(waiting).resolves.toBe(false);
  });
});

describe('nextReconnectDelay', () => {
  it('doubles from the shared initial delay and caps at the shared maximum', () => {
    expect(nextReconnectDelay(INITIAL_RECONNECT_DELAY_MS)).toBe(500);
    expect(nextReconnectDelay(MAX_RECONNECT_DELAY_MS)).toBe(MAX_RECONNECT_DELAY_MS);
  });
});
