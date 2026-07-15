import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/* ---- the factory mark — micron-dot square (nods to wafer motif) ---- */
@Component({
  selector: 'sf-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
    [attr.width]="size()"
    [attr.height]="size()"
    viewBox="0 0 48 48"
    style="flex:0 0 auto;display:block"
    aria-hidden="true"
  >
    <path
      d="M38 11 H17 a5.5 5.5 0 0 0 0 11 h14 a5.5 5.5 0 0 1 0 11 H10"
      fill="none"
      [attr.stroke]="color() || 'currentColor'"
      stroke-width="6"
      stroke-linecap="round"
    />
    <circle cx="10" cy="33" r="4.5" [attr.fill]="color() || 'var(--a500)'" />
  </svg>`,
})
/** "Stacked S" brand mark: one continuous production line bent into the initial,
 *  with the accent dot as the part coming off the end. `color` is a mono override
 *  (e.g. #fff inside accent chips); left empty the S inherits currentColor and the
 *  dot stays accent. */
export class Mark {
  size = input<number>(20);
  color = input<string>('');
}
