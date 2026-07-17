import { afterEach, describe, expect, it, vi } from 'vitest';

import { FactoryAuth, shouldAttachToken } from './auth.service';

/** SEC-01 contract, client side: mode=off keeps the app byte-for-byte
 *  untouched (no MSAL load, no token attach); the attach rule targets exactly
 *  the factory API minus the open discovery endpoint. The entra sign-in path
 *  itself is exercised live against the real tenant, not unit-mocked — MSAL's
 *  redirect dance is not worth faking. */

function stubConfig(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('FactoryAuth.init (off / degraded paths)', () => {
  it('mode=off resolves without loading MSAL and stays inactive', async () => {
    stubConfig({ mode: 'off' });
    const auth = new FactoryAuth();
    await auth.init('console');
    expect(auth.mode()).toBe('off');
    expect(auth.active).toBe(false);
  });

  it('an unreachable API degrades to off instead of blocking boot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('down'))),
    );
    const auth = new FactoryAuth();
    await auth.init('intake');
    expect(auth.mode()).toBe('off');
  });

  it('entra with missing ids refuses to half-configure and stays off', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubConfig({ mode: 'entra', tenantId: 't' }); // no audience, no clientIds
    const auth = new FactoryAuth();
    await auth.init('console');
    expect(auth.mode()).toBe('off');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('token() before init is an explicit error, not a hang', async () => {
    const auth = new FactoryAuth();
    await expect(auth.token()).rejects.toThrow(/before init/);
  });
});

describe('shouldAttachToken', () => {
  it('attaches only to factory API calls while active', () => {
    expect(shouldAttachToken('/api/requests', true)).toBe(true);
    expect(shouldAttachToken('/api/auth/me', true)).toBe(true);
  });

  it('never attaches to the open discovery endpoint', () => {
    expect(shouldAttachToken('/api/auth/config', true)).toBe(false);
  });

  it('never attaches while off, and never off-origin', () => {
    expect(shouldAttachToken('/api/requests', false)).toBe(false);
    expect(shouldAttachToken('https://elsewhere.example/api', true)).toBe(false);
  });
});
