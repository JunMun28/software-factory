# GenerationStream (Deepening Candidate 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the four copy-pasted "thinking-poll + SSE-with-fallback" loops in the intake wizard (Interview, Prototype, Review, PlanPanel) into one deep, purely-unit-tested `GenerationStream<T>` class; the components shrink to wiring.

**Architecture:** `GenerationStream<T>` is a plain class (not a component, not a global service), one instance per wizard step, constructed with `(readFn, streamUrlFn, isThinking, destroyRef)` plus a small options bag for the per-step differences. It exposes signals `{ state, thinking, streaming }`, owns the 1500 ms poll loop, the SSE-open/terminal-event/fallback dance, and teardown via `DestroyRef`. It absorbs the `streamState()` util from `@sf/shared` (grep-verified 2026-07-15: the only consumers are `apps/intake/src/app/submitter/interview.ts`, `apps/intake/src/app/submitter/prototype.ts`, and `packages/shared/src/lib/util.spec.ts` — the console never imports it, so absorption is allowed per D14).

**Tech Stack:** Angular 22 signals (`signal`/`computed` outside injection context — legal), RxJS Observables from the existing `Api` service, vitest with `vi.useFakeTimers()` and a stubbed `EventSource`. No TestBed for the class tests.

**Branch:** `generation-stream` off local `main` (per the spec's Sequencing section, candidate 3 is its own small branch, independent of candidates 1 and 2).

## Reality check vs. the design doc (read this first)

The design doc (D13–D15 in `docs/superpowers/specs/2026-07-14-deepening-candidates-design.md`) says "four loops". The current code (post-`feffefa`) actually splits 2 + 2:

- **Interview** (`interview.ts`) and **Prototype** (`prototype.ts`): full poll **+ SSE-with-fallback** against `api.interview(id, gen)` / `api.prototype(id, gen)` and `api.interviewStreamUrl(id)` / `api.prototypeStreamUrl(id)`.
- **Review** (`review.ts`) and **PlanPanel** (`plan-panel.ts`): **poll-only** against `api.summary(id)` — there is no summary SSE endpoint. `streamUrlFn` is therefore nullable: `null` means "poll-only mode".

Exact per-instance differences the class parameterizes (verified line-by-line against current files):

| Axis | Interview | Prototype | Review | PlanPanel |
|---|---|---|---|---|
| read | `api.interview(id, kick)` | `api.prototype(id, kick)` | `api.summary(id)` (no kick param) | `api.summary(id)` (no kick param) |
| SSE URL | `api.interviewStreamUrl(id)` | `api.prototypeStreamUrl(id)` | none (poll-only) | none (poll-only) |
| isThinking (poll continuation + `thinking` signal) | `s.thinking` | `s.thinking` | `s.thinking` | `s.thinking` |
| drive-on-load predicate | `s.thinking` | `s.status !== 'skipped' && (!s.html \|\| s.thinking \|\| hasPending(s))` | `s.thinking` (poll) | `s.thinking` (poll) |
| SSE payload validation | `!!s && typeof s.asked === 'number'` | `!!s && typeof s.status === 'string'` | — | — |
| re-stream after terminal SSE event | never | `hasPending(s)` (a queued edit is still owed) | — | — |
| drive after a mutation response | `answer`/`reopen`: `s.thinking` | `send`: `s.thinking \|\| hasPending(s)`; `undo`: never | — | — |
| onState side effects | load/sse: `busy.set(false)` + `scrollToEnd()`; poll: nothing | load/sse/poll: `scrollToEnd()` | none | none |
| load error | `busy.set(false)` | silent | silent | silent (was unhandled) |
| poll-tick error | `busy.set(false)`, loop stops | silent, loop stops | silent, loop stops | silent, loop stops |
| public re-entry | no | no | no | `refresh()` called by Interview parent (5 call sites) |
| poll interval | 1500 ms | 1500 ms | 1500 ms | 1500 ms |

**Documented deviation from D14's literal signature:** the constructor keeps the four binding positional args `(readFn, streamUrlFn, isThinking, destroyRef)` and adds an optional fifth `opts` bag. The three "should I (re)open the stream" decision points (on load, after a terminal event, after a mutation) genuinely differ between Interview and Prototype, and the SSE payload validation predicates differ; forcing them through the single `isThinking` would change behavior. This is the minimal extension that keeps every step byte-for-byte equivalent. Log this in `implementation-notes.md` under `## Deviations`.

**Accepted micro-normalizations** (not user-observable; log them in `implementation-notes.md`):
1. Prototype's poll gains clear-timer-before-schedule (Interview's `scheduleNextPoll` shape) — Prototype only ever has one pending tick anyway.
2. Prototype's and PlanPanel's poll/read errors become explicitly-silent instead of RxJS-unhandled (loop stopped either way; only the console error report disappears).
3. Interview's `scrollToEnd()` on an *invalid* SSE payload disappears (today it scrolls even when falling back to poll; the class fires `onState` only for adopted states). Invalid payloads are a server-bug edge; the recovery poll path is unchanged.
4. PlanPanel's `refresh()` now cancels a pending poll tick at entry instead of after the response lands (one fewer redundant GET in a race; final state identical).

## Global Constraints

