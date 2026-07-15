import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'sf-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="avatar" [class.sm]="sm()" [class.lg]="lg()" [style.background]="color()"
    ><ng-content
  /></span>`,
})
export class Avatar {
  color = input<string>('var(--avatar)');
  sm = input<boolean>(false);
  lg = input<boolean>(false);
}
