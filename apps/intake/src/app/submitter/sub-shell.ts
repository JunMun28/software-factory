import { Component, inject, input } from '@angular/core';
import { Router } from '@angular/router';

import { Avatar, Glyph, Icon, Mark, Theme } from '@sf/shared';
import { Session } from '../core/session.service';

/** Submitter shell: top bar + optional intake stepper (Describe → Clarify → Review).
 *  Intake is submitter-only since the app split (ADR 0017 Phase 2) — the cross-world
 *  switcher and the role/persona switch were removed; "home" is always My requests. */
@Component({
  selector: 'sub-shell',
  imports: [Mark, Avatar, Glyph, Icon],
  template: `
    <div class="sub">
      <div class="sub-top">
        <button class="sub-brand" type="button" (click)="home()" title="My requests">
          <sf-mark [size]="20" /> Software Factory
        </button>
        <div class="row" style="gap:16px">
          <nav class="sub-nav">
            <button [class.on]="active() === 'new'" (click)="go('/submit/new')">New request</button>
            <button [class.on]="active() === 'list'" (click)="go('/requests')">My requests</button>
          </nav>
          <button
            class="adm-iconbtn"
            type="button"
            (click)="toggleTheme()"
            [attr.aria-label]="
              theme.resolved() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
            "
            [title]="theme.resolved() === 'dark' ? 'Light mode' : 'Dark mode'"
          >
            <sf-icon [name]="theme.resolved() === 'dark' ? 'sun' : 'moon'" [size]="16" />
          </button>
          <span
            class="sub-id"
            style="font-family:var(--body);font-size:13px"
            [title]="session.user().email"
          >
            <sf-avatar [sm]="true" [color]="session.user().color">{{
              session.user().initials
            }}</sf-avatar>
            {{ session.user().name }}
          </span>
        </div>
      </div>
      @if (step() !== null) {
        <div class="stepbar">
          <div class="stepper">
            @for (s of steps(); track s.label; let i = $index) {
              <button
                type="button"
                class="step"
                [class.done]="i < step()!"
                [class.cur]="i === step()!"
                [class.clickable]="i < step()! && backable()"
                [disabled]="i >= step()! || !backable()"
                (click)="i < step()! && backable() && goStep(i)"
                [title]="i < step()! && backable() ? 'Go back to ' + s.label : ''"
              >
                <span class="step__dot">
                  @if (i < step()!) {
                    <sf-glyph type="check" [size]="15" color="#fff" />
                  } @else {
                    {{ i + 1 }}
                  }
                </span>
                <span class="step__lbl">{{ s.label }}</span>
              </button>
              @if (i < steps().length - 1) {
                <span class="step__line" [class.done]="i < step()!"></span>
              }
            }
          </div>
        </div>
      }
      <div class="sub-body scroll"><ng-content /></div>
    </div>
  `,
  styles: `
    .sub-brand {
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
      color: inherit;
    }
    .sub-brand:hover {
      opacity: 0.78;
    }
  `,
})
export class SubShell {
  session = inject(Session);
  theme = inject(Theme);
  private router = inject(Router);

  toggleTheme() {
    this.theme.set(this.theme.resolved() === 'dark' ? 'light' : 'dark');
  }

  home() {
    this.router.navigateByUrl('/requests');
  }

  active = input<'new' | 'list' | ''>('');
  step = input<number | null>(null);
  /** request id for step navigation; when set, steps before the current are clickable */
  reqId = input<number | null>(null);
  /** new-app flow inserts the Prototype step between Clarify and Review */
  proto = input(false);

  private allSteps = [
    { label: 'Describe', path: () => '/submit/new' },
    { label: 'Clarify', path: (id: number | null) => `/submit/${id}/interview` },
    { label: 'Prototype', path: (id: number | null) => `/submit/${id}/prototype` },
    { label: 'Review', path: (id: number | null) => `/submit/${id}/review` },
  ];

  /** the visible wizard steps — Prototype only appears in the new-app flow */
  steps() {
    return this.proto() ? this.allSteps : this.allSteps.filter((s) => s.label !== 'Prototype');
  }

  backable() {
    return this.step()! <= this.steps().length - 1;
  }
  go(url: string) {
    this.router.navigateByUrl(url);
  }
  goStep(i: number) {
    this.router.navigateByUrl(this.steps()[i].path(this.reqId()));
  }
}
