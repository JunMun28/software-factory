import { afterEach, describe, expect, it, vi } from 'vitest';

import { Theme } from './theme.service';

// The Angular unit-test runner uses Node.js 25 — no DOM, and a stub localStorage
// without the standard Web Storage methods. Theme also reaches for matchMedia and
// document, so stub all three hermetically and restore them after each test.
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
    clear: () => Object.keys(store).forEach((k) => delete store[k]),
  };
}

/** Stub the environment Theme reads from. Returns the mocks so tests can assert
 *  what Theme wrote (localStorage + the <html data-theme> dataset). */
function stubEnv(opts: { stored?: string | null; systemDark?: boolean } = {}) {
  const ls = makeLocalStorageMock();
  if (opts.stored != null) ls.setItem('sf-theme', opts.stored);
  const doc = { documentElement: { dataset: {} as Record<string, string> } };
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('matchMedia', () => ({ matches: !!opts.systemDark, addEventListener: vi.fn() }));
  vi.stubGlobal('document', doc);
  return { ls, doc };
}

describe('Theme', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to system when nothing is stored', () => {
    stubEnv();
    expect(new Theme().choice()).toBe('system');
  });

  it('reads a valid stored choice', () => {
    stubEnv({ stored: 'dark' });
    expect(new Theme().choice()).toBe('dark');
  });

  it('falls back to system on a junk stored value', () => {
    stubEnv({ stored: 'banana' });
    expect(new Theme().choice()).toBe('system');
  });

  it('resolved(): an explicit choice ignores the system preference', () => {
    stubEnv({ stored: 'dark', systemDark: false });
    expect(new Theme().resolved()).toBe('dark');
    stubEnv({ stored: 'light', systemDark: true });
    expect(new Theme().resolved()).toBe('light');
  });

  it('resolved(): system follows prefers-color-scheme', () => {
    stubEnv({ stored: 'system', systemDark: true });
    expect(new Theme().resolved()).toBe('dark');
    stubEnv({ stored: 'system', systemDark: false });
    expect(new Theme().resolved()).toBe('light');
  });

  it('writes the resolved theme to <html data-theme> on construction', () => {
    const { doc } = stubEnv({ stored: 'dark' });
    const t = new Theme();
    expect(t.resolved()).toBe('dark');
    expect(doc.documentElement.dataset['theme']).toBe('dark');
  });

  it('set() updates the signal, persists, and re-applies', () => {
    const { ls, doc } = stubEnv({ systemDark: true });
    const t = new Theme();
    t.set('light');
    expect(t.choice()).toBe('light');
    expect(ls.getItem('sf-theme')).toBe('light');
    expect(doc.documentElement.dataset['theme']).toBe('light');
  });

  it('keeps working when localStorage write throws (private mode)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('write denied');
      },
    });
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn() }));
    vi.stubGlobal('document', { documentElement: { dataset: {} } });
    const t = new Theme();
    expect(() => t.set('dark')).not.toThrow();
    expect(t.choice()).toBe('dark');
  });
});
