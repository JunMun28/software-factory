import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { ScrubbableInput } from './scrubbable-input';

describe('ScrubbableInput', () => {
  it('keeps normal text editing and emits typed values', async () => {
    await TestBed.configureTestingModule({ imports: [ScrubbableInput] }).compileComponents();
    const fixture = TestBed.createComponent(ScrubbableInput);
    fixture.componentRef.setInput('value', '30px');
    fixture.componentRef.setInput('label', 'Font size');
    const changed = vi.fn();
    fixture.componentInstance.valueChange.subscribe(changed);
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
    input.value = '32px';
    input.dispatchEvent(new Event('input'));

    expect(changed).toHaveBeenLastCalledWith('32px');
  });

  it('scrubs horizontally at one step per four pixels', async () => {
    await TestBed.configureTestingModule({ imports: [ScrubbableInput] }).compileComponents();
    const fixture = TestBed.createComponent(ScrubbableInput);
    fixture.componentRef.setInput('value', '30px');
    fixture.componentRef.setInput('label', 'Font size');
    fixture.componentRef.setInput('step', 1);
    fixture.componentRef.setInput('min', 0);
    const changed = vi.fn();
    fixture.componentInstance.valueChange.subscribe(changed);
    fixture.detectChanges();

    const handle: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Drag to adjust Font size"]',
    );
    handle.dispatchEvent(pointerEvent('pointerdown', 100));
    handle.dispatchEvent(pointerEvent('pointermove', 108));
    handle.dispatchEvent(pointerEvent('pointerup', 108));

    expect(changed).toHaveBeenLastCalledWith('32px');
  });

  it('supports keyboard adjustment and disables non-numeric values', async () => {
    await TestBed.configureTestingModule({ imports: [ScrubbableInput] }).compileComponents();
    const fixture = TestBed.createComponent(ScrubbableInput);
    fixture.componentRef.setInput('value', '30px');
    fixture.componentRef.setInput('label', 'Font size');
    fixture.componentRef.setInput('step', 1);
    fixture.componentRef.setInput('min', 0);
    const changed = vi.fn();
    fixture.componentInstance.valueChange.subscribe(changed);
    fixture.detectChanges();

    let handle: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[aria-label="Drag to adjust Font size"]',
    );
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(changed).toHaveBeenLastCalledWith('31px');

    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true }),
    );
    expect(changed).toHaveBeenLastCalledWith('20px');

    fixture.componentRef.setInput('value', 'normal');
    fixture.detectChanges();
    handle = fixture.nativeElement.querySelector('[aria-label="Drag to adjust Font size"]');
    expect(handle.disabled).toBe(true);
  });
});

function pointerEvent(type: string, clientX: number): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}
