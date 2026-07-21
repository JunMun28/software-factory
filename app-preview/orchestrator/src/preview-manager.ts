import {
  createPreviewBridgeProxy,
  type PreviewBridgeHandle,
  type PreviewBridgeProxy,
} from './preview-bridge.js';
import {
  createDefaultPortAllocator,
  LocalProcessSandbox,
  type PortAllocator,
  type ProcessSpawner,
  type ReadinessProber,
  type SandboxHandle,
  type SandboxProvider,
} from './sandbox.js';

export { workspaceEnv } from './workspace-env.js';
export type {
  PortAllocator,
  ProcessSpawner,
  ReadinessProber,
  SandboxHandle,
  SandboxProvider,
  SandboxStartOptions,
} from './sandbox.js';

export type PreviewStatusValue = 'stopped' | 'starting' | 'ready' | 'failed';

export interface PreviewStatus {
  status: PreviewStatusValue;
  url?: string;
  error?: string;
}

/**
 * Injectable interval scheduler so the idle sweep can be driven deterministically
 * in tests (mirrors how the spawner/prober/portAllocator are faked). The default
 * wraps `setInterval` and `unref`s the timer so a running sweep never keeps the
 * process alive.
 */
export interface IntervalScheduler {
  /** Schedule `callback` every `ms`; returns a cancel function. */
  setInterval(callback: () => void, ms: number): () => void;
}

/** Live sandbox is one whose dev server is up or coming up. */
const LIVE_STATUSES: ReadonlySet<PreviewStatusValue> = new Set<PreviewStatusValue>([
  'ready',
  'starting',
]);

export const SANDBOX_CAPACITY_MESSAGE =
  'sandbox capacity reached — close another preview';

export interface PreviewManagerOptions {
  workspacesRoot: string;
  previewRoot: string;
  spawner?: ProcessSpawner;
  prober?: ReadinessProber;
  portAllocator?: PortAllocator;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  bridgeProxy?: PreviewBridgeProxy;
  connectionEnv?: (chatId: string) => Promise<Record<string, string>>;
  /**
   * Swappable sandbox lifecycle. Defaults to a {@link LocalProcessSandbox} built
   * from the process/port/prober options above (exactly like `spawner ??`
   * defaults). A Kube provider slots in here without touching PreviewManager.
   */
  sandboxProvider?: SandboxProvider;
  /**
   * Idle GC: stop a live sandbox after this many ms with no activity (ensure /
   * subscribe / touch) AND zero active subscribers. `0` (the default) disables
   * the sweep entirely, so existing callers that omit it keep today's behaviour.
   * Env `APPVIEW_SANDBOX_IDLE_TTL_MS` (see config.ts) drives the real default.
   */
  idleTtlMs?: number;
  /** How often the idle sweep runs (ms). Only used when `idleTtlMs > 0`. */
  idleSweepIntervalMs?: number;
  /**
   * Max concurrently-live (starting/ready) sandboxes. `0` (default) is
   * unlimited, so existing callers are unaffected. When a new `ensure()` would
   * exceed the cap, the least-recently-active idle sandbox is evicted; if none
   * can be, that `ensure()` fails with {@link SANDBOX_CAPACITY_MESSAGE}.
   */
  maxLiveSandboxes?: number;
  /** Injectable monotonic-ish clock (ms). Defaults to `Date.now`. */
  clock?: () => number;
  /** Injectable interval scheduler for the idle sweep. */
  sweepScheduler?: IntervalScheduler;
}

type PreviewStatusListener = (status: PreviewStatus) => void;

interface PreviewRecord {
  status: PreviewStatusValue;
  url?: string;
  error?: string;
  sandbox?: SandboxHandle;
  bridgeHandle?: PreviewBridgeHandle;
  ensurePromise?: Promise<void>;
  /** Last time this chat saw activity (ensure / subscribe / touch), via clock. */
  lastActivity: number;
  /**
   * Host-routed (kube) sandboxes only: the preview Host registered in
   * {@link PreviewManager.previewHostTargets}. Kept so teardown/onExit can
   * unregister it. Undefined for local (localhost-bridge) previews.
   */
  previewHost?: string;
}

