import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { Router } from '@angular/router';

import { Icon } from './kit';

/** Two-state world switcher: flips the reviewer between the Factory (admin console)
 *  and the request world. Only mounted for the admin role — the Factory is admin-gated,
 *  so a plain submitter never sees a Factory segment. `full` stretches it to the sidebar
 *  width; the default sizes to content for the request top bar. Clicking the active side
 *  is a no-op. */
@Component({
  selector: 'sf-world-switch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div
      class="wswitch"
      [class.full]="full()"
      role="group"
      aria-label="Switch between Factory and Requests"
    >
      <button
        class="wswitch__seg"
        [class.on]="world() === 'factory'"
        [attr.aria-current]="world() === 'factory' ? 'page' : null"
        (click)="go('factory')"
      >
        <sf-icon name="pipeline" [size]="15" /> Factory
      </button>
      <button
        class="wswitch__seg"
        [class.on]="world() === 'requests'"
        [attr.aria-current]="world() === 'requests' ? 'page' : null"
        (click)="go('requests')"
      >
        <sf-icon name="list" [size]="15" /> Requests
      </button>
    </div>
  `,
})
export class WorldSwitch {
  private router = inject(Router);

  world = input.required<'factory' | 'requests'>();
  full = input<boolean>(false);

  go(world: 'factory' | 'requests') {
    if (world === this.world()) return;
    this.router.navigateByUrl(world === 'factory' ? '/admin/mission' : '/requests');
  }
}
