import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-color-field',
  template: `
    <div class="color-field" [class.compact]="compact()">
      <input
        class="color-value"
        [attr.aria-label]="label() + ' value'"
        [value]="value()"
        (input)="valueChange.emit(($any($event.target)).value)"
      />
      <span class="swatch-shell" [class.no-color]="!value()">
        <input
          type="color"
          class="color-swatch"
          [attr.aria-label]="label()"
          [value]="value()"
          (input)="valueChange.emit(($any($event.target)).value)"
        />
      </span>
    </div>
  `,
  styles: `
    .color-field {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 34px;
      align-items: center;
      gap: 0.5rem;
    }
    .color-field.compact {
      grid-template-columns: minmax(0, 1fr) 28px;
      gap: 0.25rem;
    }
    .color-value {
      min-width: 0;
      width: 100%;
      height: 2rem;
      border: 1px solid var(--input);
      border-radius: 0.375rem;
      background: var(--background);
      padding: 0 0.5rem;
      color: var(--foreground);
      font-size: 0.6875rem;
      outline: none;
    }
    .color-value:focus {
      border-color: var(--ring);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--ring) 24%, transparent);
    }
    .swatch-shell {
      position: relative;
      display: inline-flex;
      height: 2rem;
      width: 2rem;
    }
    .compact .swatch-shell {
      width: 1.75rem;
    }
    .color-swatch {
      height: 100%;
      width: 100%;
      cursor: pointer;
      border-radius: 9999px;
      border: 1px solid var(--border);
      background: transparent;
      padding: 0.125rem;
    }
    .compact .color-swatch {
      border-radius: 0.375rem;
    }
    /* Fully transparent / unset colors render as an honest "no color" chip
       instead of the native control's default black swatch. */
    .no-color::after {
      content: '';
      position: absolute;
      inset: 1px;
      border-radius: inherit;
      pointer-events: none;
      background:
        linear-gradient(
          to top left,
          transparent calc(50% - 0.5px),
          var(--destructive, #ef4444) calc(50% - 0.5px),
          var(--destructive, #ef4444) calc(50% + 0.5px),
          transparent calc(50% + 0.5px)
        ),
        repeating-conic-gradient(
          color-mix(in oklab, var(--muted-foreground) 22%, transparent) 0% 25%,
          var(--background) 0% 50%
        )
        50% / 8px 8px;
    }
    .no-color::after {
      border-radius: 9999px;
    }
    .compact .no-color::after {
      border-radius: 0.375rem;
    }
    .no-color .color-swatch {
      opacity: 0;
    }
  `,
})
export class ColorField {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly compact = input(false);
  readonly valueChange = output<string>();
}
