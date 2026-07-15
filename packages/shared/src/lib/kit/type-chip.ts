import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { TYPE_LABEL } from '../util';
import { Icon } from './icon';

@Component({
  selector: 'sf-type-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `<span class="chip" [class.solid]="solid()"
    ><sf-icon [name]="icon()" [size]="12" />{{ label() }}</span
  >`,
})
export class TypeChip {
  t = input.required<string>();
  solid = input<boolean>(false);
  icon = computed(
    () =>
      (({ bug: 'bug', enh: 'spark', new: 'app', other: 'help' }) as Record<string, string>)[
        this.t()
      ] ?? 'help',
  );
  label = computed(() => TYPE_LABEL[this.t()] ?? this.t());
}