- **D13 (binding):** the module lives at `apps/intake/src/app/submitter/generation-stream.ts` — NOT in `@sf/shared`.
- **D14 (binding):** plain class, one instance per wizard step; constructor `(readFn, streamUrlFn, isThinking, destroyRef)`; exposes signals `{ state, thinking, streaming }`; owns the 1500 ms poll loop, SSE-with-fallback, teardown; absorbs `streamState()` (intake-only consumer — verified, see above; re-run the grep in Task 5 before deleting).
- **D15 (binding):** pure unit tests with fake timers + a stubbed EventSource — no TestBed. The four components' own specs shrink to "wires the stream" assertions.
- **Zero behavioral change per step** — each component migration is its own task and must end green.
- Intake vitest must pass: `npx ng test intake` (and `npx ng test shared` when `packages/shared` is touched).
- House style: standalone components, inline templates, signals; single quotes, trailing commas, ~100-col prettier (run `npm run format:check` if unsure).
- Never UPDATE/DELETE `progress_event` rows (repo rule — irrelevant here, but binding).
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Never push.

## File Structure

- **Create:** `apps/intake/src/app/submitter/generation-stream.ts` — the deep module (class + absorbed private SSE helper).
- **Create:** `apps/intake/src/app/submitter/generation-stream.spec.ts` — pure unit tests.
- **Modify:** `apps/intake/src/app/submitter/interview.ts`, `prototype.ts`, `review.ts`, `plan-panel.ts` — each loses its loop plumbing, keeps a `GenerationStream` field + signal aliases.
- **Modify:** `apps/intake/src/app/submitter/interview.spec.ts`, `review.spec.ts` — add one "wires the stream" assertion each. (`prototype.ts` and `plan-panel.ts` have **no** spec files today; per D15 the loop behavior is covered by the class's own tests — do NOT create new TestBed specs for them.)
- **Modify (Task 5 only):** `packages/shared/src/lib/util.ts` (delete `streamState`), `packages/shared/src/lib/util.spec.ts` (delete its describe block).

---

### Task 1: The GenerationStream class + pure unit tests

**Files:**
- Create: `apps/intake/src/app/submitter/generation-stream.ts`
- Test: `apps/intake/src/app/submitter/generation-stream.spec.ts`

**Interfaces:**
- Consumes: nothing from this plan; `Observable` from rxjs, `DestroyRef`/`signal`/`computed` from `@angular/core`.
- Produces (Tasks 2–4 rely on these exact names):
  - `class GenerationStream<T>` with constructor `(readFn: (kick: boolean) => Observable<T>, streamUrlFn: (() => string) | null, isThinking: (s: T) => boolean, destroyRef: DestroyRef, opts?: GenerationStreamOptions<T>)`
  - `readonly state: WritableSignal<T | null>` (writable — mutation responses and component specs set it)
  - `readonly thinking: Signal<boolean>`, `readonly streaming: Signal<boolean>`
  - `refresh(): void` (initial load AND public re-entry), `ingest(s: T, drive?: boolean): void`
  - `interface GenerationStreamOptions<T>` with optional `isValidEvent`, `needsStreamOnLoad`, `needsStreamAfterEvent`, `onState(s, source: 'load' | 'sse' | 'poll')`, `onLoadError`, `onPollError`.

- [ ] **Step 1: Write the failing test file**

Create `apps/intake/src/app/submitter/generation-stream.spec.ts` with this exact content. The `FakeES` stub is ported from `packages/shared/src/lib/util.spec.ts` (whose `streamState` block Task 5 deletes).

```ts
import { DestroyRef } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GenerationStream, GenerationStreamOptions } from './generation-stream';

/** The minimal state shape the tests drive: `thinking` is the generation flag. */
interface S {
  thinking: boolean;
  tag: string;
}
const idle: S = { thinking: false, tag: 'idle' };
const busy: S = { thinking: true, tag: 'busy' };

/** A pure DestroyRef stand-in — collects callbacks, fires them on destroy(). No TestBed. */
class FakeDestroyRef {
  private fns: (() => void)[] = [];
  onDestroy(fn: () => void) {
    this.fns.push(fn);
    return () => {};
  }
  destroy() {
    for (const fn of this.fns) fn();
  }
}

/** A minimal EventSource stand-in (ported from util.spec.ts): records the URL, captures
 *  listeners, and lets the test drive the single `state` event / an error / close. */
class FakeES {
  static instances: FakeES[] = [];
  onerror: (() => void) | null = null;
  closed = false;
  private handlers = new Map<string, (e: MessageEvent) => void>();
  constructor(public url: string) {
    FakeES.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.handlers.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: string) {
    this.handlers.get(type)?.({ data } as unknown as MessageEvent);
  }
}
const es = () => FakeES.instances[FakeES.instances.length - 1];

describe('GenerationStream', () => {
  const g = globalThis as unknown as { EventSource: typeof EventSource };
  let origES: typeof EventSource;
  let destroyRef: FakeDestroyRef;
  let read: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    origES = g.EventSource;
    g.EventSource = FakeES as unknown as typeof EventSource;
    FakeES.instances = [];
    destroyRef = new FakeDestroyRef();
    read = vi.fn((_kick: boolean): Observable<S> => of(idle));
  });
  afterEach(() => {
    destroyRef.destroy();
    g.EventSource = origES;
    vi.useRealTimers();
  });

  function make(streamUrl: (() => string) | null, opts: GenerationStreamOptions<S> = {}) {
    return new GenerationStream<S>(
      (kick) => read(kick),
      streamUrl,
      (s) => s.thinking,
      destroyRef as unknown as DestroyRef,
      opts,
    );
  }

  it('refresh() reads WITHOUT the generation kick and exposes the state', () => {
    const gen = make(null);
    expect(gen.state()).toBeNull();
    gen.refresh();
    expect(read).toHaveBeenCalledExactlyOnceWith(false);
    expect(gen.state()).toEqual(idle);
  });

  it('thinking mirrors isThinking on the current state (false while state is null)', () => {
    const gen = make(null);
    expect(gen.thinking()).toBe(false);
    gen.ingest(busy);
    expect(gen.thinking()).toBe(true);
    gen.ingest(idle);
    expect(gen.thinking()).toBe(false);
  });

  it('a thinking load opens the SSE stream at streamUrlFn()', () => {
    read.mockReturnValue(of(busy));
    const gen = make(() => '/api/x/stream');
    gen.refresh();
    expect(gen.streaming()).toBe(true);
    expect(es().url).toBe('/api/x/stream');
  });

  it('needsStreamOnLoad overrides the drive-on-load decision', () => {
    // state is NOT thinking, but the custom predicate says a draft is owed
    const gen = make(() => '/s', { needsStreamOnLoad: (s) => s.tag === 'idle' });
    gen.refresh();
    expect(gen.streaming()).toBe(true);
    expect(FakeES.instances).toHaveLength(1);
  });

  it('a valid terminal event adopts the state, closes the stream, fires onState("sse")', () => {
    read.mockReturnValue(of(busy));
    const seen: string[] = [];
    const gen = make(() => '/s', { onState: (s, src) => seen.push(`${src}:${s.tag}`) });
    gen.refresh();
    es().emit('state', JSON.stringify({ thinking: false, tag: 'done' }));
    expect(gen.state()!.tag).toBe('done');
    expect(gen.streaming()).toBe(false);
    expect(es().closed).toBe(true);
    expect(seen).toEqual(['load:busy', 'sse:done']);
  });

  it('an invalid terminal event is NOT adopted and falls back to a kicked poll', () => {
    read.mockReturnValue(of(busy));
    const gen = make(() => '/s', { isValidEvent: (s) => s.tag !== 'bad' });
    gen.refresh();
    read.mockReturnValue(of(idle));
    es().emit('state', JSON.stringify({ thinking: false, tag: 'bad' }));
    expect(read).toHaveBeenLastCalledWith(true); // the poll fallback kicks generation
    expect(gen.state()!.tag).toBe('idle'); // the poll's state, never the bad payload
  });

  it('an SSE error falls back to a 1500 ms poll loop that stops when thinking clears', () => {
    read.mockReturnValue(of(busy));
    const gen = make(() => '/s');
    gen.refresh(); // read #1 (false) → stream opens
    es().onerror!(); // → poll: read #2 (true), still thinking → schedule
    expect(gen.streaming()).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    read.mockReturnValue(of(idle));
    vi.advanceTimersByTime(1500); // read #3 (true) → idle → loop stops
    expect(read).toHaveBeenCalledTimes(3);
    expect(gen.state()).toEqual(idle);
    vi.advanceTimersByTime(5000);
    expect(read).toHaveBeenCalledTimes(3); // no further ticks
  });

  it('needsStreamAfterEvent reopens the stream after a terminal event', () => {
    read.mockReturnValue(of(busy));
    const gen = make(() => '/s', { needsStreamAfterEvent: (s) => s.tag === 'more' });
    gen.refresh();
    es().emit('state', JSON.stringify({ thinking: false, tag: 'more' }));
    expect(FakeES.instances).toHaveLength(2); // a queued edit is still owed → re-stream
    expect(gen.streaming()).toBe(true);
    es().emit('state', JSON.stringify({ thinking: false, tag: 'done' }));
    expect(FakeES.instances).toHaveLength(2);
    expect(gen.streaming()).toBe(false);
  });

  it('poll-only mode (null streamUrl) never opens an EventSource and polls at 1500 ms', () => {
    read.mockReturnValue(of(busy));
    const gen = make(null);
    gen.refresh(); // read #1 (false), thinking → schedule
    expect(FakeES.instances).toHaveLength(0);
    expect(gen.streaming()).toBe(false);
    vi.advanceTimersByTime(1500); // read #2 (true), still thinking
    expect(read).toHaveBeenCalledTimes(2);
    read.mockReturnValue(of(idle));
    vi.advanceTimersByTime(1500); // read #3 → idle → stop
    expect(read).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(5000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('refresh() cancels a pending poll tick — exactly one loop at a time', () => {
    read.mockReturnValue(of(busy));
    const gen = make(null);
    gen.refresh(); // read #1 (false) → tick pending
    gen.refresh(); // read #2 (false), pending tick cancelled, new tick scheduled
    read.mockReturnValue(of(idle));
    vi.advanceTimersByTime(1500); // read #3 (true) from the SECOND refresh only
    expect(read.mock.calls.map((c) => c[0])).toEqual([false, false, true]);
  });

  it('ingest(s, true) drives generation; ingest(s) only adopts', () => {
    const gen = make(() => '/s');
    gen.ingest(busy);
    expect(FakeES.instances).toHaveLength(0); // adopt only — no drive
    gen.ingest(busy, true);
    expect(FakeES.instances).toHaveLength(1); // drive → SSE opens
    expect(gen.streaming()).toBe(true);
  });

  it('destroy closes the stream, cancels the pending poll, and blocks further work', () => {
    read.mockReturnValue(of(busy));
    const gen = make(() => '/s');
    gen.refresh();
    destroyRef.destroy();
    expect(es().closed).toBe(true);
    expect(gen.streaming()).toBe(false);
    gen.refresh(); // a late call after destroy is a no-op
    expect(read).toHaveBeenCalledTimes(1);

    // poll-only: the pending tick dies with the instance
    destroyRef = new FakeDestroyRef();
    read.mockClear();
    read.mockReturnValue(of(busy));
    const gen2 = make(null);
    gen2.refresh();
    destroyRef.destroy();
    vi.advanceTimersByTime(5000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('onLoadError / onPollError fire on the respective failures and the loop stops', () => {
    const loadErr = vi.fn();
    const pollErr = vi.fn();
    read.mockReturnValue(throwError(() => new Error('boom')));
    const gen = make(null, { onLoadError: loadErr, onPollError: pollErr });
    gen.refresh();
    expect(loadErr).toHaveBeenCalledOnce();
    expect(gen.state()).toBeNull();

    read.mockReturnValue(of(busy));
    gen.refresh(); // recovers: thinking → tick scheduled
    read.mockReturnValue(throwError(() => new Error('boom')));
    vi.advanceTimersByTime(1500); // the poll tick errors
    expect(pollErr).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(5000);
    expect(read).toHaveBeenCalledTimes(3); // loop stopped after the error
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ng test intake -- --run generation-stream` (from the repo root; if the arg passthrough doesn't filter, plain `npx ng test intake` is fine)
Expected: FAIL — `Cannot find module './generation-stream'` (or equivalent resolution error).

- [ ] **Step 3: Write the implementation**

Create `apps/intake/src/app/submitter/generation-stream.ts` with this exact content:

```ts
import { DestroyRef, Signal, WritableSignal, computed, signal } from '@angular/core';
import { Observable } from 'rxjs';

/** Per-step knobs for the parts of the loop that genuinely differ between wizard steps.
 *  Everything is optional; the defaults reproduce the Interview's (simplest) shape. */
export interface GenerationStreamOptions<T> {
  /** Validate the SSE terminal payload before adopting it; invalid → poll fallback.
   *  (Interview: `typeof s.asked === 'number'`; Prototype: `typeof s.status === 'string'`.) */
  isValidEvent?: (s: T) => boolean;
  /** Whether the initial read should start driving generation. Default: isThinking.
   *  (Prototype also drives when the first draft is owed: no html / a pending turn.) */
  needsStreamOnLoad?: (s: T) => boolean;
  /** Whether a terminal SSE state leaves more generation owed → reopen the stream.
   *  Default: never. (Prototype: a queued edit is still `pending`.) */
  needsStreamAfterEvent?: (s: T) => boolean;
  /** Side effects after each adopted state, with where it came from — components hang
   *  their scroll-to-end / busy-flag bookkeeping here instead of owning the loop. */
  onState?: (s: T, source: 'load' | 'sse' | 'poll') => void;
  /** The initial read errored. Default: silent (a revisit retries). */
  onLoadError?: () => void;
  /** A poll tick errored. Default: silent — the loop stops, the read stays retryable. */
  onPollError?: () => void;
}

/** Re-poll cadence while the server reports it is still generating. */
const POLL_MS = 1500;

/**
 * One wizard step's generation loop, made deep (deepening candidate 3, D13–D15):
 * read the step's state, and while the server is generating drive it to completion —
 * over SSE when the step has a stream endpoint (`streamUrlFn`), falling back to a
 * kicked 1500 ms poll on any SSE hiccup; poll-only when `streamUrlFn` is null
 * (the Review summary has no stream). Owns its timers and EventSource, and tears
 * both down via the component's DestroyRef. Plain class — one instance per step,
 * no TestBed needed to test it.
 *
 * The read is called `readFn(kick)`: `kick=false` for the initial/re-entry read
 * (the stream drives generation itself), `kick=true` on poll ticks (the poll IS
 * the generation kicker when SSE is unavailable). Poll-only steps ignore the flag.
 */
export class GenerationStream<T> {
  /** The latest server state. Writable: mutation responses adopt through ingest(),
   *  and component specs set it directly. */
  readonly state: WritableSignal<T | null> = signal<T | null>(null);
  /** The server is generating (isThinking on the current state; false while null). */
  readonly thinking: Signal<boolean>;
  private _streaming = signal(false);
  /** An SSE connection is open, driving the generation. */
  readonly streaming: Signal<boolean> = this._streaming.asReadonly();

  private destroyed = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private closeStreamFn: (() => void) | null = null;

  constructor(
    private readFn: (kick: boolean) => Observable<T>,
    private streamUrlFn: (() => string) | null,
    private isThinking: (s: T) => boolean,
    destroyRef: DestroyRef,
    private opts: GenerationStreamOptions<T> = {},
  ) {
    this.thinking = computed(() => {
      const s = this.state();
      return s !== null && this.isThinking(s);
    });
    destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.clearPoll();
      this.closeStream();
    });
  }

  /** Initial load and public re-entry (PlanPanel's parent calls this after every answer):
   *  read WITHOUT kicking generation, adopt the state, and keep driving if it's owed. */
  refresh(): void {
    if (this.destroyed) return;
    this.clearPoll();
    this.readFn(false).subscribe({
      next: (s) => {
        this.state.set(s);
        this.opts.onState?.(s, 'load');
        if ((this.opts.needsStreamOnLoad ?? this.isThinking)(s)) this.drive();
      },
      error: () => this.opts.onLoadError?.(),
    });
  }

  /** Adopt a state returned by a mutation (answer / instruct / escalate / restore).
   *  `drive=true` continues generation — SSE with poll fallback, or poll-only. The
   *  caller decides (the predicates differ per action, e.g. Prototype's pending edits). */
  ingest(s: T, drive = false): void {
    this.state.set(s);
    if (drive && !this.destroyed) this.drive();
  }

  private drive(): void {
    if (this.streamUrlFn) this.openStream();
    else this.schedulePoll();
  }

  /** Drive generation over SSE; the single terminal `state` event carries the finished
   *  state. Any error — or a payload that fails isValidEvent — falls back to polling. */
  private openStream(): void {
    this.closeStream();
    if (this.destroyed) return;
    this._streaming.set(true);
    this.closeStreamFn = openEventSource<T>(
      this.streamUrlFn!(),
      (s) => {
        this.closeStream();
        if ((this.opts.isValidEvent ?? (() => true))(s)) {
          this.state.set(s);
          this.opts.onState?.(s, 'sse');
          if (this.opts.needsStreamAfterEvent?.(s)) this.openStream();
        } else {
          this.poll(); // empty/garbled state → recover via the poll fallback
        }
      },
      () => {
        this.closeStream();
        this.poll(); // network/SSE hiccup → fall back to polling (which kicks generation)
      },
    );
  }

  private closeStream(): void {
    if (this.closeStreamFn) {
      this.closeStreamFn();
      this.closeStreamFn = null;
    }
    this._streaming.set(false);
  }

  /** SSE fallback / poll-only loop: read WITH the generation kick, re-poll every
   *  1500 ms while the server is thinking. Exactly one pending tick at a time. */
  private poll(): void {
    if (this.destroyed) return;
    this.readFn(true).subscribe({
      next: (s) => {
        this.state.set(s);
        this.opts.onState?.(s, 'poll');
        if (this.isThinking(s)) this.schedulePoll();
      },
      error: () => this.opts.onPollError?.(),
    });
  }

  private schedulePoll(): void {
    this.clearPoll();
    if (this.destroyed) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.poll();
    }, POLL_MS);
  }

  private clearPoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

/** One-shot SSE lifecycle — absorbed from @sf/shared's `streamState()` (intake was its
 *  only consumer; Task 5 of the 2026-07-15 plan deletes the shared original). Opens an
 *  EventSource to `url`; the server drives a slow generation and emits a single terminal
 *  `state` event, whose JSON payload is handed to `onState`. Any connection error (or a
 *  payload that won't parse) calls `onError`. Returns a close fn — GenerationStream
 *  invokes it in closeStream() so the `streaming` signal stays in sync. */
function openEventSource<T>(
  url: string,
  onState: (data: T) => void,
  onError: () => void,
): () => void {
  const es = new EventSource(url);
  es.addEventListener('state', (e) => {
    let data: T;
    try {
      data = JSON.parse((e as MessageEvent).data) as T;
    } catch {
      onError();
      return;
    }
    onState(data);
  });
  es.onerror = onError;
  return () => es.close();
}
```

Note: the class duplicates `streamState`'s body until Task 5 deletes the shared original — intentional, so Tasks 2–4 stay independently green.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ng test intake`
Expected: PASS — all `GenerationStream` tests green, all pre-existing intake specs untouched and green.

- [ ] **Step 5: Lint and commit**

```bash
npx ng lint intake
git add apps/intake/src/app/submitter/generation-stream.ts apps/intake/src/app/submitter/generation-stream.spec.ts
git commit -m "feat(intake): add GenerationStream — one deep module for the thinking-poll + SSE loop

Deepening candidate 3 (D13-D15): plain class, one instance per wizard step,
signals {state, thinking, streaming}; owns the 1500ms poll, SSE-with-fallback,
and DestroyRef teardown. Pure unit tests, no TestBed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Migrate Interview to GenerationStream

**Files:**
- Modify: `apps/intake/src/app/submitter/interview.ts` (class body only; the template does not change — `st()` / `streaming` keep their names via aliases)
- Modify: `apps/intake/src/app/submitter/interview.spec.ts` (add one wiring assertion)

**Interfaces:**
- Consumes from Task 1: `GenerationStream<InterviewState>` — `refresh()`, `ingest(s, drive)`, `state`, `thinking()`, `streaming`.
- Produces: nothing new; `Interview`'s public surface (`st`, `streaming`, `working`, all handlers) is unchanged.

Zero behavioral change: initial read is `api.interview(id, false)`; a thinking state opens `api.interviewStreamUrl(id)`; SSE payloads are valid iff `typeof s.asked === 'number'`; SSE error/invalid → 1500 ms poll with `gen=1`; `answer`/`reopen` responses drive iff `s.thinking`; escalation responses never drive; load/SSE states clear `busy` and scroll the thread; poll ticks are silent; poll errors clear `busy`.

- [ ] **Step 1: Add the wiring assertion to the spec (it passes before AND after — it pins the contract)**

In `apps/intake/src/app/submitter/interview.spec.ts`, add inside the existing `describe` block (after the `pulses the context Track chip…` test):

```ts
it('wires the stream: the initial read does not kick generation (gen=false)', () => {
  render();
  expect(api.interview).toHaveBeenCalledWith(71, false);
});
```

Run: `npx ng test intake` — Expected: PASS (the current code already reads with `false`; this test guards the migration).

- [ ] **Step 2: Swap the loop plumbing for a GenerationStream field**

In `apps/intake/src/app/submitter/interview.ts`:

**(a)** Change the `@sf/shared` import — remove `streamState`:

```ts
import { Api, Icon, InterviewState, Mark, RequestDetail, TrackChip } from '@sf/shared';
```

and add below the other local imports:

```ts
import { GenerationStream } from './generation-stream';
```

**(b)** Replace the state/loop fields. Delete these lines:

```ts
  st = signal<InterviewState | null>(null);
```

```ts
  /** the question text streaming in token-by-token (empty when not streaming) */
  streaming = signal(false);
```

```ts
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private closeStreamFn: (() => void) | null = null;
```

and insert (directly above the `req = signal<RequestDetail | null>(null);` line, so `st` exists before every use):

```ts
  /** the generation loop: 1500 ms thinking-poll + SSE-with-fallback (GenerationStream) */
  private gen = new GenerationStream<InterviewState>(
    (kick) => this.api.interview(this.id, kick),
    () => this.api.interviewStreamUrl(this.id),
    (s) => s.thinking,
    inject(DestroyRef),
    {
      isValidEvent: (s) => !!s && typeof s.asked === 'number',
      onState: (_s, source) => {
        if (source === 'poll') return; // poll ticks update silently, as before
        this.busy.set(false);
        this.scrollToEnd();
      },
      onLoadError: () => this.busy.set(false),
      onPollError: () => this.busy.set(false), // give up quietly; the read stays retryable
    },
  );
  /** the interview state — the stream's writable state signal */
  st = this.gen.state;
  /** the question is streaming in over SSE */
  streaming = this.gen.streaming;
```

NOTE on field order: `api` and `id` are referenced only inside closures (evaluated at call time), so the existing declaration order (`api`, `draft`, `id`, `router` first) is fine; `inject(DestroyRef)` in a field initializer is a valid injection context. `busy` stays a component signal — declare `gen` AFTER `busy` OR leave `busy` where it is; closures don't care. What matters: `st = this.gen.state` must come after `gen`.

**(c)** Simplify `working` (same semantics — `gen.thinking()` ≡ `!!this.st()?.thinking`):

```ts
  working = computed(() => this.busy() || this.gen.thinking() || this.streaming());
```

**(d)** Shrink the constructor's teardown (the stream cleans itself up):

```ts
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true; // guards the auto-advance effect below
    });
