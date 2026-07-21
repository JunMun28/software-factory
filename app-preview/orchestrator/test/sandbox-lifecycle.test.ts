import { describe, expect, it } from 'vitest';

import {
  PreviewManager,
  SANDBOX_CAPACITY_MESSAGE,
  type IntervalScheduler,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxStartOptions,
} from '../src/preview-manager.js';
import { FakePortAllocator } from './fake-preview-deps.js';

/**
 * Records every start/stop so the tests can assert lifecycle transitions without
 * a real workspace or child processes. Provider-agnostic on purpose: the guards
 * under test call the manager's stop()/ensure() + status, which is exactly what
 * LocalProcessSandbox and KubeSandbox both back.
 */
class FakeSandboxProvider implements SandboxProvider {
  readonly started: string[] = [];
  readonly stopped: string[] = [];

  async start(
    chatId: string,
    _options?: SandboxStartOptions,
  ): Promise<SandboxHandle> {
    this.started.push(chatId);
    return {
      targetUrl: `http://sandbox/${chatId}`,
      resync: async () => {},
      stop: async () => {
        this.stopped.push(chatId);
      },
    } satisfies SandboxHandle;
  }
}

const fakeBridgeProxy = {
  async start(input: { targetUrl: string; port: number }) {
    return { url: `http://bridge/${input.port}`, async close() {} };
  },
};

/** Captures the sweep callback so a test can fire it deterministically. */
class FakeScheduler implements IntervalScheduler {
  callback?: () => void;
  intervalMs?: number;
  cancelled = false;

  setInterval(callback: () => void, ms: number): () => void {
    this.callback = callback;
    this.intervalMs = ms;
    return () => {
      this.cancelled = true;
    };
  }

  tick(): void {
    this.callback?.();
  }
}

interface Harness {
  manager: PreviewManager;
  provider: FakeSandboxProvider;
  scheduler: FakeScheduler;
  setTime: (ms: number) => void;
}

function makeManager(options: {
  idleTtlMs?: number;
  maxLiveSandboxes?: number;
}): Harness {
  const provider = new FakeSandboxProvider();
  const scheduler = new FakeScheduler();
  let now = 0;
  const manager = new PreviewManager({
    workspacesRoot: '/unused',
    previewRoot: '/unused',
    sandboxProvider: provider,
    portAllocator: new FakePortAllocator(),
    bridgeProxy: fakeBridgeProxy,
    clock: () => now,
    sweepScheduler: scheduler,
    idleTtlMs: options.idleTtlMs ?? 0,
    idleSweepIntervalMs: 1_000,
    maxLiveSandboxes: options.maxLiveSandboxes ?? 0,
  } as never);
  return {
    manager,
    provider,
    scheduler,
    setTime: (ms) => {
      now = ms;
    },
  };
}

