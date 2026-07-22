# Plan 015: Serialize PlatformDb transactions so two chats cannot corrupt each other

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5b9facb..HEAD -- app-preview/orchestrator/src/sql-driver.ts app-preview/orchestrator/src/platform-db.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — this is the write path for every persisted turn event
- **Depends on**: `plans/012-appview-into-verify-and-ci.md` (soft — 012 makes
  the orchestrator suite run in CI; you can execute this plan without it by
  running `npm test` by hand)
- **Category**: bug
- **Planned at**: commit `5b9facb`, 2026-07-21

## Why this matters

`PlatformDb` holds **one** database connection, and its transaction API is a
bare `begin()` / `commit()` / `rollback()` triple with awaits in between. There
is no mutex, queue, or per-transaction connection anywhere between the callers
and the driver.

`appendTurnEvent` runs for **every streamed event of every turn**. So when two
chats take a turn at the same time — which is the entire point of the cloud
direction this service is being built for — their transactions interleave:

1. Chat A calls `begin()`, then awaits a `SELECT`.
2. Chat B calls `begin()`. On MSSQL this throws
   `'MssqlDriver: a transaction is already open'`. On SQLite,
   `BEGIN IMMEDIATE` inside an open transaction is an error too.
3. B's `catch` runs `await this.driver.rollback()` — which rolls back **A's**
   transaction, because there is only one.
4. A's already-inserted `turn_events` rows vanish, and A's `nextEventSeq`
   cache still points past a sequence number that no longer exists, so A's
   subsequent inserts are numbered wrong.

Turn history silently loses rows, and nothing raises an alarm on A's side.

The test suite cannot catch this: `grep -n "Promise.all" test/*.ts` finds only
cleanup fan-out — no test ever issues two concurrent writes.

## Current state

All paths are under `app-preview/orchestrator/`.

### `src/sql-driver.ts:25-34` — the interface exposes the raw triple

```ts
export interface SqlDriver {
  readonly dialect: Dialect;
  exec(sql: string): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}
```

### `SqliteDriver` — one shared connection

```ts
  async begin(): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
  }

  async commit(): Promise<void> {
    this.db.exec('COMMIT');
  }

  async rollback(): Promise<void> {
    this.db.exec('ROLLBACK');
  }
```

`this.db` is a single `node:sqlite` `DatabaseSync` instance.

### `MssqlDriver` — one `tx` field, and it says so itself

```ts
  private tx: import('mssql').Transaction | null = null;

  /**
   * Requests run on the open transaction when there is one. Taking a fresh
   * connection from the pool mid-transaction would land the statement outside
   * it, so BEGIN/COMMIT must bind to one connection.
   */
  private request(): import('mssql').Request {
    return this.tx ? new this.mssql.Request(this.tx) : this.pool.request();
  }

  async begin(): Promise<void> {
    if (this.tx) {
      throw new Error('MssqlDriver: a transaction is already open');
    }
    const tx = new this.mssql.Transaction(this.pool);
    await tx.begin();
    this.tx = tx;
  }

  async rollback(): Promise<void> {
    if (!this.tx) {
      return; // rollback on a closed transaction is a no-op, not an error
    }
    const tx = this.tx;
    this.tx = null;
    await tx.rollback();
  }
```

Note `rollback()` deliberately cannot tell "my transaction" from "someone
else's" — it just rolls back whatever is open. That is the mechanism of the
cross-chat corruption.

### `src/platform-db.ts` — seven transaction sites

`grep -n "begin()\|commit()\|rollback()" src/platform-db.ts` returns lines
247/265/267 (inside the static `migrate`), then 469/502/512, 557/581/595,
635/648/659, 671/678/689/691, 732/753/756, 825/840/843.

The hot one is `appendTurnEvent` (`src/platform-db.ts:459-514`), which has the
canonical shape — `begin()`, several awaited round-trips, `commit()`, and a
`catch` that rolls back and clears the sequence cache:

