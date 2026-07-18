import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Api, Poll, Theme, type Health } from '@sf/shared';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';

import { Session } from '../core/session.service';
import { ConsoleShell } from './console-shell';

describe('ConsoleShell factory heartbeat', () => {
  beforeEach(() => TestBed.resetTestingModule());

  async function renderHealth(overrides: Partial<Health> = {}, fetchFails = false) {
    const health: Health = {
      status: 'ok',
      db: 'ok',
      brain: 'scripted',
      runner: 'sim',
      cli: 'opencode',
      smtp: 'log-only',
      leader: true,
      epoch: 7,
      tick_age_s: 4,
      deploy_enabled: false,
      ...overrides,
    };
    await TestBed.configureTestingModule({
      imports: [ConsoleShell],
      providers: [
        provideRouter([]),
        {
          provide: Api,
          useValue: {
            health: () =>
              fetchFails ? throwError(() => new Error('health unavailable')) : of(health),
            tick: () => of({ moved: [] }),
          },
        },
        {
          provide: Poll,
          useValue: { start: () => undefined, nudge: () => undefined, version: signal(0) },
        },
        { provide: Session, useValue: { operator: signal(null) } },
        {
          provide: Theme,
          useValue: { resolved: signal<'light' | 'dark'>('light'), set: () => undefined },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(ConsoleShell);
    fixture.detectChanges();
    return fixture;
  }

  it('shows a subtle live dot with no visible text for a healthy tick', async () => {
    const fixture = await renderHealth({ tick_age_s: 8 });
    const indicator = fixture.nativeElement.querySelector(
      '.heartbeat-status',
    ) as HTMLElement | null;

    expect(indicator).not.toBeNull();
    expect(indicator!.classList.contains('healthy')).toBe(true);
    expect(indicator!.textContent?.trim()).toBe('');
    expect(indicator!.getAttribute('aria-label')).toBe('Factory line live');
    expect(indicator!.title).toContain('runner sim · cli opencode · epoch 7');
  });

  it('keeps the 15–30 second buffer neutral and quiet', async () => {
    const fixture = await renderHealth({ tick_age_s: 22 });
    const indicator = fixture.nativeElement.querySelector(
      '.heartbeat-status',
    ) as HTMLElement | null;

    expect(indicator).not.toBeNull();
    expect(indicator!.classList.contains('buffering')).toBe(true);
    expect(indicator!.classList.contains('stalled')).toBe(false);
    expect(indicator!.textContent?.trim()).toBe('');
  });

  it('warns plainly once the line has stalled', async () => {
    const fixture = await renderHealth({ runner: 'agent', tick_age_s: 42 });
    const indicator = fixture.nativeElement.querySelector(
      '.heartbeat-status',
    ) as HTMLElement | null;

    expect(indicator).not.toBeNull();
    expect(indicator!.classList.contains('stalled')).toBe(true);
    expect(indicator!.textContent).toContain('Line stalled 42s ago');
    expect(indicator!.getAttribute('aria-label')).toBe('Factory line stalled 42 seconds ago');
  });

  it('uses the same visible stalled warning when the health check fails', async () => {
    const fixture = await renderHealth({}, true);
    const indicator = fixture.nativeElement.querySelector('.heartbeat-status') as HTMLElement;

    expect(indicator.classList.contains('stalled')).toBe(true);
    expect(indicator.textContent).toContain('Line stalled — status unavailable');
    expect(indicator.getAttribute('aria-label')).toBe('Factory line stalled; status unavailable');
  });

  it('treats a null tick age as a neutral starting state', async () => {
    const fixture = await renderHealth({ tick_age_s: null });
    const indicator = fixture.nativeElement.querySelector(
      '.heartbeat-status',
    ) as HTMLElement | null;

    expect(indicator).not.toBeNull();
    expect(indicator!.classList.contains('unknown')).toBe(true);
    expect(indicator!.classList.contains('stalled')).toBe(false);
    expect(indicator!.textContent?.trim()).toBe('');
    expect(indicator!.getAttribute('aria-label')).toBe('Factory line starting');
  });

  it('replaces the old runner badge instead of rendering a second indicator', async () => {
    const fixture = await renderHealth();

    expect(fixture.nativeElement.querySelectorAll('.heartbeat-status')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.runner-badge')).toBeNull();
  });
});
