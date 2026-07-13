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

  async function renderHealth(health: { runner: 'agent' | 'sim'; cli: 'claude' | 'codex' }) {
    await TestBed.configureTestingModule({
      imports: [ConsoleShell],
      providers: [
        provideRouter([]),
        {
          provide: Api,
          useValue: {
            health: () => of({ status: 'ok', brain: 'scripted', ...health }),
            tick: () => of({ moved: [] }),
          },
        },
        { provide: Poll, useValue: { start: () => undefined, nudge: () => undefined } },
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

  it('labels the simulator from the runner field', async () => {
    expect((await renderHealth({ runner: 'sim', cli: 'codex' }))?.textContent).toContain(
      'Simulated',
    );
  });
});
