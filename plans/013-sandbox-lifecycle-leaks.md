# Plan 013: Stop leaking sandbox pods — await teardown, guard start-vs-stop, reap orphans

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5b9facb..HEAD -- app-preview/orchestrator/src/preview-manager.ts app-preview/orchestrator/src/index.ts app-preview/orchestrator/src/kube-sandbox.ts app-preview/orchestrator/src/factory.ts`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED — this is the lifecycle path every preview goes through
- **Depends on**: `plans/012-appview-into-verify-and-ci.md` (soft — 012 makes
  the orchestrator suite actually run in CI. You can execute 013 without it by
  running `npm test` by hand, as the steps below do.)
- **Category**: bug
- **Planned at**: commit `5b9facb`, 2026-07-21

## Why this matters

Each chat's preview is a Kubernetes Deployment running a live dev server —
`requests: {cpu: 250m, memory: 512Mi}`, `limits: {cpu: 1, memory: 1Gi}`. It is
the most expensive object this system creates. Three separate defects mean
those Deployments can outlive the orchestrator's knowledge of them, and
nothing ever notices:

1. **Shutdown never deletes anything.** `dispose()` fires the deletes without
   awaiting and the process exits on the next line. The orchestrator runs
   `strategy: Recreate` with a single replica, so *every* rollout, config
   change, node drain, or OOM orphans every live sandbox.
2. **A stop during a start leaks.** The guard after each `await` only checks
   for status `'failed'`, so a `stop()` (status `'stopped'`) is invisible to
   the in-flight start, which then registers a sandbox handle and a Host route
   onto a record that was already torn down — or, after `remove()`, onto a
   record no longer in the map, where nothing can ever reach it again.
3. **Nothing reaps orphans.** The `sf/tier: sandbox` label is written and never
   read. The only delete selector is `sf/session=<slug>`, reachable only from an
   in-memory record. There is no boot reconcile. Worse, the concurrency cap
   counts in-memory records — so orphans are not counted against it, and the
   cluster can accumulate unbounded sandbox Deployments while the orchestrator
   believes it is running zero.

This exact failure mode (31 orphaned pods) already bit the factory half of this
repo — see `implementation-notes.md`, the E2E campaign notes.

## Current state

All excerpts are from `app-preview/orchestrator/`.

### 1. `src/preview-manager.ts:432-439` — teardown is fire-and-forget

```ts
  private teardown(record: PreviewRecord): void {
    void record.sandbox?.stop();
    record.sandbox = undefined;
    void record.bridgeHandle?.close();
    record.bridgeHandle = undefined;
    this.unregisterPreviewHost(record);
    record.url = undefined;
  }
```

Its callers (`src/preview-manager.ts:260-283`) are declared `async` but never
await the actual deletion:

```ts
  async stop(chatId: string): Promise<void> {
    const record = this.records.get(chatId);
    if (!record) {
      return;
    }
    this.teardown(record);
    this.setStatus(chatId, record, { status: 'stopped' });
  }

  async remove(chatId: string): Promise<void> {
    await this.stop(chatId);
    this.records.delete(chatId);
    this.listeners.delete(chatId);
  }

  dispose(): void {
    this.cancelSweep?.();
    this.cancelSweep = undefined;
    for (const record of this.records.values()) {
      this.teardown(record);
    }
    this.records.clear();
    this.listeners.clear();
  }
```

### 2. `src/index.ts:22-30` — shutdown exits immediately

```ts
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down preview servers…`);
  previewManager.dispose();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

### 3. `src/preview-manager.ts:485-492` — the guard checks only `'failed'`

```ts
/**
 * Reads `record.status` through a function boundary so the check is not affected
 * by TypeScript's control-flow narrowing — the status can be mutated
 * asynchronously by the sandbox `onExit` callback between awaits.
 */