```ts
    await this.driver.begin();
    try {
      const generation = await this.driver.get<{ chatId: string }>(
        'SELECT chat_id AS chatId FROM generations WHERE id = ?',
        [generationId],
      );
      if (!generation) {
        throw new Error(`Generation not found: ${generationId}`);
      }
      let next = this.nextEventSeq.get(generationId);
      …
      await this.driver.run(
        'INSERT INTO turn_events (chat_id, generation_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        […],
      );
      this.nextEventSeq.set(generationId, next + 1);
      if (event.type === 'narration') {
        await this.driver.run(appendNarration, [event.text, generationId]);
      }
      await this.driver.commit();
      return { … };
    } catch (error) {
      await this.driver.rollback();
      this.nextEventSeq.delete(generationId);
      throw error;
    }
```

The other five instance-method sites (`insertVersion`,
`approveBlueprintRevision`, `createConnection`, `deleteChat`, and the one at
:635) use the same shape.

### Conventions to match

- `src/sql-driver.ts`'s module docstring explains the async-interface choice
  ("SQLite fulfils it with already-resolved promises — the underlying calls
  stay synchronous, nothing is deferred artificially"). Keep that spirit: do
  not introduce artificial deferral.
- Comments explain **why**. `translatePlaceholders`'s comment block is the
  house style.
- **Test exemplar**: `test/sql-driver.test.ts` — small, focused, each test
  named for the failure it prevents ("Renaming it would silently corrupt the
  value written to the column — the failure this test exists to prevent").
  `test/platform-db.test.ts` is the exemplar for tests that open a real
  temp-file SQLite `PlatformDb`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `cd app-preview/orchestrator && npm ci` | exit 0 |
| Tests | `cd app-preview/orchestrator && npm test` | exit 0, all pass |
| Driver tests | `cd app-preview/orchestrator && npx vitest run test/sql-driver.test.ts test/platform-db.test.ts` | exit 0 |
| Typecheck | `cd app-preview/orchestrator && npm run typecheck` | exit 0, no output |

## Scope

**In scope** (the only files you should modify):
- `app-preview/orchestrator/src/sql-driver.ts`
- `app-preview/orchestrator/src/platform-db.ts`
- `app-preview/orchestrator/test/sql-driver.test.ts` (add tests)
- `app-preview/orchestrator/test/platform-db.test.ts` (add a test)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):
- **The SQL itself.** No query text changes. This plan changes *when*
  transactions run, never *what* they do.
- **`app-preview/orchestrator/migrations/`** — the hand-written per-dialect SQL
  files. Untouched.
- `src/chat-store.ts` and every other caller of `PlatformDb`. The public
  `PlatformDb` method signatures do not change, so callers need no edits. If
  you find yourself editing a caller, you have gone off-plan.
- Moving MSSQL to a per-transaction pooled connection. That is the "right"
  long-term answer for throughput, but it is a bigger change with real
  connection-lifetime risk. Serializing is the conservative fix and is
  correct on both dialects. Recorded in maintenance notes.
- **The working tree has uncommitted changes from other work** (files under
  `apps/intake/`, `mockups/`, `plans/009`–`011`). Do not stage or commit them.

## Git workflow

- Branch: `advisor/015-serialize-transactions`
- Conventional commits, e.g.
  `fix(appview): serialize platform-db transactions (concurrent chats corrupted each other)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Find every caller of the raw triple

Before changing the interface, learn who uses it:

```
grep -rn "\.begin()\|\.commit()\|\.rollback()" app-preview/orchestrator/src app-preview/orchestrator/test app-preview/orchestrator/scripts
```

Expect hits only in `src/sql-driver.ts` (the definitions) and
`src/platform-db.ts` (the seven sites). **If any test or script calls them
directly**, note it — those call sites must be converted too, and if converting
one would change a test's intent, that is a STOP condition.

**Verify**: you can list every call site.

### Step 2: Add the serialized `withTransaction` to the driver seam

In `src/sql-driver.ts`, add a small queue helper and one method to the
interface.

```ts
/**
 * Serializes transaction bodies onto one chain.
 *
 * Every driver here owns exactly ONE connection (SQLite's DatabaseSync; the
 * MssqlDriver's single `tx` field), so two overlapping begin…commit blocks
 * share one transaction scope. Before this gate existed, chat B's begin() threw
 * and B's catch called rollback(), which discarded chat A's already-inserted
 * rows — silent turn-history loss under exactly the concurrency this service is
 * built for. plans/015.
 */
class TransactionGate {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the tail whether the previous body settled or threw; a failed
    // transaction must not wedge the queue.
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
```

Change the interface: **remove** `begin`, `commit`, and `rollback`, and add:

```ts
  /**
   * Run `fn` inside a transaction, serialized against every other
   * withTransaction on this driver. Commits on return, rolls back on throw and
   * rethrows. NOT reentrant — calling it from inside `fn` deadlocks.
   */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
```

Removing them from the interface is the point: it is what makes the old,
corrupting pattern unwriteable rather than merely discouraged.

In **each** driver class, keep `begin`/`commit`/`rollback` but make them
`private`, add `private readonly gate = new TransactionGate();`, and add:

```ts
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.gate.run(async () => {
      await this.begin();
      try {
        const result = await fn();
        await this.commit();
        return result;
      } catch (error) {
        await this.rollback();
        throw error;
      }
    });
  }
```

The body is identical in both classes; duplicating ~12 lines is fine and
keeps each driver self-contained, matching how the rest of this file is
written. Do not introduce an abstract base class for it.

**Verify**: `npm run typecheck` — it will now fail in `src/platform-db.ts` at
every site that calls `begin()`. That is expected and tells you exactly which
sites Step 3 must convert. Record the list.

### Step 3: Convert the seven PlatformDb sites

For each, the transformation is mechanical: the body between `begin()` and
`commit()` becomes the callback, `commit()` disappears, and the
`catch { rollback(); … }` keeps only the non-rollback cleanup.

`appendTurnEvent` becomes:

```ts
    return this.driver.withTransaction(async () => {
      const generation = await this.driver.get<{ chatId: string }>(…);
      if (!generation) {
        throw new Error(`Generation not found: ${generationId}`);
      }
      …
      await this.driver.run('INSERT INTO turn_events …', […]);
      this.nextEventSeq.set(generationId, next + 1);
      if (event.type === 'narration') {
        await this.driver.run(appendNarration, [event.text, generationId]);
      }
      return { chatId: generation.chatId, generationId, seq: next, type: event.type, event, createdAt };
    }).catch((error) => {
      // The seq cache tracked writes that the rollback just undid.
      this.nextEventSeq.delete(generationId);
      throw error;
    });
```

Rules for every conversion:
- **Keep any non-rollback side effect that was in the original `catch`.** In
  `appendTurnEvent` that is `this.nextEventSeq.delete(generationId)`. Losing it
  would reintroduce the stale-sequence bug from a different direction. Attach
  it with `.catch(…)` *outside* the transaction body, as above, so it runs
  after the rollback rather than inside the doomed transaction.
- **Do not call `withTransaction` inside another `withTransaction`.** It
  deadlocks. Check the site at `src/platform-db.ts:671`
  (`approveBlueprintRevision`) with particular care — it has a `rollback()` at
  :678 *inside* the try, i.e. an early-exit rollback partway through. Convert
  that to a `throw` of a sentinel error caught outside, or restructure so the
  early exit returns before the transaction opens. Read that method in full
  before converting it; if the right shape is not obvious, STOP and report
  rather than guessing.
- The static `migrate` site (:247) converts the same way. It runs at open time
  with no concurrency, but converting it means `begin()` has exactly one caller
  path, which is what the done-criteria grep checks.

**Verify**: `npm run typecheck` exits 0, and `npm test` passes with no
behavioural change.

### Step 4: Prove the fix with a concurrency test

In `test/sql-driver.test.ts`, add a `describe('withTransaction')` block against
a real `SqliteDriver` (the file already imports it):

1. **serializes overlapping transactions** — start two `withTransaction` calls
   without awaiting the first, each recording `enter`/`exit` markers into a
   shared array around an `await` (e.g. a `setTimeout(0)`). Assert the markers
   are `['enter1','exit1','enter2','exit2']` — never interleaved.
2. **a throwing body rolls back and does not wedge the queue** — run one
   transaction that inserts and throws, assert it rejects and the row is
   absent, then run a second that succeeds, proving the gate still flows.
3. **returns the body's value** — a trivial round-trip assertion.

In `test/platform-db.test.ts`, add the test that names the real bug:

4. **concurrent `appendTurnEvent` calls keep every row and a gapless sequence**
   — create two generations, fire N events for each with
   `await Promise.all([...])` (interleaved, NOT sequential), then read both
   generations' events back and assert each has all N rows with `seq` values
   `1..N` and no duplicates. Model the setup on the existing tests in that file
   that open a real temp-file `PlatformDb`.

Run test 4 **against the pre-fix code first** if you still have it stashed, or
reason it through: it must be the kind of test that would fail before Step 3.
If it passes with the gate removed, it is not exercising the interleave —
increase N or add an await inside the body.

**Verify**: `npx vitest run test/sql-driver.test.ts test/platform-db.test.ts`
→ all pass, including 4 new tests.

### Step 5: Full suite

**Verify**:
- `npm test` → whole orchestrator suite green.
- `npm run typecheck` → exits 0.

### Step 6: Update the index

**Verify**: `grep -n "015" plans/README.md` shows your row.

## Test plan

- `test/sql-driver.test.ts` — three `withTransaction` tests (serialization,
  rollback-does-not-wedge, return value), against a real `SqliteDriver`.
  Structural pattern: the existing `translatePlaceholders` describe block.
- `test/platform-db.test.ts` — one concurrency test proving two generations'
  interleaved `appendTurnEvent` calls both keep every row with a gapless `seq`.
  Structural pattern: the existing tests in that file that open a real
  temp-file `PlatformDb`.
- Regression: the full suite must pass unchanged — this plan alters timing, not
  semantics.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd app-preview/orchestrator && npm test` exits 0
- [ ] `cd app-preview/orchestrator && npm run typecheck` exits 0
- [ ] `grep -n "driver.begin()\|driver.commit()\|driver.rollback()" app-preview/orchestrator/src/platform-db.ts` returns **nothing**
- [ ] `grep -c "withTransaction" app-preview/orchestrator/src/platform-db.ts` returns 7 (one per converted site)
- [ ] `grep -n "begin(): Promise<void>" app-preview/orchestrator/src/sql-driver.ts` shows it only as `private` members, not on the `SqlDriver` interface
- [ ] 4 new tests exist and pass
- [ ] `git status --porcelain` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `approveBlueprintRevision` (`src/platform-db.ts:671`) cannot be converted
  without changing its behaviour — its mid-try `rollback()` at :678 is an
  early-exit path and is the one non-mechanical conversion in this plan.
- Any call site of `begin`/`commit`/`rollback` exists outside
  `src/platform-db.ts` (Step 1) and converting it would change a test's intent.
- The concurrency test in Step 4 passes with the gate removed — it is not
  exercising the interleave and would give false confidence.
- Removing `begin`/`commit`/`rollback` from the `SqlDriver` interface breaks
  something you did not expect (e.g. the `rawDriver` escape hatch at
  `src/platform-db.ts:167` is used by a test to drive a transaction directly).
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

For whoever owns this next:

- **What a reviewer should scrutinise**: that every original `catch` block's
  non-rollback side effects survived the conversion (the `nextEventSeq.delete`
  in `appendTurnEvent` is the load-bearing one), and that no `withTransaction`
  call appears inside another one.
- **The gate is not reentrant, by design.** A nested call deadlocks silently —
  the outer transaction never commits, so the inner one never gets its turn.
  If this ever becomes a real constraint, the fix is an explicit
  already-in-transaction check that throws a clear error rather than making the
  gate reentrant (a reentrant "transaction" is not a transaction).
- **This serializes ALL writes on the instance**, which is the correct trade
  for a single-connection driver but does cap write throughput at one
  transaction at a time. The real scaling answer for MSSQL is a
  connection-per-transaction from the existing pool — `MssqlDriver.request()`
  already documents why the current code cannot do that. Revisit if write
  latency shows up under real multi-user load; the `withTransaction` seam
  introduced here is exactly the right place to make that change, with no
  caller edits.
- **Related, deliberately not fixed here**: the parallel per-dialect migration
  files (`migrations/sqlite/` vs `migrations/mssql/`) are kept in step only by
  `test/migrations-parity.test.ts`, which does not run in CI until
  `plans/012` lands.