describe('PreviewManager idle GC sweep', () => {
  it('stops an idle sandbox but leaves a subscribed one alone', async () => {
    const { manager, provider, scheduler, setTime } = makeManager({
      idleTtlMs: 1_000,
    });

    await manager.ensure('idle'); // lastActivity = 0, no subscribers
    await manager.ensure('watched'); // lastActivity = 0
    manager.subscribe('watched', () => {}); // active subscriber protects it

    setTime(2_000); // both are older than the 1s TTL now
    scheduler.tick();

    expect(manager.status('idle').status).toBe('stopped');
    expect(manager.status('watched').status).toBe('ready');
    expect(provider.stopped).toEqual(['idle']);

    manager.dispose();
    expect(scheduler.cancelled).toBe(true);
  });

  it('does not sweep a sandbox that is still within its TTL', async () => {
    const { manager, scheduler, setTime } = makeManager({ idleTtlMs: 1_000 });

    await manager.ensure('fresh');
    setTime(500); // within TTL
    scheduler.tick();

    expect(manager.status('fresh').status).toBe('ready');
  });

  it('re-creates a swept sandbox lazily on the next ensure()', async () => {
    const { manager, provider, scheduler, setTime } = makeManager({
      idleTtlMs: 1_000,
    });

    await manager.ensure('chat');
    setTime(2_000);
    scheduler.tick();
    expect(manager.status('chat').status).toBe('stopped');

    await manager.ensure('chat');
    expect(manager.status('chat').status).toBe('ready');
    expect(provider.started).toEqual(['chat', 'chat']);
  });

  it('touch() and subscribe reset the idle clock', async () => {
    const { manager, scheduler, setTime } = makeManager({ idleTtlMs: 1_000 });

    // touch(): keeps the sandbox alive past the original TTL window.
    await manager.ensure('touched'); // lastActivity = 0
    setTime(900);
    manager.touch('touched'); // lastActivity = 900
    setTime(1_500); // 600ms since touch < 1000 TTL
    scheduler.tick();
    expect(manager.status('touched').status).toBe('ready');

    // subscribe then unsubscribe (zero active subscribers, but the clock moved).
    await manager.ensure('subbed'); // lastActivity = 0
    setTime(1_400);
    const unsubscribe = manager.subscribe('subbed', () => {}); // lastActivity = 1400
    unsubscribe();
    setTime(2_000); // 600ms since the subscribe reset < 1000 TTL
    scheduler.tick();
    expect(manager.status('subbed').status).toBe('ready');

    // Finally let it go stale: no activity for longer than the TTL.
    setTime(3_100); // 1700ms since last activity (1400) > 1000 TTL
    scheduler.tick();
    expect(manager.status('subbed').status).toBe('stopped');
  });

  it('does not schedule a sweep when idle GC is disabled (default)', async () => {
    const { manager, scheduler, setTime } = makeManager({ idleTtlMs: 0 });

    await manager.ensure('chat');
    setTime(10_000_000);
    scheduler.tick(); // no callback registered — no-op

    expect(scheduler.callback).toBeUndefined();
    expect(manager.status('chat').status).toBe('ready');
  });
});

describe('PreviewManager concurrency cap', () => {
  it('evicts the least-recently-active idle sandbox to make room', async () => {
    const { manager, provider, setTime } = makeManager({ maxLiveSandboxes: 2 });

    setTime(1);
    await manager.ensure('a'); // lastActivity = 1
    setTime(2);
    await manager.ensure('b'); // lastActivity = 2
    setTime(3);
    manager.touch('a'); // a is now MORE recent than b (a=3, b=2)

    setTime(4);
    await manager.ensure('c'); // at cap -> evict LRU-idle = b

    expect(provider.stopped).toEqual(['b']);
    expect(manager.status('a').status).toBe('ready');
    expect(manager.status('b').status).toBe('stopped');
    expect(manager.status('c').status).toBe('ready');
  });

  it('fails cleanly when every live sandbox has active subscribers', async () => {
    const { manager, provider, setTime } = makeManager({ maxLiveSandboxes: 2 });

    setTime(1);
    await manager.ensure('a');
    manager.subscribe('a', () => {});
    setTime(2);
    await manager.ensure('b');
    manager.subscribe('b', () => {});

    setTime(3);
    await manager.ensure('c'); // nothing evictable -> refuse

    expect(manager.status('c')).toMatchObject({
      status: 'failed',
      error: SANDBOX_CAPACITY_MESSAGE,
    });
    expect(provider.stopped).toEqual([]);
    expect(manager.status('a').status).toBe('ready');
    expect(manager.status('b').status).toBe('ready');
  });

  it('never evicts a subscribed sandbox even when an idle one is newer', async () => {
    const { manager, provider, setTime } = makeManager({ maxLiveSandboxes: 2 });

    setTime(1);
    await manager.ensure('subscribed'); // oldest by activity
    manager.subscribe('subscribed', () => {});
    setTime(2);
    await manager.ensure('idle'); // newer, but idle

    setTime(3);
    await manager.ensure('new'); // must evict 'idle', not the older subscribed one

    expect(provider.stopped).toEqual(['idle']);
    expect(manager.status('subscribed').status).toBe('ready');
    expect(manager.status('new').status).toBe('ready');
  });

  it('allows unlimited sandboxes when the cap is 0 (default)', async () => {
    const { manager } = makeManager({ maxLiveSandboxes: 0 });

    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await manager.ensure(id);
    }

    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      expect(manager.status(id).status).toBe('ready');
    }
  });
});
