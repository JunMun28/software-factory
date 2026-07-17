import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Api, Poll, Theme } from '@sf/shared';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';

import { Session } from '../core/session.service';
import { ConsoleShell } from './console-shell';

describe('ConsoleShell runner mode badge', () => {
  beforeEach(() => TestBed.resetTestingModule());

  async function renderHealth(health: {
    runner: 'agent' | 'sim';
    cli: 'claude' | 'codex';
    tick_age_s?: number | null;
  }) {
    await TestBed.configureTestingModule({
      imports: [ConsoleShell],
      providers: [
        provideRouter([]),
        {
          provide: Api,
          useValue: {
            health: () =>
              of({
                status: 'ok',
                brain: 'scripted',
                tick_age_s: null,
                deploy_enabled: false,
                ...health,
              }),
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
    return fixture.nativeElement.querySelector('.runner-badge') as HTMLElement | null;
  }

  it('labels a Claude-backed real runner', async () => {
    expect((await renderHealth({ runner: 'agent', cli: 'claude' }))?.textContent).toContain(
      'Agents: Claude Code',
    );
  });

  it('labels a Codex-backed real runner', async () => {
    expect((await renderHealth({ runner: 'agent', cli: 'codex' }))?.textContent).toContain(
      'Agents: Codex',
    );
  });

  it('turns the badge red when the tick loop has stalled', async () => {
    const badge = await renderHealth({ runner: 'sim', cli: 'codex', tick_age_s: 300 });
    expect(badge?.classList.contains('stalled')).toBe(true);
    expect(badge?.textContent).toContain('Tick stalled 5m');
  });

  it('never calls a runner=agent line stalled (it has no tick loop)', async () => {
    const badge = await renderHealth({ runner: 'agent', cli: 'claude', tick_age_s: 9999 });
    expect(badge?.classList.contains('stalled')).toBe(false);
  });

  it('labels the simulator from the runner field', async () => {
    expect((await renderHealth({ runner: 'sim', cli: 'codex' }))?.textContent).toContain(
      'Simulated',
    );
  });
});
