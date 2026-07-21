import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ColorField } from './color-field';

@Component({
  imports: [ColorField],
  template: `
    <app-color-field
      label="Background color"
      [value]="value()"
      (valueChange)="value.set($event)"
    />
  `,
})
class HostComponent {
  readonly value = signal('');
}

describe('ColorField', () => {
  it('exposes paired value and swatch controls with matching labels', async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.value.set('#ff0000');
    fixture.detectChanges();

    const swatch: HTMLInputElement = fixture.nativeElement.querySelector(
      '[aria-label="Background color"]',
    );
    const valueInput: HTMLInputElement = fixture.nativeElement.querySelector(
      '[aria-label="Background color value"]',
    );
    expect(swatch.type).toBe('color');
    expect(valueInput.value).toBe('#ff0000');
  });

  it('renders a no-color indicator when the value is empty', async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const shell: HTMLElement = fixture.nativeElement.querySelector('.swatch-shell');
    expect(shell.classList.contains('no-color')).toBe(true);

    fixture.componentInstance.value.set('#123456');
    fixture.detectChanges();
    expect(shell.classList.contains('no-color')).toBe(false);
  });
});
