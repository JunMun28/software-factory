import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { Api, PrototypeState, Theme } from '@sf/shared';
import { config, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { Session } from '../core/session.service';
import { Prototype } from './prototype';

function prototypeState(html: string): PrototypeState {
  return {
    html,
    status: 'draft',
    thinking: false,
    turns: [
      {
        order: 0,
        instruction: null,
        annotation: null,
        mode: 'rewrite',
        note: 'Here is the first draft.',
        revision: true,
      },
    ],
  };
}

describe('Prototype instruction conflict recovery', () => {
  let api: any;
  let originalUnhandledError: typeof config.onUnhandledError;
  let unhandledError: Mock<(error: unknown) => void>;

  beforeEach(async () => {
    vi.useFakeTimers();
    originalUnhandledError = config.onUnhandledError;
    unhandledError = vi.fn();
    config.onUnhandledError = unhandledError;
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn() }));
    Element.prototype.scrollTo = vi.fn();
    const initial = prototypeState('<main>Initial prototype</main>');
    api = {
      prototype: vi.fn(() => of(initial)),
      prototypeStreamUrl: vi.fn(() => '/api/requests/71/prototype/stream'),
      instructPrototype: vi.fn(() => of(initial)),
      restorePrototype: vi.fn(() => of(initial)),
      skipPrototype: vi.fn(() => of(initial)),
    };
    await TestBed.configureTestingModule({
      imports: [Prototype],
      providers: [
        provideRouter([]),
        { provide: Api, useValue: api },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => '71' } } } },
        {
          provide: Session,
          useValue: {
            user: () => ({ name: 'Jordan D.', initials: 'JD', email: '', color: '#000' }),
          },
        },
        { provide: Theme, useValue: { resolved: () => 'light', set: vi.fn() } },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    config.onUnhandledError = originalUnhandledError;
    vi.unstubAllGlobals();
  });

  function render() {
    const fixture = TestBed.createComponent(Prototype);
    fixture.detectChanges();
    return { fixture, comp: fixture.componentInstance };
  }

  it('re-fetches canonical prototype state and swallows an instruction 409', () => {
    const latest = prototypeState('<main>Canonical prototype</main>');
    api.instructPrototype.mockReturnValue(
      throwError(() => new HttpErrorResponse({ status: 409, statusText: 'Conflict' })),
    );
    const { comp } = render();
    api.prototype.mockClear();
    api.prototype.mockReturnValue(of(latest));
    comp.msg.set('Make the heading blue');

    comp.send();
    vi.runAllTimers();

    expect(api.instructPrototype).toHaveBeenCalledWith(71, 'Make the heading blue', null);
    expect(api.prototype).toHaveBeenCalledExactlyOnceWith(71, false);
    expect(comp.st()).toEqual(latest);
    expect(unhandledError).not.toHaveBeenCalled();
  });

  it('keeps non-409 instruction failures unhandled and does not re-fetch', () => {
    const error = new HttpErrorResponse({ status: 503, statusText: 'Unavailable' });
    api.instructPrototype.mockReturnValue(throwError(() => error));
    const { comp } = render();
    api.prototype.mockClear();
    comp.msg.set('Make the heading blue');

    comp.send();
    vi.runAllTimers();

    expect(api.prototype).not.toHaveBeenCalled();
    expect(unhandledError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('re-fetches canonical prototype state and swallows a restore 409', () => {
    const history = prototypeState('<main>Edited prototype</main>');
    history.turns.push({
      order: 1,
      instruction: 'Edit it',
      annotation: null,
      mode: 'rewrite',
      note: 'Edited.',
      revision: true,
    });
    const latest = prototypeState('<main>Canonical prototype</main>');
    api.restorePrototype.mockReturnValue(
      throwError(() => new HttpErrorResponse({ status: 409, statusText: 'Conflict' })),
    );
    const { comp } = render();
    comp.st.set(history);
    api.prototype.mockClear();
    api.prototype.mockReturnValue(of(latest));

    comp.undo();
    vi.runAllTimers();

    expect(api.restorePrototype).toHaveBeenCalledExactlyOnceWith(71, 0);
    expect(api.prototype).toHaveBeenCalledExactlyOnceWith(71, false);
    expect(comp.st()).toEqual(latest);
    expect(unhandledError).not.toHaveBeenCalled();
  });
});
