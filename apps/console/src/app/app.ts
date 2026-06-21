import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * Console shell (ADR 0017 Phase 2). A bare router outlet — the admin world's own
 * inverted-L shell (admin-shell) renders full-screen, so there is no extra
 * chrome here.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `<router-outlet />`,
  styles: ':host { display: block; height: 100%; }',
})
export class App {}
