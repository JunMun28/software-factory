import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';

// The Angular unit-test runner uses a no-DOM Node environment, and the shared
// Theme service (which the shell injects) reaches for matchMedia / document /
// localStorage in its constructor. Stub them hermetically, mirroring the
// @sf/shared theme.service spec, so the shell can boot under test.
function stubEnv() {
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => delete store[k],
    clear: () => Object.keys(store).forEach((k) => delete store[k]),
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn() }));
}

/** Smoke spec for the console shell (ADR 0017 Phase 2): the root component
 *  boots and wires up the @sf/shared dependency (Mark + Theme). */
describe('console App shell', () => {
  beforeEach(() => stubEnv());
  afterEach(() => vi.unstubAllGlobals());

  it('creates the root component', async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    }).compileComponents();

    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });
});
