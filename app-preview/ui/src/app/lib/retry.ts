export const INITIAL_RECONNECT_DELAY_MS = 250;
export const MAX_RECONNECT_DELAY_MS = 4_000;

export function abortableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function nextReconnectDelay(delayMs: number): number {
  return Math.min(delayMs * 2, MAX_RECONNECT_DELAY_MS);
}
