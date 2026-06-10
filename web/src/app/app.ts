import { Component, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';

import { Session } from './core/session.service';

/** Root shell: router + the demo role switcher (stands in for the SSO role fork). */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `
    <router-outlet />
    <div class="pnav">
      <button class="pnav__toggle" (click)="open = !open"><span class="dot"></span> {{ session.user().name }}</button>
      @if (open) {
        <div class="pnav__panel">
          <div class="pnav__head">
            <div class="pnav__title">Software Factory</div>
            <div class="pnav__sub">Demo identities — the SSO role fork</div>
          </div>
          <div class="pnav__roles">
            <button class="pnav__role" [class.on]="session.user().role === 'submitter'" (click)="signInAs('submitter')">Submitter</button>
            <button class="pnav__role" [class.on]="session.user().role === 'admin'" (click)="signInAs('admin')">Admin</button>
          </div>
        </div>
      }
    </div>
  `,
  styles: ':host { display: block; height: 100%; }',
})
export class App {
  session = inject(Session);
  private router = inject(Router);
  open = false;

  signInAs(role: 'submitter' | 'admin') {
    this.session.signIn(role);
    this.open = false;
    this.router.navigateByUrl(role === 'admin' ? '/admin/board' : '/requests');
  }
}