```

(`destroyed` stays — the finish-effect checks it before navigating.)

**(e)** Replace `this.load(true);` in `ngOnInit` with:

```ts
    this.gen.refresh();
```

**(f)** DELETE these five private members entirely: `load()`, `openStream()`, `closeStream()`, `poll()`, `scheduleNextPoll()`.

**(g)** In `push()`, replace

```ts
        this.st.set(s);
```

with

```ts
        this.gen.ingest(s, s.thinking); // adopt; stream the next question in as it generates
```

and DELETE the later line `if (s.thinking) this.openStream(); // stream the next question in as it generates`.

**(h)** In `reopen()`, replace `this.st.set(s);` with `this.gen.ingest(s, s.thinking); // stream the follow-up (or resolve to done → advance)` and DELETE the line `if (s.thinking) this.openStream(); // stream the follow-up (or resolve to done → advance)`.

**(i)** In `acceptEscalation()`, replace `this.st.set(s);` with `this.gen.ingest(s);`. In `declineEscalation()`, replace `.subscribe((s) => this.st.set(s));` with `.subscribe((s) => this.gen.ingest(s));`.

Everything else (template, effects, `turns`, `escalation`, `liveQuestion`, `facts`, keyboard handling) is untouched — they read `this.st()` which is now the stream's signal.

