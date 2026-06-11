import { Component, inject, input } from '@angular/core';
import { Router } from '@angular/router';

import { Session } from '../core/session.service';
import { Avatar, Glyph, Mark, PopMenu } from '../kit/kit';

/** Shared submitter shell: top bar + optional intake stepper (Describe → Clarify → Review). */
@Component({
  selector: 'sub-shell',
  imports: [Mark, Avatar, Glyph, PopMenu],
  template: `
    <div class="sub">
      <div class="sub-top">
        <div class="sub-brand"><sf-mark [size]="20" /> Software Factory</div>
        <div class="row" style="gap:16px">
          <nav class="sub-nav">
            <button [class.on]="active() === 'new'" (click)="go('/submit/new')">New request</button>
            <button [class.on]="active() === 'list'" (click)="go('/requests')">My requests</button>
          </nav>
          <span style="position:relative">
            <button
              class="sub-id"
              style="background:none;cursor:pointer;font-family:var(--body);font-size:13px"
              (click)="whoOpen = !whoOpen"
            >
              <sf-avatar [sm]="true" [color]="session.user().color">{{
                session.user().initials
              }}</sf-avatar>
              {{ session.user().name }}
            </button>
            <sf-pop-menu [open]="whoOpen" [width]="230" (closed)="whoOpen = false">
              <button class="pop__opt" (click)="switchRole()">
                <sf-avatar [sm]="true" color="#6E5A8A">KP</sf-avatar> Switch to Kim P.
                <span style="margin-left:auto;font-size:10.5px;color:var(--faint)">Reviewer</span>
              </button>
            </sf-pop-menu>
          </span>
        </div>
      </div>
      @if (step() !== null) {
        <div class="stepbar">
          <div class="stepper">
            @for (s of steps; track s.label; let i = $index) {
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
              @if (i < steps.length - 1) {
                <span class="step__line" [class.done]="i < step()!"></span>
              }
            }
          </div>
        </div>
      }
      <div class="sub-body scroll"><ng-content /></div>
    </div>
  `,
})
export class SubShell {
  session = inject(Session);
  private router = inject(Router);
  whoOpen = false;

  switchRole() {
    this.whoOpen = false;
    this.session.signIn('admin');
    this.router.navigateByUrl('/admin/pipeline');
  }

  active = input<'new' | 'list' | ''>('');
  step = input<number | null>(null);
  /** request id for step navigation; when set, steps before the current are clickable */
  reqId = input<number | null>(null);

  steps = [
    { label: 'Describe', path: (id: number | null) => (id ? `/submit/new` : '/submit/new') },
    { label: 'Clarify', path: (id: number | null) => `/submit/${id}/interview` },
    { label: 'Review', path: (id: number | null) => `/submit/${id}/review` },
  ];

  backable() {
    return this.step()! <= 2;
  }
  go(url: string) {
    this.router.navigateByUrl(url);
  }
  goStep(i: number) {
    this.router.navigateByUrl(this.steps[i].path(this.reqId()));
  }
}
