import { TestBed } from '@angular/core/testing';
import { Api, Operator } from '@sf/shared';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Session } from './session.service';

const operators: Operator[] = [
  {
    id: 7,
    name: 'Avery Stone',
    initials: 'AS',
    hue: '#0F766E',
    email: 'avery@example.com',
    created_at: '2026-07-11T00:00:00Z',
  },
];

function storage(initial: Record<string, string> = {}) {
  const values = { ...initial };
  return {
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => (values[key] = value),
    removeItem: (key: string) => delete values[key],
  };
}

describe('console Session', () => {
  beforeEach(() => vi.stubGlobal('localStorage', storage()));

  it('starts empty and resolves only a stored server-row pointer', () => {
    localStorage.setItem('sf-console-operator-id', '7');
    TestBed.configureTestingModule({
      providers: [{ provide: Api, useValue: { operators: () => of(operators) } }],
    });
    const session = TestBed.inject(Session);
    expect(session.operator()).toEqual(operators[0]);
    expect(localStorage.getItem('sf-console-operator-id')).toBe('7');
  });

  it('clears an invalid pointer instead of inventing a mock identity', () => {
    localStorage.setItem('sf-console-operator-id', '99');
    TestBed.configureTestingModule({
      providers: [{ provide: Api, useValue: { operators: () => of(operators) } }],
    });
    const session = TestBed.inject(Session);
    expect(session.operator()).toBeNull();
    expect(localStorage.getItem('sf-console-operator-id')).toBeNull();
  });

  it('persists only the selected operator id', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: Api, useValue: { operators: () => of(operators) } }],
    });
    const session = TestBed.inject(Session);
    session.select(operators[0]);
    expect(localStorage.getItem('sf-console-operator-id')).toBe('7');
    expect(localStorage.getItem('sf-console-user')).toBeNull();
  });
});
