import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { Glyph } from './glyph';

@Component({
  selector: 'sf-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Glyph],
  template: `<span class="pill" [class]="'pill ' + tone()">
    @if (glyph()) {
      <sf-glyph [type]="glyph()!" [size]="13" [color]="glyphColor()" [fill]="fill()" />
    }
    <ng-content />
  </span>`,
})
export class Pill {
  tone = input<string>('neutral');
  glyph = input<string | null>(null);
  fill = input<number>(0.45);
  glyphColor = computed(
    () =>
      (
        ({
          purple: 'var(--a600)',
          green: 'var(--green)',
          amber: 'var(--amber)',
          red: 'var(--red)',
        }) as Record<string, string>
      )[this.tone()] ?? 'var(--muted)',
  );
}
