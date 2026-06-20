import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { Mark } from '@sf/shared';
import { Session } from '../core/session.service';

/** S0 — Login / SSO front door. The curve-frame brand hero on a black field. */
@Component({
  selector: 'sf-login',
  imports: [Mark],
  template: `
    <div style="position:relative;height:100%;overflow:hidden;background:#0A0512">
      <div
        style="position:absolute;inset:0;background-image:linear-gradient(120deg, rgba(10,1,28,.72), rgba(10,1,28,.18) 60%, rgba(10,1,28,0)), url('/assets/hero-waves.jpg');background-size:cover;background-position:center"
      ></div>
      <div
        style="position:relative;height:100%;display:flex;align-items:center;justify-content:center;padding:24px"
      >
        <div style="display:flex;flex-direction:column;align-items:center;gap:22px">
          <div
            class="card"
            style="width:364px;padding:34px 32px;display:flex;flex-direction:column;align-items:center;gap:18px;text-align:center;border-radius:14px"
          >
            <sf-mark [size]="32" />
            <div>
              <div style="font:700 26px/1.05 var(--display);letter-spacing:-0.02em">
                Software Factory
              </div>
              <div style="font-size:15px;color:var(--muted);margin-top:6px">
                Tell us what you need built.
              </div>
            </div>
            <button
              class="btn primary lg block focusable"
              (click)="signIn('submitter')"
              [style.opacity]="loading() === 'submitter' ? 0.92 : 1"
              autofocus
            >
              @if (loading() === 'submitter') {
                <span
                  style="width:15px;height:15px;border-radius:50%;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;display:inline-block"
                  class="spin"
                ></span>
                Opening Microsoft…
              } @else {
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 18 18"
                  style="flex:0 0 auto"
                  aria-hidden="true"
                >
                  <rect x="0" y="0" width="8.25" height="8.25" fill="#F25022" />
                  <rect x="9.75" y="0" width="8.25" height="8.25" fill="#7FBA00" />
                  <rect x="0" y="9.75" width="8.25" height="8.25" fill="#00A4EF" />
                  <rect x="9.75" y="9.75" width="8.25" height="8.25" fill="#FFB900" />
                </svg>
                Sign in with Microsoft
              }
            </button>
            <div style="font-size:13px;color:var(--muted)">
              No new password — uses your Micron account.
            </div>
            <button
              class="btn ghost sm"
              style="color:var(--faint);margin-top:-6px"
              (click)="signIn('admin')"
            >
              @if (loading() === 'admin') {
                Opening…
              } @else {
                Sign in as a reviewer
              }
            </button>
          </div>
          <div style="font-size:13px;color:rgba(255,255,255,.78)">
            Trouble signing in?
            <span style="color:#fff;text-decoration:underline;text-underline-offset:2px"
              >Contact IT</span
            >
          </div>
        </div>
      </div>
    </div>
  `,
})
export class Login {
  private session = inject(Session);
  private router = inject(Router);
  loading = signal<'submitter' | 'admin' | null>(null);

  signIn(role: 'submitter' | 'admin') {
    if (this.loading()) return;
    this.loading.set(role);
    setTimeout(() => {
      this.session.signIn(role);
      this.router.navigateByUrl(role === 'admin' ? '/admin/mission' : '/submit/new');
    }, 900);
  }
}
