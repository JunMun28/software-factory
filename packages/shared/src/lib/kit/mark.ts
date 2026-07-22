import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/* ---- the AIRES mark — one folded stroke with the accent landing off its end ---- */
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
      d="M9 32 L19 17 L28 32 L39 16"
      fill="none"
      [attr.stroke]="color() || 'currentColor'"
      [attr.stroke-width]="stroke()"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <circle cx="39" cy="16" [attr.r]="stroke() * 0.62" [attr.fill]="color() || 'var(--a500)'" />
  </svg>`,
})
/** AIRES brand mark: a single unbroken stroke folding through the frame — work
 *  moving through the factory, not a static object — rising at the end, where
 *  the accent dot is the thing that came off it. Replaced the "Stacked S" when
 *  the app was renamed from Stream to AIRES and the S initial stopped meaning
 *  anything (picked from 88 concepts; see mockups/aires-logo). `color` is a mono
 *  override (e.g. #fff inside accent chips); left empty the stroke inherits
 *  currentColor and the dot stays accent.
 *
 *  `stroke` is in viewBox units, so one value is the same OPTICAL weight at any
 *  `size` — a 22px nav mark and a 60px hero mark at stroke 6 look equally heavy.
 *  The accent dot scales with it so the two never drift apart. Unlike the curved
 *  variant this was trialled against, the mitred corners hold their definition
 *  at heavy strokes, so the upper end of the range stays usable. */
export class Mark {
  size = input<number>(20);
  color = input<string>('');
  stroke = input<number>(6);
}
