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

@Component({
  imports: [SubShell],
  template: `<sub-shell [step]="1" [proto]="true">content</sub-shell>`,
})
class LaterStepHost {}

const routes: Routes = [
  { path: 'later', component: LaterStepHost },
  { path: 'prototype', component: PrototypeHost },
  { path: '', component: PrototypeHost },
];

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

  it('falls back to title variant A for an invalid query value', async () => {
    await router.navigateByUrl('/?variant=unknown');
    harness.detectChanges();

    const root = harness.routeNativeElement!;
    expect(root.querySelector('[data-rail-variant="A"]')).not.toBeNull();
    expect(root.querySelector('[data-rail-variant="B"]')).toBeNull();
    expect(root.querySelector('.proto-switcher__label')!.textContent).toContain(
      'A — Chapter label',
    );
  });

  it('exposes the prototype controls as a labelled group with polite announcements', () => {
    const root = harness.routeNativeElement!;
    const switcher = root.querySelector('.proto-switcher');
    const label = root.querySelector('.proto-switcher__label');

    expect(switcher?.getAttribute('role')).toBe('group');
    expect(switcher?.getAttribute('aria-label')).toBe('Rail title prototype switcher');
    expect(label?.getAttribute('aria-live')).toBe('polite');
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

  it('uses an unpadded step number in compact-pill variant C', async () => {
    await router.navigateByUrl('/?variant=C');
    harness.detectChanges();

    const title = harness.routeNativeElement!.querySelector('[data-rail-variant="C"]')!;
    const parts = title.querySelectorAll('span');
    expect(parts[0].textContent).toBe('1');
    expect(parts[1].textContent).toBe('Describe');
  });

  it('keeps bracket variant D free of decorative elements', async () => {
    await router.navigateByUrl('/?variant=D');
    harness.detectChanges();

    const title = harness.routeNativeElement!.querySelector('[data-rail-variant="D"]')!;
    expect(title.querySelectorAll('i')).toHaveLength(0);
  });

  it('moves to variant D when ArrowRight is pressed', async () => {
    await router.navigateByUrl('/?variant=C');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await harness.fixture.whenStable();

    expect(router.url).toBe('/?variant=D');
  });

  it('keeps the current route and merges unrelated query params when clicked', async () => {
    await harness.navigateByUrl('/prototype?variant=C&review=rail', PrototypeHost);
    harness.detectChanges();

    const next = harness.routeNativeElement!.querySelector<HTMLButtonElement>(
      '[aria-label="Next rail title variant"]',
    )!;
    next.click();
    await harness.fixture.whenStable();

    expect(router.url).toBe('/prototype?variant=D&review=rail');
  });

  it('cycles with the click controls and wraps between variants A and E', async () => {
    const root = harness.routeNativeElement!;
    const previous = root.querySelector<HTMLButtonElement>(
      '[aria-label="Previous rail title variant"]',
    )!;
    const next = root.querySelector<HTMLButtonElement>('[aria-label="Next rail title variant"]')!;

    previous.click();
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect(router.url).toBe('/?variant=E');
    expect(root.querySelector('[data-rail-variant="E"]')).not.toBeNull();

    next.click();
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect(router.url).toBe('/?variant=A');
    expect(root.querySelector('[data-rail-variant="A"]')).not.toBeNull();
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

  it('does not change variants with arrow keys after the first step', async () => {
    await harness.navigateByUrl('/later?variant=C', LaterStepHost);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await harness.fixture.whenStable();

    expect(router.url).toBe('/later?variant=C');
  });
});
