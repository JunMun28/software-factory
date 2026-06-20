import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Mark, Theme } from '@sf/shared';

/**
 * Console shell (ADR 0017 Phase 2). A minimal building shell for the Control
 * center — admin content moves in during the next slice. It imports the Mark
 * kit component and the Theme service from @sf/shared to prove the shared
 * dependency wires up across both apps.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, Mark],
  template: `
    <header class="console-shell">
      <sf-mark [size]="28" />
      <h1>Control center</h1>
      <span class="theme">theme: {{ theme.resolved() }}</span>
    </header>
    <router-outlet />
  `,
  styles: `
    :host {
      display: block;
      min-height: 100%;
      font-family:
        system-ui,
        -apple-system,
        sans-serif;
    }
    .console-shell {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 24px;
    }
    .console-shell h1 {
      font-size: 18px;
      font-weight: 600;
      margin: 0;
    }
    .theme {
      margin-left: auto;
      font-size: 13px;
      opacity: 0.6;
    }
  `,
})
export class App {
  protected readonly theme = inject(Theme);
}