function isFailed(record: PreviewRecord): boolean {
  return record.status === 'failed';
}
```

It is used at `:380`, `:413`, and `:423`. The first use is the load-bearing
one (`src/preview-manager.ts:378-396`):

```ts
    try {
      const handle = await this.sandbox.start(chatId, { onExit });
      if (isFailed(record)) {
        void handle.stop();
        return;
      }
      record.sandbox = handle;

      if (handle.externalPreviewUrl) {
        if (handle.previewHost) {
          record.previewHost = handle.previewHost;
          this.previewHostTargets.set(
            bareHost(handle.previewHost),
            handle.targetUrl,
          );
        }
```

`KubeSandbox.start` waits for a Deployment rollout (2 min default) and then for
the frontend to answer (5 min default) — see `src/kube-sandbox.ts:32-36`. That
is a very wide window.

The two triggers that land inside it, both fire-and-forget:
`src/preview-manager.ts:331` (`sweepIdle` → `void this.stop(chatId)`) and
`:358` (`enforceCapacityForNewStart` → `void this.stop(victim.id)`), plus
`DELETE /chats/:id` from the HTTP layer.

### 4. The `sf/tier` label is write-only

`src/kube-sandbox.ts:151`:

```ts
  const labels = { 'sf/tier': 'sandbox', 'sf/session': slug, app: name };
```

`grep -rn "sf/tier" app-preview/orchestrator/src` returns **only that line**.
The `KubeSandboxClient` seam (`src/kube-sandbox.ts:67-78`) has no list method:

```ts
export interface KubeSandboxClient {
  /** Create-or-replace a Deployment/Service manifest (idempotent). */
  apply(manifest: KubeManifest): Promise<void>;
  /** Delete every resource matching a `key=value` label selector. */
  deleteByLabel(selector: string): Promise<void>;
  /** Resolve true once the named Deployment reports its replicas ready. */
  rolloutReady(deploymentName: string, timeoutMs: number): Promise<boolean>;
  /** GET a URL; must resolve (status 0 on a network error) rather than throw. */
  httpGet(url: string): Promise<SandboxHttpResponse>;
  /** POST a URL with an optional JSON body. */
  httpPost(url: string, body?: string): Promise<SandboxHttpResponse>;
}
```

### 5. `src/factory.ts:57-96` — the boot sequence has no reconcile

```ts
  const restored = await chatStore.rehydrate();
  if (restored > 0) {
    console.log(`Rehydrated ${restored} chat(s) from ${config.dbTarget}`);
  }
  let sandboxProvider: SandboxProvider | undefined;
  if (config.sandboxMode === 'kube') {
    const namespace = resolveSandboxNamespace();
    sandboxProvider = new KubeSandbox({
      client: await createKubeSandboxClient(namespace),
      namespace,
      previewDomain: config.previewDomain,
      previewExternalPort: config.previewExternalPort,
    });
  }
```

`ChatStore.listChats(): Promise<ChatSummary[]>` exists at
`src/chat-store.ts:400`, and `ChatSummary` carries `chatId: string`
(`src/types.ts:87-88`). `sandboxSlug(chatId)` is exported from
`src/kube-sandbox.ts:112` and is deterministic.

### Conventions to match

- **Test style**: `test/sandbox-lifecycle.test.ts` is the exemplar. It builds a
  `FakeSandboxProvider` that records `started`/`stopped` chat ids, a
  `FakeScheduler` that captures the sweep callback so a test can fire it
  deterministically, and a `makeManager()` harness returning
  `{ manager, provider, scheduler, setTime }`. Follow that shape — no real
  processes, no real cluster.
- **Kube seam test style**: `test/kube-sandbox.test.ts` defines a
  `FakeKubeClient implements KubeSandboxClient` that records every call into a
  `calls: FakeCall[]` array. Extend that fake rather than writing a new one.
- Comments in this codebase explain **why**, and they are dense. Match that.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `cd app-preview/orchestrator && npm ci` | exit 0 |
| Tests | `cd app-preview/orchestrator && npm test` | exit 0, all pass |
| One file | `cd app-preview/orchestrator && npx vitest run test/sandbox-lifecycle.test.ts` | exit 0 |
| Typecheck | `cd app-preview/orchestrator && npm run typecheck` | exit 0, no output |

All commands run from `app-preview/orchestrator`. Node must be the pinned
version (`.nvmrc` → 24.15.0).

## Scope

**In scope** (the only files you should modify):
- `app-preview/orchestrator/src/preview-manager.ts`
- `app-preview/orchestrator/src/index.ts`
- `app-preview/orchestrator/src/kube-sandbox.ts`
- `app-preview/orchestrator/src/factory.ts`
- `app-preview/orchestrator/test/sandbox-lifecycle.test.ts` (add tests)
- `app-preview/orchestrator/test/kube-sandbox.test.ts` (add tests)
- **Call sites of `previewManager.dispose()` in other test files** — making
  `dispose()` async (Step 2) turns existing synchronous calls into floating
  promises. At least `app-preview/orchestrator/test/version-chat-lifecycle.test.ts:81`
  calls it inside an `afterEach` cleanup. Find them all with
  `grep -rn "dispose()" app-preview/orchestrator/test/` and add `await`. This
  is a mechanical one-word edit per site — do not change any test's logic.
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):
- `app-preview/sandbox/entrypoint.sh`. Its `trap cleanup TERM INT` cannot fire
  while `node /opt/sandbox/resync.js` runs in the foreground, so each pod burns
  its full termination grace period. Real, but it needs a live cluster to
  verify and it only *widens* the window this plan closes. Recorded in
  maintenance notes.
- `src/preview-bridge.ts` — the proxy has its own separate defects (a `304` +
  `text/html` throws; responses are buffered rather than piped). Different
  plan.
- `src/sandbox.ts`'s `LocalProcessSandbox`. Its `stop()` already kills child
  processes synchronously enough; the changes here are at the manager level and
  apply to both providers.
- Any change to the `SandboxHandle` / `SandboxProvider` interfaces in
  `src/sandbox.ts`. They are already correct — `stop()` returns a `Promise`;
  the bug is that callers drop it.
- **The working tree has uncommitted changes from other work** (files under
  `apps/intake/`, `mockups/`, `plans/009`–`011`). Do not stage or commit them.

## Git workflow

- Branch: `advisor/013-sandbox-lifecycle`
- Conventional commits, e.g.
  `fix(appview): await sandbox teardown and reap orphaned sandbox pods`
- Commit per step group (tests-first commit, then each fix) is preferred so
  each commit is green.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing tests first

Add a **deferred** provider to `test/sandbox-lifecycle.test.ts` — one whose
`start()` does not resolve until the test says so. This is the single missing
test tool that let all three bugs ship; the existing `FakeSandboxProvider`
resolves immediately, so no test can currently express "stop arrives during a
start".

```ts
/**
 * A provider whose start() is held open until the test releases it. The
 * existing FakeSandboxProvider resolves immediately, so nothing could express
 * "a stop/remove/sweep landed while KubeSandbox.start was still waiting for a
 * rollout" — the window that leaks real Deployments. See plans/013.
 */
class DeferredSandboxProvider implements SandboxProvider {
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  private release?: (handle: SandboxHandle) => void;

  async start(chatId: string, _options?: SandboxStartOptions): Promise<SandboxHandle> {
    this.started.push(chatId);
    return new Promise<SandboxHandle>((resolve) => {
      this.release = resolve;
    });
  }

  /** Resolve the pending start with a handle, as a real provider eventually would. */
  finish(chatId: string, options: { previewHost?: string } = {}): void {
    const handle: SandboxHandle = {
      targetUrl: `http://sandbox/${chatId}`,
      ...(options.previewHost
        ? {
            previewHost: options.previewHost,
            externalPreviewUrl: `http://${options.previewHost}/`,
          }
        : {}),
      resync: async () => {},
      stop: async () => {
        this.stopped.push(chatId);
      },
    };
    this.release?.(handle);
  }
}
```

Now add these four tests. Each must FAIL against the current code — run them
and confirm the failures before you change any source.

1. **`stop() during a pending start tears the late handle down`** — call
   `void manager.ensure('c1')`, then `await manager.stop('c1')`, then
   `provider.finish('c1')`, then let the microtask queue drain
   (`await new Promise((r) => setImmediate(r))`). Expect
   `provider.stopped` to contain `'c1'` and `manager.status('c1').status` to be
   `'stopped'`.
2. **`remove() during a pending start registers no preview host`** — same
   shape, but `await manager.remove('c1')` and
   `provider.finish('c1', { previewHost: 'c1.preview.test' })`. Expect
   `manager.resolvePreviewTarget('c1.preview.test')` to be `undefined`.
3. **`stop() waits for the sandbox to be torn down`** — use a provider whose
   `stop()` resolves only after a deferred promise; assert that the promise
   returned by `manager.stop(...)` has not settled before the teardown resolves.
   A clean way: race `manager.stop('c1')` against a sentinel resolved on the
   next macrotask, and assert the sentinel wins only after you release the
   teardown.
4. **`dispose() awaits every sandbox teardown`** — start two chats, then
   `await manager.dispose()`, then assert both ids appear in `provider.stopped`.

**Verify**: `npx vitest run test/sandbox-lifecycle.test.ts` → the four new
tests FAIL, every pre-existing test in the file still passes. Record which
assertion each one fails on.

### Step 2: Make teardown awaited end to end

In `src/preview-manager.ts`:

- Change `teardown` to `private async teardown(record: PreviewRecord): Promise<void>`.
  Await the sandbox stop and the bridge close instead of `void`-ing them. Both
  must be attempted even if the first throws, and a teardown error must never
  propagate — a failed delete should be logged, not crash a shutdown:

```ts
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
```

  Note the ordering: the record's references are cleared **before** the await,
  so a concurrent caller cannot find and re-stop the same handle.

- `stop()`: `await this.teardown(record);` before `setStatus`.
- `dispose()`: make it `async dispose(): Promise<void>` and
  `await Promise.allSettled([...this.records.values()].map((r) => this.teardown(r)))`
  before clearing the maps. Snapshot the values into an array first — you are
  awaiting while the map is still live.
- `sweepIdle()` (`:331`) and `enforceCapacityForNewStart()` (`:358`) keep their
  `void this.stop(...)` calls — those are genuinely fire-and-forget contexts
  (a timer callback and a synchronous capacity check). But the comment at
  `:329-330` ("stop() runs synchronously up to its … teardown, so the record
  flips to 'stopped' before the loop continues") is now **wrong**: with an
  awaited teardown the status flip happens after an await. Fix the comment and
  flip the status first. The simplest correct shape is to set the record to
  `'stopped'` synchronously in `stop()` **before** awaiting the teardown, so
  the sweep loop's invariant still holds:

```ts
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
```

  Check the pre-existing tests for an assertion on the ordering of the emitted
  status events; if one breaks because `url` is now cleared after the status
  event rather than before, prefer changing the code to keep the old observable
  order over changing the test.

**Verify**: `npx vitest run test/sandbox-lifecycle.test.ts` → tests 3 and 4
from Step 1 now PASS; 1 and 2 still fail. Then `npm test` → no other test
regressed.

### Step 3: Await disposal on shutdown

In `src/index.ts`, make `shutdown` async and await `dispose()` under a bounded
timeout so a hung Kubernetes API call cannot block the pod's termination grace
period forever:

```ts
/** Give sandbox teardown this long before exiting anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down preview servers…`);
  // Await it: dispose() deletes each chat's sandbox Deployment, and exiting
  // first orphaned every one of them (plans/013). Bounded so a wedged k8s API
  // call cannot hold the pod past its grace period.
  await Promise.race([
    previewManager.dispose(),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]).catch((error) => {
    console.error('Preview teardown failed during shutdown:', error);
  });
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
```

**Verify**: `npm run typecheck` exits 0.

### Step 4: Guard the start against a concurrent stop

The fix is a per-record start token. Any teardown invalidates the in-flight
start that a later `await` would otherwise complete.

In `src/preview-manager.ts`:

- Add to `interface PreviewRecord` (near `ensurePromise`):

```ts
  /**
   * Bumped by every teardown. `runEnsure` captures it and bails after each
   * await when it no longer matches — otherwise a stop()/remove()/sweep that
   * lands during a (minutes-long) sandbox start is invisible to the start,
   * which then registers a handle and a Host route onto a dead record. The old
   * `isFailed` guard caught only status 'failed', never 'stopped'. plans/013.
   */
  startToken: number;
```

  Initialise it in `getOrCreateRecord` (`:285-292`): `startToken: 0`.
- In `teardown`, increment it: `record.startToken += 1;` — put this with the
  other synchronous mutations, before the await.
- Replace the `isFailed` helper with a staleness check that covers all three
  conditions. Keep the "read through a function boundary" trick and its
  comment — it is there for a real reason (control-flow narrowing across
  awaits):

```ts
/**
 * True when an in-flight start no longer owns its record: the preview failed,
 * a teardown bumped the start token (stop / remove / idle sweep / capacity
 * eviction), or the record was dropped from the map entirely by remove().
 * Read through a function boundary so TypeScript's control-flow narrowing does
 * not cache the values across an await.
 */
function isStale(
  manager: PreviewManager,
  chatId: string,
  record: PreviewRecord,
  token: number,
): boolean {
  return (
    record.status === 'failed' ||
    record.startToken !== token ||
    !manager.hasRecord(chatId, record)
  );
}
```

  Add the small public-in-module helper it needs on the class:

```ts
  /** True when `record` is still the live record registered for `chatId`. */
  hasRecord(chatId: string, record: PreviewRecord): boolean {
    return this.records.get(chatId) === record;
  }
```

  (If you prefer to avoid widening the class's surface, make `isStale` a
  private method instead — either is fine, but do not drop the
  `records.get(chatId) === record` check: it is what catches `remove()`.)
- In `runEnsure` (`:362`), capture the token immediately after setting status
  to `'starting'`:

```ts
    const token = record.startToken;
```

  and replace all three `isFailed(record)` calls with
  `isStale(this, chatId, record, token)`.
- At the first guard (`:380-383`), the late handle must be **awaited** on the
  way out, not `void`-ed — that is the leak:

```ts
      const handle = await this.sandbox.start(chatId, { onExit });
      if (isStale(this, chatId, record, token)) {
        // A stop/remove/sweep landed while this start was in flight. The
        // handle we just got is the only reference to a live Deployment, so
        // tear it down here or it leaks forever (nothing else can see it).
        await handle.stop().catch(() => {});
        return;
      }
```

  Do the same at the bridge guard (`:413-416`): `await bridgeHandle.close()`.
  Note that at that point `record.sandbox` is already set, so a teardown will
  handle the sandbox — you only need to close the orphaned bridge here.
- The `onExit` callback (`:365-376`) also mutates the record after an
  arbitrary delay. Add the same ownership check at its top so a crash callback
  for an already-replaced sandbox cannot mark a *new* preview failed:

```ts
    const onExit = (error: Error): void => {
      if (isStale(this, chatId, record, token)) {
        return;
      }
      if (record.status !== 'starting' && record.status !== 'ready') {
        return;
      }
```

**Verify**: `npx vitest run test/sandbox-lifecycle.test.ts` → all four Step 1
tests PASS. Then `npm test` → whole suite green. Then `npm run typecheck` →
exits 0.

### Step 5: Add orphan reaping to the kube seam

In `src/kube-sandbox.ts`:

- Add to `interface KubeSandboxClient`:

```ts
  /**
   * The `sf/session` slug of every sandbox Deployment currently in the
   * namespace, whether or not this process created it. Used by the boot
   * reconcile to reap orphans (plans/013).
   */
  listSessionSlugs(): Promise<string[]>;
```

- Implement it in `createKubeSandboxClient` (`:393-487`), alongside the other
  methods:

```ts
    async listSessionSlugs(): Promise<string[]> {
      const list = await appsApi.listNamespacedDeployment({
        namespace,
        labelSelector: 'sf/tier=sandbox',
      });
      return (list.items ?? [])
        .map((item) => item.metadata?.labels?.['sf/session'])
        .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0);
    }
```

  This is the first read of the `sf/tier: sandbox` label written at `:151`.

- Add a public method to `class KubeSandbox`:

```ts
  /**
   * Delete every sandbox in the namespace whose slug does not belong to a known
   * chat. Sandboxes are the most expensive object this service creates and the
   * only delete path is an in-memory handle, so a crashed start, a killed
   * process, or a SIGTERM used to leak them permanently and invisibly — the
   * concurrency cap counts records, not pods, so orphans were not even capped.
   * Returns the slugs it reaped. plans/013.
   */
  async reapOrphans(knownChatIds: readonly string[]): Promise<string[]> {
    const known = new Set(knownChatIds.map((id) => sandboxSlug(id)));
    const live = await this.client.listSessionSlugs();
    const orphans = live.filter((slug) => !known.has(slug));
    for (const slug of orphans) {
      await this.client.deleteByLabel(`sf/session=${slug}`);
    }
    return orphans;
  }
```

  `sandboxSlug` is deterministic (`:112-120`), so mapping chat ids forward is
  exact — never try to map a slug back to a chat id.

**Verify**: `npm run typecheck` exits 0 (it will fail first in
`test/kube-sandbox.test.ts` until Step 7 adds `listSessionSlugs` to the fake —
that is expected; do Step 7 before declaring this step verified).

### Step 6: Call the reconcile at boot

In `src/factory.ts`, right after the `KubeSandbox` is constructed inside the
`if (config.sandboxMode === 'kube')` block (`:65-75`), and **after**
`chatStore.rehydrate()` has already run (it has — it is at `:57`):

```ts
    // Reconcile: anything labelled sf/tier=sandbox that no longer maps to a
    // known chat is an orphan from a crash, a kill, or a pre-await SIGTERM.
    // Nothing else can ever delete it — the normal delete path needs an
    // in-memory handle this process no longer has. plans/013.
    try {
      const known = (await chatStore.listChats()).map((chat) => chat.chatId);
      const reaped = await sandboxProvider.reapOrphans(known);
      if (reaped.length > 0) {
        console.log(`Reaped ${reaped.length} orphaned sandbox(es): ${reaped.join(', ')}`);
      }
    } catch (error) {
      // Never let a reconcile failure stop the orchestrator from booting.
      console.error('Sandbox orphan reconcile failed:', error);
    }
```

`sandboxProvider` is typed `SandboxProvider | undefined` at `:64`, which has no
`reapOrphans`. Keep a concretely-typed local instead of widening the
`SandboxProvider` interface — reaping is a Kube-only concern and the local
provider has no equivalent:

```ts
  let sandboxProvider: SandboxProvider | undefined;
  if (config.sandboxMode === 'kube') {
    const namespace = resolveSandboxNamespace();
    const kubeSandbox = new KubeSandbox({ /* …unchanged… */ });
    sandboxProvider = kubeSandbox;
    // …the reconcile block above, using kubeSandbox…
  }
```

**Verify**: `npm run typecheck` exits 0.

### Step 7: Test the reaper

In `test/kube-sandbox.test.ts`, extend the existing `FakeKubeClient` with:

```ts
  sessionSlugs: string[] = [];

  async listSessionSlugs(): Promise<string[]> {
    this.calls.push({ kind: 'list', arg: 'sf/tier=sandbox' });
    return this.sessionSlugs;
  }
```

and widen the `FakeCall['kind']` union with `'list'`.

Add a `describe('reapOrphans')` block with these cases:

1. **deletes only the unknown slugs** — `sessionSlugs = ['a', 'b', 'c']`,
   known chat ids `['a', 'c']` → returns `['b']`, and the recorded calls
   contain exactly one delete, for `sf/session=b`.
2. **deletes nothing when every sandbox is known** — returns `[]` and no
   `delete` call is recorded.
3. **maps chat ids through `sandboxSlug`** — use a chat id that is NOT already
   RFC1123 (e.g. a `randomUUID()`-shaped string with uppercase, or any id
   longer than 40 chars) so `sandboxSlug` rewrites it; seed `sessionSlugs`
   with `sandboxSlug(thatId)` and assert it is treated as known, not reaped.
   This is the case that a naive `new Set(knownChatIds)` would get wrong, and
   getting it wrong deletes live users' previews.

**Verify**: `npm test` → whole suite green, including the new tests.

### Step 8: Update the index

Add/refresh this plan's row in `plans/README.md`.

**Verify**: `grep -n "013" plans/README.md` shows your row.

## Test plan

New tests, all offline (no cluster, no child processes):

- `test/sandbox-lifecycle.test.ts` — a `DeferredSandboxProvider`, plus four
  tests: stop-during-start tears the late handle down; remove-during-start
  registers no preview host; `stop()` awaits teardown; `dispose()` awaits every
  teardown. Model them on the existing `makeManager()` harness in that file.
- `test/kube-sandbox.test.ts` — three `reapOrphans` tests, using the existing
  `FakeKubeClient` recording pattern.

Every one of these must be seen to FAIL before the corresponding fix (Step 1
does this explicitly for the first four). A test that passes before the fix is
testing the wrong thing — treat that as a STOP condition.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd app-preview/orchestrator && npm test` exits 0
- [ ] `cd app-preview/orchestrator && npm run typecheck` exits 0
- [ ] `grep -c "isFailed" app-preview/orchestrator/src/preview-manager.ts` returns 0
- [ ] `grep -n "void record.sandbox?.stop()" app-preview/orchestrator/src/preview-manager.ts` returns nothing
- [ ] `grep -n "await previewManager.dispose()\|previewManager.dispose()" app-preview/orchestrator/src/index.ts` shows the call inside an `async` shutdown, awaited
- [ ] `grep -rn "sf/tier" app-preview/orchestrator/src | wc -l` returns at least 3 (the label write, the client's selector, and the reconcile comment)
- [ ] `grep -n "reapOrphans" app-preview/orchestrator/src/factory.ts` shows the boot call
- [ ] 7 new tests exist and pass (4 lifecycle + 3 reaper)
- [ ] `git status --porcelain` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any of the four Step-1 tests **passes** before you make the corresponding fix
  — it means the test is not exercising the window and would give false
  confidence.
- Fixing the awaited teardown breaks a pre-existing test in a way you cannot
  resolve without changing that test's *intent* (reordering assertions is fine;
  deleting or weakening an assertion is not).
- `listNamespacedDeployment` is not available on the installed
  `@kubernetes/client-node` version, or takes a different argument shape than
  the sibling calls in the same file (`readNamespacedDeployment({ name,
  namespace })`). Check the installed version's types rather than guessing, and
  report if they differ.
- You discover the assumption "`sandboxSlug` is deterministic and total" is
  false — everything in Step 5 depends on it.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

For whoever owns this next:

- **What a reviewer should scrutinise**: the ordering inside `teardown` (record
  references cleared before the await, so a concurrent caller cannot double-stop
  the same handle), and the `stop()` status flip happening synchronously before
  the await, which the idle sweep and capacity check both depend on.
- **The reconcile has one sharp edge**: it deletes any `sf/tier=sandbox`
  Deployment whose slug maps to no known chat. If a second orchestrator ever
  runs against the same namespace, each will reap the other's sandboxes. The
  service is single-replica by design (`strategy: Recreate`), so this is safe
  today — but if the orchestrator is ever scaled or an HA story appears, this
  reconcile must be scoped (e.g. by an instance label) *before* that happens.
- **Deliberately deferred** (separate follow-ups):
  1. `app-preview/sandbox/entrypoint.sh` — `trap cleanup TERM INT` cannot fire
     while `node /opt/sandbox/resync.js` runs in the foreground. Run it with
     `& wait -n` (or `exec`) so pods terminate promptly instead of burning the
     full grace period.
  2. `KubeSandbox`'s `httpPost` (`src/kube-sandbox.ts:479-486`) has no
     `AbortSignal`, unlike `httpGet` two lines above it, so a wedged pod leaves
     a resync promise pending forever.
  3. `PreviewManager.touch()` documents "the turn pipeline calls this" — it
     does not; nothing outside the class calls it. A chat whose user closed the
     preview tab but keeps taking red turns can be swept mid-session.
  4. Periodic (not just boot) orphan reconcile, alongside the existing idle
     sweep.
