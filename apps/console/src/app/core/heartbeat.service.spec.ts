import { TestBed } from '@angular/core/testing';
import { Api, type Health } from '@sf/shared';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Heartbeat } from './heartbeat.service';

const health = (tickAge: number | null): Health => ({
  status: 'ok' as const,
  db: 'ok' as const,
  brain: 'scripted',
  runner: 'sim',
  cli: 'opencode',
  smtp: 'log-only',
  leader: true,
  epoch: 7,
  tick_age_s: tickAge,
  deploy_enabled: false,
});

describe('Heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('checks health immediately and then every 10 seconds', () => {
    const api = { health: vi.fn(() => of(health(4))) };
    TestBed.configureTestingModule({
      providers: [Heartbeat, { provide: Api, useValue: api }],
    });
    const heartbeat = TestBed.inject(Heartbeat);

    heartbeat.start();

    expect(api.health).toHaveBeenCalledOnce();
    expect(heartbeat.state()).toBe('healthy');
    vi.advanceTimersByTime(9_999);
    expect(api.health).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(api.health).toHaveBeenCalledTimes(2);
  });

  it('treats a failed health check as stalled and recovers on the next successful poll', () => {
    const api = {
      health: vi
        .fn()
        .mockReturnValueOnce(throwError(() => new Error('offline')))
        .mockReturnValueOnce(of(health(null))),
    };
    TestBed.configureTestingModule({
      providers: [Heartbeat, { provide: Api, useValue: api }],
    });
    const heartbeat = TestBed.inject(Heartbeat);

    heartbeat.start();
    expect(heartbeat.state()).toBe('stalled');
    expect(heartbeat.fetchFailed()).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(heartbeat.state()).toBe('unknown');
    expect(heartbeat.fetchFailed()).toBe(false);
  });
});
