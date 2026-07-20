import { DestroyRef } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    return () => undefined;
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
  let read: Mock<(kick: boolean) => Observable<S>>;

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

  it('appends named delta chunks verbatim until the terminal state discards them', () => {
    read.mockReturnValue(of(busy));
    const gen = make(() => '/s');
    gen.refresh();

    es().emit('delta', JSON.stringify({ text: 'What ' }));
    es().emit('delta', JSON.stringify({ text: 'matters most?\n' }));

    expect(gen.deltaText()).toBe('What matters most?\n');
    expect(gen.state()).toEqual(busy);
    expect(gen.streaming()).toBe(true);

    es().emit('state', JSON.stringify({ thinking: false, tag: 'done' }));

    expect(gen.deltaText()).toBe('');
    expect(gen.state()!.tag).toBe('done');
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
    es().emit('delta', JSON.stringify({ text: 'Partial answer' }));
    es().onerror!(); // → poll: read #2 (true), still thinking → schedule
    expect(gen.streaming()).toBe(false);
    expect(gen.deltaText()).toBe('');
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

  it('a garbled (unparseable) SSE payload falls back to the poll loop', () => {
    // ported from the deleted streamState spec: JSON.parse failure is a live
    // recovery path — the stream closes and polling takes over
    read.mockReturnValue(of(busy));
    const gen = make(() => '/s');
    gen.refresh();
    expect(FakeES.instances).toHaveLength(1);
    es().emit('state', 'not json{');
    expect(gen.streaming()).toBe(false); // stream abandoned
    vi.advanceTimersByTime(1500); // …and the poll loop is driving
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
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

  it('restarting a live stream discards its partial text', () => {
    const gen = make(() => '/s');
    gen.ingest(busy, true);
    es().emit('delta', JSON.stringify({ text: 'Old partial' }));

    gen.ingest(busy, true);

    expect(FakeES.instances).toHaveLength(2);
    expect(FakeES.instances[0].closed).toBe(true);
    expect(gen.deltaText()).toBe('');
  });

  it('destroy closes the stream, cancels the pending poll, and blocks further work', () => {
    read.mockReturnValue(of(busy));
    const gen = make(() => '/s');
    gen.refresh();
    es().emit('delta', JSON.stringify({ text: 'Unfinished' }));
    destroyRef.destroy();
    expect(es().closed).toBe(true);
    expect(gen.streaming()).toBe(false);
    expect(gen.deltaText()).toBe('');
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
