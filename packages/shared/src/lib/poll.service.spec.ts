import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Api } from './api.service';
import { Poll } from './poll.service';

function ev(id: number) {
  return { id } as any;
}

describe('Poll', () => {
  let api: { eventsCursor: ReturnType<typeof vi.fn>; events: ReturnType<typeof vi.fn> };
  let poll: Poll;

  beforeEach(() => {
    vi.useFakeTimers();
    api = {
      eventsCursor: vi.fn(() => of({ cursor: 100, revision: 7 })),
      events: vi.fn(() => of([])),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: Api, useValue: api }],
    });
    poll = TestBed.inject(Poll);
  });

  afterEach(() => {
    poll.ngOnDestroy();
    vi.useRealTimers();
  });

  it('seeds the cursor from the tail and bumps version once', () => {
    poll.start(1000);
    expect(api.eventsCursor).toHaveBeenCalledOnce();
    expect(poll.version()).toBe(1);
  });

  it('advances the cursor and publishes the delta on new events', () => {
    api.events.mockReturnValue(of([ev(101), ev(102)]));
    poll.start(1000);
    vi.advanceTimersByTime(1000);
    expect(api.events).toHaveBeenCalledWith({ after: 100 });
    expect(poll.delta()).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(api.events).toHaveBeenLastCalledWith({ after: 102 });
  });

  it('in-flight guard: a slow response suppresses the next tick', () => {
    const slow = new Subject<any[]>();
    api.events.mockReturnValue(slow.asObservable());
    poll.start(1000);
    vi.advanceTimersByTime(3000); // 3 ticks while the first hangs
    expect(api.events).toHaveBeenCalledOnce(); // no refetch burst
    slow.next([ev(101)]);
    slow.complete();
    vi.advanceTimersByTime(1000);
    expect(api.events).toHaveBeenCalledTimes(2);
  });

  it('an errored tick keeps the cursor and retries next tick', () => {
    // First tick errors — inFlight resets but cursor stays at seeded value
    api.events.mockReturnValueOnce(throwError(() => new Error('network error')));
    poll.start(1000);
    const versionAfterSeed = poll.version();
    vi.advanceTimersByTime(1000); // error tick
    // version unchanged by the error tick — only the seed bumped it
    expect(poll.version()).toBe(versionAfterSeed);
    // Retry on the next tick should still use the seeded cursor (100)
    api.events.mockReturnValue(of([]));
    vi.advanceTimersByTime(1000); // retry tick
    expect(api.events).toHaveBeenLastCalledWith({ after: 100 });
    expect(api.events).toHaveBeenCalledTimes(2);
  });

  it('empty poll bumps lastSync but not version', () => {
    poll.start(1000);
    const versionAfterSeed = poll.version(); // 1
    const _syncBefore = poll.lastSync();
    // ensure at least 1 ms passes so lastSync will differ
    vi.advanceTimersByTime(1); // not a full tick
    const syncMid = poll.lastSync();
    vi.advanceTimersByTime(1000); // full tick with empty response
    // version stays at 1 (seed bump only)
    expect(poll.version()).toBe(versionAfterSeed);
    // lastSync advances after the empty-response tick
    expect(poll.lastSync()).toBeGreaterThanOrEqual(syncMid);
  });

  it('bumps version when revision changes with zero new events', () => {
    api.eventsCursor
      .mockReturnValueOnce(of({ cursor: 100, revision: 7 }))
      .mockReturnValueOnce(of({ cursor: 100, revision: 8 }));
    poll.start(1000);
    const versionAfterSeed = poll.version();

    vi.advanceTimersByTime(1000);

    expect(api.events).toHaveBeenCalledWith({ after: 100 });
    expect(api.eventsCursor).toHaveBeenCalledTimes(2);
    expect(poll.delta()).toEqual([]);
    expect(poll.version()).toBe(versionAfterSeed + 1);
  });

  it('start() is idempotent — second call is a no-op', () => {
    poll.start(1000);
    poll.start(1000);
    expect(api.eventsCursor).toHaveBeenCalledOnce();
  });
});