export class PreviewManager {
  private readonly records = new Map<string, PreviewRecord>();
  private readonly listeners = new Map<string, Set<PreviewStatusListener>>();
  /**
   * Host-routed (kube) previews: bare-lowercase preview Host → sandbox targetUrl
   * (the in-cluster Service URL). The main server's proxy middleware and the
   * websocket upgrade handler look up this map to route by `Host`. Empty in
   * local mode, where each chat has its own localhost bridge instead.
   */
  private readonly previewHostTargets = new Map<string, string>();
  private readonly portAllocator: PortAllocator;
  private readonly bridgeProxy: PreviewBridgeProxy;
  private readonly sandbox: SandboxProvider;
  private readonly idleTtlMs: number;
  private readonly maxLiveSandboxes: number;
  private readonly clock: () => number;
  private cancelSweep?: () => void;

  constructor(options: PreviewManagerOptions) {
    this.portAllocator = options.portAllocator ?? createDefaultPortAllocator();
    this.bridgeProxy = options.bridgeProxy ?? createPreviewBridgeProxy();
    this.sandbox =
      options.sandboxProvider ??
      new LocalProcessSandbox({
        workspacesRoot: options.workspacesRoot,
        previewRoot: options.previewRoot,
        spawner: options.spawner,
        prober: options.prober,
        // Share the resolved allocator so bridge and sandbox ports stay on one
        // sequence.
        portAllocator: this.portAllocator,
        readinessTimeoutMs: options.readinessTimeoutMs,
        readinessPollMs: options.readinessPollMs,
        connectionEnv: options.connectionEnv,
      });
    this.idleTtlMs = options.idleTtlMs ?? 0;
    this.maxLiveSandboxes = options.maxLiveSandboxes ?? 0;
    this.clock = options.clock ?? Date.now;

    // The sweep is opt-in: with no idle TTL configured nothing is scheduled, so
    // callers that don't ask for idle GC (including the existing tests) behave
    // exactly as before.
    if (this.idleTtlMs > 0) {
      const scheduler = options.sweepScheduler ?? createDefaultIntervalScheduler();
      const intervalMs = options.idleSweepIntervalMs ?? 60_000;
      this.cancelSweep = scheduler.setInterval(() => this.sweepIdle(), intervalMs);
    }
  }

  status(chatId: string): PreviewStatus {
    const record = this.records.get(chatId);
    if (!record || record.status === 'stopped') {
      return { status: 'stopped' };
    }
    return {
      status: record.status,
      url: record.url,
      error: record.error,
    };
  }

  subscribe(chatId: string, listener: PreviewStatusListener): () => void {
    let set = this.listeners.get(chatId);
    if (!set) {
      set = new Set();
      this.listeners.set(chatId, set);
    }
    set.add(listener);
    // A new subscriber is activity: reset the idle clock so an in-view preview
    // is never swept.
    const record = this.records.get(chatId);
    if (record) {
      record.lastActivity = this.clock();
    }
    listener(this.status(chatId));
    return () => {
      set?.delete(listener);
      if (set?.size === 0) {
        this.listeners.delete(chatId);
      }
    };
  }

  /**
   * Bump a chat's activity clock so the idle sweep leaves its sandbox alone.
   * The turn pipeline calls this when a chat takes a turn (even with no live
   * subscriber). No-op for chats that have never had a preview record.
   */
  touch(chatId: string): void {
    const record = this.records.get(chatId);
    if (record) {
      record.lastActivity = this.clock();
    }
  }

  async ensure(chatId: string): Promise<void> {
    const record = this.getOrCreateRecord(chatId);
    record.lastActivity = this.clock();

    if (record.status === 'ready' || record.status === 'starting') {
      if (record.ensurePromise) {
        await record.ensurePromise;
      }
      return;
    }

    // About to start a NEW sandbox — enforce the concurrency cap first. This may
    // evict an idle preview to make room, or refuse when everything live is in
    // use.
    const capacityError = this.enforceCapacityForNewStart(chatId);
    if (capacityError) {
      this.setStatus(chatId, record, { status: 'failed', error: capacityError });
      return;
    }

    record.ensurePromise = this.runEnsure(chatId, record);
    try {
      await record.ensurePromise;
    } finally {
      record.ensurePromise = undefined;
    }
  }

  async restart(chatId: string): Promise<void> {
    await this.stop(chatId);
    await this.ensure(chatId);
  }

