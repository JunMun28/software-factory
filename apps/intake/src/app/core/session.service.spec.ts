import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN, SUBMITTER, Session, userFromAccount } from './session.service';

// The Angular unit-test runner uses Node.js 25 with a stub localStorage that
// has no standard Web Storage API methods (setItem/getItem/removeItem/clear).
// Replace it with a minimal in-memory implementation for the duration of these tests.
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

describe('Session', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorageMock());
  });

  it('round-trips a signed-in user through localStorage', () => {
    new Session().signIn('admin');
    expect(new Session().user().role).toBe('admin');
  });

  it('round-trips the full admin user object', () => {
    new Session().signIn('admin');
    expect(new Session().user()).toEqual(ADMIN);
  });

  it('falls back to SUBMITTER on malformed JSON', () => {
    localStorage.setItem('sf-user', '{not json');
    expect(new Session().user()).toEqual(SUBMITTER);
  });

  it('discards a wrong-shape blob and removes it from localStorage', () => {
    localStorage.setItem('sf-user', JSON.stringify({ name: 'X' }));
    expect(new Session().user()).toEqual(SUBMITTER);
    expect(localStorage.getItem('sf-user')).toBeNull();
  });

  it('rejects an unknown role and removes the blob', () => {
    localStorage.setItem('sf-user', JSON.stringify({ ...ADMIN, role: 'root' }));
    expect(new Session().user()).toEqual(SUBMITTER);
    expect(localStorage.getItem('sf-user')).toBeNull();
  });

  it('returns SUBMITTER when localStorage is empty', () => {
    expect(new Session().user()).toEqual(SUBMITTER);
  });

  it('signIn("submitter") persists SUBMITTER and updates the signal', () => {
    const s = new Session();
    s.signIn('submitter');
    expect(s.user()).toEqual(SUBMITTER);
    expect(JSON.parse(localStorage.getItem('sf-user')!)).toEqual(SUBMITTER);
  });
});

describe('userFromAccount (SEC-01 Entra mapping)', () => {
  it('maps name, initials, email, and the admin role', () => {
    const u = userFromAccount('Dana M. Reyes', 'someone@example.com', ['admin']);
    expect(u.name).toBe('Dana M. Reyes');
    expect(u.initials).toBe('DMR');
    expect(u.email).toBe('someone@example.com');
    expect(u.role).toBe('admin');
  });

  it('everyone without the admin role is a submitter here', () => {
    expect(userFromAccount('A Person', 'a@example.com', ['submitter']).role).toBe('submitter');
    expect(userFromAccount('A Person', 'a@example.com', []).role).toBe('submitter');
  });

  it('falls back to the email localpart when the account has no name', () => {
    const u = userFromAccount('', 'jordan.diaz@example.com', []);
    expect(u.name).toBe('jordan.diaz');
    expect(u.initials).toBe('J');
  });
});
