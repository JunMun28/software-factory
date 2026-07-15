import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { Glyph } from './glyph';

/* signal badge — the loud gate / needs-human marker */
@Component({
  selector: 'sf-sig',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Glyph],
  template: `<span [class]="'sig ' + tone()">
    @if (glyph()) {
      <sf-glyph
        [type]="glyph()!"
        [size]="13"
        [color]="tone() === 'red' ? 'var(--red)' : 'var(--amber)'"
        [fill]="0.5"
      />
    }
    <ng-content />
    @if (kbd()) {
      <kbd class="kbd">{{ kbd() }}</kbd>
    }
  </span>`,
})
export class Sig {
  tone = input<string>('amber');
  glyph = input<string | null>(null);
  kbd = input<string | null>(null);
}