  /**
   * Point a live sandbox at a new workspace commit. The local dev server watches
   * the workspace directly, so its handle's resync is a no-op; a Kube sandbox
   * holds its own clone and git fetch+resets to `sha` (HMR then reloads). Safe
   * to call when no sandbox is live (no-op) and never throws — a resync failure
   * must not fail the turn that triggered it.
   */
  async resync(chatId: string, sha?: string): Promise<void> {
    const record = this.records.get(chatId);
    if (!record?.sandbox) {
      return;
    }
    this.touch(chatId);
    try {
      await record.sandbox.resync(sha);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Preview resync failed for ${chatId}: ${message}`);
    }
  }

  async stop(chatId: string): Promise<void> {
    const record = this.records.get(chatId);
    if (!record) {
      return;
    }
    // Flip the status FIRST (synchronously): the idle sweep and the capacity
    // check both call this without awaiting and rely on the record no longer
    // counting as live before the loop continues.
    this.setStatus(chatId, record, { status: 'stopped' });
    await this.teardown(record);
  }

  async remove(chatId: string): Promise<void> {
    await this.stop(chatId);
    this.records.delete(chatId);
    this.listeners.delete(chatId);
  }

  async dispose(): Promise<void> {
    this.cancelSweep?.();
    this.cancelSweep = undefined;
    const records = [...this.records.values()];
    await Promise.allSettled(records.map((record) => this.teardown(record)));
    this.records.clear();
    this.listeners.clear();
  }

  private getOrCreateRecord(chatId: string): PreviewRecord {
    let record = this.records.get(chatId);
    if (!record) {
      record = { status: 'stopped', lastActivity: this.clock() };
      this.records.set(chatId, record);
    }
    return record;
  }

  private subscriberCount(chatId: string): number {
    return this.listeners.get(chatId)?.size ?? 0;
  }

  /** Chat ids whose sandbox is currently live (starting or ready). */
  private liveChatIds(): string[] {
    const ids: string[] = [];
    for (const [chatId, record] of this.records) {
      if (LIVE_STATUSES.has(record.status)) {
        ids.push(chatId);
      }
    }
    return ids;
  }

  /**
   * Idle GC sweep: stop every live sandbox that has had no activity for longer
   * than the idle TTL AND currently has zero subscribers. A stopped sandbox is
   * re-created lazily on the next `ensure()`.
   */
  private sweepIdle(): void {
    if (this.idleTtlMs <= 0) {
      return;
    }
    const now = this.clock();
    for (const [chatId, record] of this.records) {
      if (!LIVE_STATUSES.has(record.status)) {
        continue;
      }
      if (this.subscriberCount(chatId) > 0) {
        continue;
      }
      if (now - record.lastActivity <= this.idleTtlMs) {
        continue;
      }
      // stop() flips the record's status to 'stopped' synchronously before it
      // awaits the (now-awaited) teardown, so the loop's live/idle view stays
      // correct even though this call is fire-and-forget.
      void this.stop(chatId);
    }
  }

  /**
   * Enforce {@link maxLiveSandboxes} before starting a new sandbox for `chatId`.
   * Returns an error message when the start must be refused, or `undefined` when
   * there is room (evicting the least-recently-active idle sandbox if needed).
   */
  private enforceCapacityForNewStart(chatId: string): string | undefined {
    if (this.maxLiveSandboxes <= 0) {
      return undefined; // unlimited
    }
    const live = this.liveChatIds().filter((id) => id !== chatId);
    if (live.length < this.maxLiveSandboxes) {
      return undefined; // room for one more
    }
    // At capacity: evict the least-recently-active IDLE (zero-subscriber)
    // sandbox. Never evict one with active subscribers.
    const evictable = live
      .filter((id) => this.subscriberCount(id) === 0)
      .map((id) => ({ id, lastActivity: this.records.get(id)!.lastActivity }))
      .sort((a, b) => a.lastActivity - b.lastActivity);
    const victim = evictable[0];
    if (!victim) {
      return SANDBOX_CAPACITY_MESSAGE;
    }
    void this.stop(victim.id);
    return undefined;
  }

  private async runEnsure(chatId: string, record: PreviewRecord): Promise<void> {
    this.setStatus(chatId, record, { status: 'starting' });

    const onExit = (error: Error): void => {
      if (record.status !== 'starting' && record.status !== 'ready') {
        return;
      }
      // The sandbox has already torn down its own processes; drop our refs and
      // close the bridge, then mark the preview failed.
      record.sandbox = undefined;
      void record.bridgeHandle?.close();
      record.bridgeHandle = undefined;
      this.unregisterPreviewHost(record);
      this.setStatus(chatId, record, { status: 'failed', error: error.message });
    };

    try {
      const handle = await this.sandbox.start(chatId, { onExit });
      if (isFailed(record)) {
        void handle.stop();
        return;
      }
      record.sandbox = handle;

      // Host-routed (kube) sandbox: the orchestrator's main server proxies by
      // Host, so there is NO localhost bridge. Register the host→target mapping
      // and report the browser-facing external URL as the preview URL.
      if (handle.externalPreviewUrl) {
        if (handle.previewHost) {
          record.previewHost = handle.previewHost;
          this.previewHostTargets.set(
            bareHost(handle.previewHost),
            handle.targetUrl,
          );
        }
        this.setStatus(chatId, record, {
          status: 'ready',
          url: handle.externalPreviewUrl,
        });
        return;
      }

      // Local sandbox: per-chat localhost bridge (unchanged).
      const [bridgePort] = await this.portAllocator.allocate(1);
      if (bridgePort === undefined) {
        throw new Error('Preview bridge port was not allocated');
      }
      const bridgeHandle = await this.bridgeProxy.start({
        targetUrl: handle.targetUrl,
        port: bridgePort,
      });
      if (isFailed(record)) {
        void bridgeHandle.close();
        return;
      }
      record.bridgeHandle = bridgeHandle;
      this.setStatus(chatId, record, {
        status: 'ready',
        url: bridgeHandle.url,
      });
    } catch (error) {
      if (isFailed(record)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.teardown(record);
      this.setStatus(chatId, record, { status: 'failed', error: message });
    }
  }

  /**
   * Tear a record's sandbox + bridge down and WAIT for it. Callers await this:
   * a fire-and-forget delete meant SIGTERM orphaned every live sandbox
   * Deployment, because the process exited before the k8s call left the wire
   * (plans/013). Never throws — a teardown failure must not abort a shutdown
   * or a restart.
   */
  private async teardown(record: PreviewRecord): Promise<void> {
    const sandbox = record.sandbox;
    const bridge = record.bridgeHandle;
    record.sandbox = undefined;
    record.bridgeHandle = undefined;
    this.unregisterPreviewHost(record);
    record.url = undefined;
    await Promise.allSettled([sandbox?.stop(), bridge?.close()]);
  }

  /** Drop a host-routed sandbox's `Host → target` mapping (no-op for local). */
  private unregisterPreviewHost(record: PreviewRecord): void {
    if (record.previewHost) {
      this.previewHostTargets.delete(bareHost(record.previewHost));
      record.previewHost = undefined;
    }
  }

  /**
   * Resolve a request `Host` to a host-routed sandbox's in-cluster target URL,
   * or `undefined` when the host is not a known preview host. Case-insensitive
   * and port-insensitive (a `:port` suffix on the Host is stripped). The main
   * server's proxy middleware and websocket upgrade handler call this to decide
   * whether a request is a preview request. Always empty in local mode.
   */
  resolvePreviewTarget(host: string | undefined | null): string | undefined {
    if (!host) {
      return undefined;
    }
    return this.previewHostTargets.get(bareHost(host));
  }

  private setStatus(
    chatId: string,
    record: PreviewRecord,
    status: PreviewStatus,
  ): void {
    record.status = status.status;
    record.url = status.url;
    record.error = status.error;
    this.emit(chatId, status);
  }

  private emit(chatId: string, status: PreviewStatus): void {
    const set = this.listeners.get(chatId);
    if (!set) {
      return;
    }
    for (const listener of set) {
      listener(status);
    }
  }
}

/**
 * Reads `record.status` through a function boundary so the check is not affected
 * by TypeScript's control-flow narrowing — the status can be mutated
 * asynchronously by the sandbox `onExit` callback between awaits.
 */
function isFailed(record: PreviewRecord): boolean {
  return record.status === 'failed';
}

/** Lowercase a Host and drop any `:port` suffix, for host-map keys + lookups. */
function bareHost(host: string): string {
  return host.split(':', 1)[0].toLowerCase();
}

/** Real interval scheduler; the timer is `unref`d so it never blocks exit. */
function createDefaultIntervalScheduler(): IntervalScheduler {
  return {
    setInterval(callback: () => void, ms: number): () => void {
      const handle = setInterval(callback, ms);
      handle.unref?.();
      return () => clearInterval(handle);
    },
  };
}
