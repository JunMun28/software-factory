import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SubShell } from './sub-shell';

@Component({
  imports: [SubShell],
  template: `
    <sub-shell [step]="0" [proto]="true">content</sub-shell>
    <textarea aria-label="Prototype notes"></textarea>
  `,
})
class PrototypeHost {}

const routes: Routes = [{ path: '', component: PrototypeHost }];

describe('SubShell rail title prototype', () => {
  let harness: RouterTestingHarness;
  let router: Router;

  beforeEach(async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: vi.fn(),
    }));

    await TestBed.configureTestingModule({
      providers: [provideRouter(routes)],
    }).compileComponents();

    harness = await RouterTestingHarness.create();
    router = TestBed.inject(Router);
    await harness.navigateByUrl('/', PrototypeHost);
    harness.detectChanges();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('shows title variant A by default', () => {
    const root = harness.routeNativeElement!;

    expect(root.querySelector('[data-rail-variant="A"]')).not.toBeNull();
  });

  it('removes the legacy rail track', () => {
    const root = harness.routeNativeElement!;

    expect(root.querySelector('.rail__track')).toBeNull();
  });

  it('keeps four step dots', () => {
    const root = harness.routeNativeElement!;

    expect(root.querySelectorAll('.mini')).toHaveLength(4);
  });

  it('selects compact-pill variant C from the query string', async () => {
    await router.navigateByUrl('/?variant=C');
    harness.detectChanges();

    const root = harness.routeNativeElement!;
    expect(root.querySelector('[data-rail-variant="C"]')).not.toBeNull();
  });

  it('labels variant C as the compact pill', async () => {
    await router.navigateByUrl('/?variant=C');
    harness.detectChanges();

    const root = harness.routeNativeElement!;
    const label = root.querySelector('.proto-switcher__label');
    expect(label).not.toBeNull();
    expect(label!.textContent).toContain('C — Compact pill');
  });

  it('moves to variant D when ArrowRight is pressed', async () => {
    await router.navigateByUrl('/?variant=C');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await harness.fixture.whenStable();

    expect(router.url).toBe('/?variant=D');
  });

  it('does not change variants when ArrowRight comes from a textarea', async () => {
    await router.navigateByUrl('/?variant=C');
    harness.detectChanges();
    const textarea = harness.routeNativeElement!.querySelector('textarea')!;
    textarea.focus();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await harness.fixture.whenStable();

    expect(router.url).toBe('/?variant=C');
  });
});