- [ ] **Step 3: Run tests and build**

Run: `npx ng test intake && npx ng build intake && npx ng lint intake`
Expected: PASS ×3. All 4 escalation tests + the new wiring test green (the spec's `comp.st.set(...)` still works — `state` is a `WritableSignal`).

- [ ] **Step 4: Commit**

```bash
git add apps/intake/src/app/submitter/interview.ts apps/intake/src/app/submitter/interview.spec.ts
git commit -m "refactor(intake): drive the interview step through GenerationStream

Zero behavioral change: same gen=false initial read, same SSE validation
(typeof asked === 'number'), same 1500ms kicked-poll fallback, same
busy/scroll side effects. ~60 lines of loop plumbing deleted.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Migrate Prototype to GenerationStream

**Files:**
- Modify: `apps/intake/src/app/submitter/prototype.ts` (class body only; template unchanged)

**Interfaces:**
- Consumes from Task 1: `GenerationStream<PrototypeState>` — same surface as Task 2.
- Produces: nothing new; `Prototype`'s public surface is unchanged.

Zero behavioral change: initial read `api.prototype(id, false)`; drive-on-load iff `status !== 'skipped' && (!html || thinking || hasPending)`; SSE payloads valid iff `typeof s.status === 'string'`; after a terminal event, re-stream iff a turn is still `pending`; `send` responses drive iff `s.thinking || hasPending(s)`; `undo` never drives; every adopted state scrolls the thread.

- [ ] **Step 1: Swap the loop plumbing**

In `apps/intake/src/app/submitter/prototype.ts`:

**(a)** Remove `streamState` from the `@sf/shared` import list and add:

```ts
import { GenerationStream } from './generation-stream';
```

**(b)** Delete the fields `st = signal<PrototypeState | null>(null);`, `streaming = signal(false);`, `private closeStreamFn: (() => void) | null = null;`, `private destroyed = false;`, `private pollTimer: ReturnType<typeof setTimeout> | null = null;` and insert in their place:

```ts
  /** the generation loop: 1500 ms thinking-poll + SSE-with-fallback (GenerationStream) */
  private gen = new GenerationStream<PrototypeState>(
    (kick) => this.api.prototype(this.id, kick),
    () => this.api.prototypeStreamUrl(this.id),
    (s) => s.thinking,
    inject(DestroyRef),
    {
      isValidEvent: (s) => !!s && typeof s.status === 'string',
      // drive on load when a first draft is owed or a revision is in flight
      needsStreamOnLoad: (s) =>
        s.status !== 'skipped' && (!s.html || s.thinking || this.hasPending(s)),
      needsStreamAfterEvent: (s) => this.hasPending(s), // a queued edit is still owed
      onState: () => this.scrollToEnd(),
    },
  );
  /** the prototype state — the stream's writable state signal */
  st = this.gen.state;
  /** a revision is streaming in over SSE */
  streaming = this.gen.streaming;
```

**(c)** `working` becomes:

```ts
  working = computed(() => this.streaming() || this.gen.thinking());
```

**(d)** Shrink the constructor (only the message listener remains):

```ts
  constructor() {
    inject(DestroyRef).onDestroy(() => window.removeEventListener('message', this.onMsg));
    window.addEventListener('message', this.onMsg);
  }
```

**(e)** `ngOnInit` becomes:

```ts
  ngOnInit() {
    this.gen.refresh();
  }
```

**(f)** DELETE the private members `load()`, `openStream()`, `poll()`, `closeStream()` entirely. KEEP `hasPending()` (the stream's predicates call it).

**(g)** In `send()`, replace

```ts
      this.st.set(s);
```

with

```ts
      this.gen.ingest(s, s.thinking || this.hasPending(s)); // stream the revision (async brain)
```

and DELETE the line `if (s.thinking || this.hasPending(s)) this.openStream(); // stream the revision (async brain)`.

**(h)** In `undo()`, replace `this.st.set(s);` with `this.gen.ingest(s);`.

`srcdoc` (`linkedSignal` sourced from `this.st()?.html`), point-to-edit, fullscreen, and all template bindings are untouched.

- [ ] **Step 2: Run tests and build**

Run: `npx ng test intake && npx ng build intake && npx ng lint intake`
Expected: PASS ×3. (Prototype has no spec file — the build catches template/type breaks; the loop behavior is pinned by `generation-stream.spec.ts`, including the re-stream-while-pending case.)

- [ ] **Step 3: Manual smoke of the step (zero-change proof)**

Run the intake app via the preview-managed server (`task intake` config in `.claude/launch.json` / `preview_start`), create a new-app request, and confirm on the Prototype step: the first draft streams in (typing row shows "designing…"), an edit instruction produces a revision, Undo restores. This is the one migrated surface with no component spec — eyeball it.

- [ ] **Step 4: Commit**

```bash
git add apps/intake/src/app/submitter/prototype.ts
git commit -m "refactor(intake): drive the prototype step through GenerationStream

Zero behavioral change: same drive-on-load predicate (skipped/html/pending),
same SSE validation (typeof status === 'string'), same re-stream while an
edit is pending, same scroll-on-every-state.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Migrate Review + PlanPanel (the poll-only pair)

**Files:**
- Modify: `apps/intake/src/app/submitter/review.ts`
- Modify: `apps/intake/src/app/submitter/plan-panel.ts`
- Modify: `apps/intake/src/app/submitter/review.spec.ts` (add one wiring assertion)

**Interfaces:**
- Consumes from Task 1: `GenerationStream<ReviewSummary>` with `streamUrlFn = null` (poll-only mode) — `refresh()`, `state`, `thinking`.
- Produces: `PlanPanel.refresh()` keeps its exact public signature — `Interview` calls it from 5 sites (`planPanel()?.refresh()`), unchanged.

Zero behavioral change: both read `api.summary(id)` and re-poll every 1500 ms while `thinking`; no SSE (there is no summary stream endpoint); errors are silent; PlanPanel's `refresh()` stays public and re-entrant.

- [ ] **Step 1: Migrate Review**

In `apps/intake/src/app/submitter/review.ts`:

**(a)** Add the import:

```ts
import { GenerationStream } from './generation-stream';
```

**(b)** Replace the fields `summary = signal<ReviewSummary | null>(null);`, `private destroyed = false;`, `private pollTimer: ReturnType<typeof setTimeout> | null = null;` with:

```ts
  /** the AI-written spec: poll-only — the summary has no SSE endpoint */
  private gen = new GenerationStream<ReviewSummary>(
    () => this.api.summary(this.id),
    null,
    (s) => s.thinking,
    inject(DestroyRef),
  );
  summary = this.gen.state;
```

(Place the block AFTER the `id = Number(...)` field so nothing reads before declaration; the closure itself is lazy either way.)

**(c)** DELETE the constructor entirely (it only registered the timer teardown) and DELETE the `loadSummary()` method. In `ngOnInit`, replace `this.loadSummary();` with `this.gen.refresh();`. Keep `DestroyRef` in the `@angular/core` import (the field uses it); remove `signal` from that import ONLY if nothing else uses it (`req`, `protoDoc`, `fullscreen`, `submitting` still do — so keep it).

- [ ] **Step 2: Migrate PlanPanel**

In `apps/intake/src/app/submitter/plan-panel.ts`:

**(a)** Add the import:

```ts
import { GenerationStream } from './generation-stream';
```

**(b)** Replace the fields `plan = signal<ReviewSummary | null>(null);`, `thinking = computed(() => !!this.plan()?.thinking);`, `private timer: ReturnType<typeof setTimeout> | null = null;`, `private destroyed = false;` with:

```ts
  /** the live plan: poll-only — the summary has no SSE endpoint */
  private gen = new GenerationStream<ReviewSummary>(
    () => this.api.summary(this.id()),
    null,
    (s) => s.thinking,
    inject(DestroyRef),
  );
  plan = this.gen.state;
  thinking = this.gen.thinking;
```

**(c)** DELETE the constructor entirely and replace the whole `refresh()` method with:

```ts
  /** fetch the summary; while the brain is writing, re-poll every ~1.5s.
   *  Public — the Interview parent calls this after anything that changes the spec. */
  refresh() {
    this.gen.refresh();
  }
```

**(d)** Update the `@angular/core` import to drop now-unused symbols. After the change the component uses `Component`, `DestroyRef`, `computed` (for `sections`), `inject`, `input`, `OnInit` — `signal` is no longer used:

```ts
import { Component, DestroyRef, computed, inject, input, OnInit } from '@angular/core';
```

`ngOnInit() { this.refresh(); }` and the `sections` computed stay as-is.

- [ ] **Step 3: Add the wiring assertion to review.spec.ts**

In `apps/intake/src/app/submitter/review.spec.ts`, add inside the existing `describe`:

```ts
it('wires the summary poll: one read on init, none after (summary not thinking)', () => {
  const { api } = setup(detail({ type: 'bug' }));
  expect(api.summary).toHaveBeenCalledOnce();
});
```

- [ ] **Step 4: Run tests and build**

Run: `npx ng test intake && npx ng build intake && npx ng lint intake`
Expected: PASS ×3 (both Review layout tests + the new wiring test green; PlanPanel compiles into Interview's build).

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/review.ts apps/intake/src/app/submitter/plan-panel.ts apps/intake/src/app/submitter/review.spec.ts
git commit -m "refactor(intake): drive Review + PlanPanel polling through GenerationStream

The poll-only pair: streamUrlFn=null skips SSE entirely, keeping the same
1500ms summary re-poll while thinking. PlanPanel.refresh() keeps its public
signature for the Interview parent's five call sites.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Absorb streamState — delete the shared original, full verify

**Files:**
- Modify: `packages/shared/src/lib/util.ts` (delete `streamState` + its doc comment, currently lines ~250–274)
- Modify: `packages/shared/src/lib/util.spec.ts` (delete the whole `describe('streamState', …)` block, currently lines ~661–743, including the `FakeES` class inside it)

**Interfaces:**
- Consumes: Tasks 2–3 must be complete (they removed the last `streamState` imports).
- Produces: `@sf/shared`'s public surface shrinks by one export (`export * from './lib/util'` stays; the symbol just disappears). This touches `packages/shared`, so the shared gate applies: prove intake AND console still build.

- [ ] **Step 1: Re-verify there are no remaining consumers (D14's grep, at implementation time)**

Run: `grep -rn "streamState" apps packages --include="*.ts" | grep -v node_modules`
Expected: exactly two files — `packages/shared/src/lib/util.ts` (the definition) and `packages/shared/src/lib/util.spec.ts` (its tests). If ANYTHING else matches (e.g. a console import added since 2026-07-15), STOP: leave the shared util in place, change `generation-stream.ts` to `import { streamState } from '@sf/shared'` (deleting the private `openEventSource` copy and calling `streamState` in `openStream()`), skip the deletions below, and log the deviation.

- [ ] **Step 2: Delete the function and its tests**

In `packages/shared/src/lib/util.ts`, delete the `streamState` function and its full doc comment (the block starting `/** One-shot SSE lifecycle for the intake wizard's interview + prototype streams. …` through the closing `}` of `streamState`). In `packages/shared/src/lib/util.spec.ts`, delete the entire `describe('streamState', () => { … });` block and remove `streamState,` from the import list at the top of the file.

- [ ] **Step 3: Shared + both apps green**

Run: `npx ng test shared && npx ng test intake && npx ng test console && npx ng build intake && npx ng build console && npx ng lint shared`
Expected: PASS ×6 (console never imported the symbol, so its build proves the wildcard re-export is safe).

- [ ] **Step 4: Full verify (the merge gate)**

Run: `task verify`
Expected: `✓ VERIFY PASSED — tests, build, and smoke all green`. Fix anything red before proceeding; show the output at the merge decision (user rule: verify before merging, and the shared gate means a `packages/shared` touch must prove intake end-to-end).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/lib/util.ts packages/shared/src/lib/util.spec.ts
git commit -m "refactor(shared): absorb streamState into intake's GenerationStream

Intake was its only consumer (grep-verified); the one-shot SSE helper now
lives privately inside apps/intake/.../generation-stream.ts (D14). Shrinks
the @sf/shared protected surface by one export.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Do NOT push. Merging to local main is a separate decision after the user sees the `task verify` output.

---

## Self-Review (performed against the spec)

1. **Spec coverage:** D13 (location in apps/intake, not shared) → Task 1. D14 (plain class, ctor shape, signals, 1500 ms poll, SSE-with-fallback, teardown, streamState absorption with the grep guard) → Tasks 1 + 5; the optional fifth `opts` arg is a documented deviation with its rationale in the header. D15 (pure tests, fake timers, stubbed EventSource, no TestBed; component specs shrink to wiring) → Task 1 spec file + wiring assertions in Tasks 2/4; prototype/plan-panel have no specs today, so "shrink" = don't add TestBed loop tests (stated explicitly). Zero-behavioral-change-per-task → the per-component parameter table and per-task green gates.
2. **Placeholder scan:** no TBDs; every code step shows complete code; commands carry expected output.
3. **Type consistency:** `refresh()`/`ingest(s, drive)`/`state: WritableSignal<T | null>`/`thinking`/`streaming` are used with the same names and signatures in Tasks 1–4; `GenerationStreamOptions` keys (`isValidEvent`, `needsStreamOnLoad`, `needsStreamAfterEvent`, `onState`, `onLoadError`, `onPollError`) match between the class, its spec, and all three migration tasks; `openEventSource` is module-private and only referenced inside Task 1's file.
