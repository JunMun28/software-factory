import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN, Session } from './session.service';

// The Angular unit-test runner uses Node.js with a stub localStorage that has no
// standard Web Storage API methods (setItem/getItem/removeItem/clear). Replace it
// with a minimal in-memory implementation for the duration of these tests.
function makeLocalStorageMock() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
  };
}

describe('console Session', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorageMock());
  });

  it('defaults to the ADMIN user so the admin guard passes', () => {
    expect(new Session().user()).toEqual(ADMIN);
  });

  it('round-trips a signed-in user through localStorage', () => {
    new Session().signIn('admin');
    expect(new Session().user().role).toBe('admin');
  });

  it('round-trips the full admin user object', () => {
    new Session().signIn('admin');
    expect(new Session().user()).toEqual(ADMIN);
  });

  it('falls back to ADMIN on malformed JSON', () => {
    localStorage.setItem('sf-console-user', '{not json');
    expect(new Session().user()).toEqual(ADMIN);
  });

  it('discards a wrong-shape blob and removes it from localStorage', () => {
    localStorage.setItem('sf-console-user', JSON.stringify({ name: 'X' }));
    expect(new Session().user()).toEqual(ADMIN);
    expect(localStorage.getItem('sf-console-user')).toBeNull();
  });

  it('rejects an unknown role and removes the blob', () => {
    localStorage.setItem('sf-console-user', JSON.stringify({ ...ADMIN, role: 'root' }));
    expect(new Session().user()).toEqual(ADMIN);
    expect(localStorage.getItem('sf-console-user')).toBeNull();
  });

  it('returns ADMIN when localStorage is empty', () => {
    expect(new Session().user()).toEqual(ADMIN);
  });
});
