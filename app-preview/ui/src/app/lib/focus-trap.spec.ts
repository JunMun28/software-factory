import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FocusTrap } from './focus-trap';

@Component({
  imports: [FocusTrap],
  template: `
    <button type="button" data-testid="trigger" (click)="open.set(true)">Open</button>
    @if (open()) {
      <section focusTrap (focusTrapEscape)="open.set(false)">
        <button type="button" data-testid="first">First</button>
        <input data-testid="preferred" [attr.autoFocusTarget]="preferInput() ? '' : null" />
        <button type="button" data-testid="last">Last</button>
      </section>
    }
  `,
})
class FocusTrapHost {
  readonly open = signal(false);
  readonly preferInput = signal(true);
}

describe('FocusTrap', () => {
  afterEach(() => vi.useRealTimers());

  it('focuses the marked target and restores the trigger after Escape', async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({ imports: [FocusTrapHost] }).compileComponents();
    const fixture = TestBed.createComponent(FocusTrapHost);
    fixture.detectChanges();

    const trigger: HTMLButtonElement =
      fixture.nativeElement.querySelector('[data-testid="trigger"]');
    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    await vi.runAllTimersAsync();

    const preferred: HTMLInputElement = fixture.nativeElement.querySelector(
      '[data-testid="preferred"]',
    );
    expect(document.activeElement).toBe(preferred);

    preferred.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[focusTrap]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('wraps Tab and Shift-Tab within its host', async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({ imports: [FocusTrapHost] }).compileComponents();
    const fixture = TestBed.createComponent(FocusTrapHost);
    fixture.detectChanges();
    const trigger: HTMLButtonElement =
      fixture.nativeElement.querySelector('[data-testid="trigger"]');
    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    await vi.runAllTimersAsync();

    const first: HTMLButtonElement = fixture.nativeElement.querySelector('[data-testid="first"]');
    const last: HTMLButtonElement = fixture.nativeElement.querySelector('[data-testid="last"]');

    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);

    first.focus();
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(last);
  });

  it('focuses the first focusable element when no target is marked', async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({ imports: [FocusTrapHost] }).compileComponents();
    const fixture = TestBed.createComponent(FocusTrapHost);
    fixture.componentInstance.preferInput.set(false);
    fixture.detectChanges();

    const trigger: HTMLButtonElement =
      fixture.nativeElement.querySelector('[data-testid="trigger"]');
    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    await vi.runAllTimersAsync();

    expect(document.activeElement).toBe(
      fixture.nativeElement.querySelector('[data-testid="first"]'),
    );
  });
});
