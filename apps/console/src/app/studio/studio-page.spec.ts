import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Api, Poll, Theme } from '@sf/shared';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Session } from '../core/session.service';
import { StudioPage } from './studio-page';

describe('Studio notification preferences', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders per-app toggles and the honest log-only transport note', async () => {
    const operator = {
      id: 7,
      name: 'Avery Stone',
      initials: 'AS',
      hue: '#0F766E',
      email: 'avery@example.com',
      created_at: '2026-07-13T00:00:00Z',
    };
    const updateSubscription = vi.fn(() =>
      of({ app_id: 2, key: 'vendor', name: 'Vendor Portal', subscribed: false }),
    );
    const operatorSubscriptions = vi.fn(() =>
      of([
        { app_id: 1, key: 'northwind', name: 'Northwind Expenses', subscribed: true },
        { app_id: 2, key: 'vendor', name: 'Vendor Portal', subscribed: true },
      ]),
    );
    const api = {
      operators: () => of([operator]),
      health: () =>
        of({
          status: 'ok',
          brain: 'scripted',
          runner: 'sim',
          cli: 'codex',
          smtp: 'log-only',
        }),
      operatorSubscriptions,
      updateOperatorSubscription: updateSubscription,
      tick: () => of({ moved: [] }),
    };
    const pollVersion = signal(0);
    await TestBed.configureTestingModule({
      imports: [StudioPage],
      providers: [
        provideRouter([]),
        { provide: Api, useValue: api },
        {
          provide: Poll,
          useValue: { start: () => undefined, nudge: () => undefined, version: pollVersion },
        },
        {
          provide: Theme,
          useValue: { resolved: signal<'light' | 'dark'>('light'), set: () => undefined },
        },
        {
          provide: Session,
          useValue: {
            operator: signal(operator),
            operatorId: signal(operator.id),
            select: vi.fn(),
          },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(StudioPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('.notifications')?.textContent).toContain('Northwind Expenses');
    expect(host.querySelector('.notifications')?.textContent).toContain('Vendor Portal');
    expect(host.querySelector('.smtp-note')?.textContent).toContain('log-only');
    const toggles = host.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    expect(toggles).toHaveLength(2);
    expect(toggles[1].getAttribute('aria-checked')).toBe('true');

    toggles[1].click();
    expect(updateSubscription).toHaveBeenCalledWith(7, 2, false);

    pollVersion.set(1);
    fixture.detectChanges();
    expect(operatorSubscriptions).toHaveBeenCalledTimes(2);
  });
});
