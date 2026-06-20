import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Console placeholder home (ADR 0017 Phase 2). The admin pages land here in the
 * next slice; for now this proves the shell boots, routes, and renders.
 */
@Component({
  selector: 'app-console-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="placeholder">
      <p>Console shell is up. Admin content moves in next slice.</p>
    </section>
  `,
  styles: `
    .placeholder {
      padding: 24px;
      font-size: 14px;
      opacity: 0.75;
    }
  `,
})
export class ConsoleHome {}
