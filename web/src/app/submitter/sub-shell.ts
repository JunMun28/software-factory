import { Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';

import { ADMIN, Session, SUBMITTER } from '../core/session.service';
import { Avatar, Glyph, Icon, Mark, PopMenu } from '../kit/kit';

/** Shared submitter shell: top bar + optional intake stepper (Describe → Clarify → Review).
 *  Supervisors reach the intake form too (the console's "New request"), so the shell is
 *  role-aware: it always offers a way back to wherever "home" is for the signed-in role. */
@Component({
  selector: 'sub-shell',
  imports: [Mark, Avatar, Glyph, Icon, PopMenu],
  template: `
    <div class="sub">
      <div class="sub-top">
        <button class="sub-brand" type="button" (click)="home()" [title]="homeTip()">
          <sf-mark [size]="20" /> Software Factory
        </button>
        <div class="row" style="gap:16px">
          <nav class="sub-nav">
            @if (admin()) {
              <button class="sub-back" (click)="go('/admin/mission')">
                <sf-icon name="back" [size]="15" color="currentColor" /> Mission control
              </button>
            } @else {
              <button [class.on]="active() === 'new'" (click)="go('/submit/new')">
                New request
              </button>
              <button [class.on]="active() === 'list'" (click)="go('/requests')">
                My requests
              </button>
            }
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
                <sf-avatar [sm]="true" color="var(--avatar)">{{ other().initials }}</sf-avatar>
                Switch to {{ other().name }}
                <span style="margin-left:auto;font-size:10.5px;color:var(--faint)">{{
                  otherRoleLabel()
                }}</span>
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
    .sub-nav .sub-back {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
  `,
})
export class SubShell {
  session = inject(Session);
  private router = inject(Router);
  whoOpen = false;

  /** Supervisors land here via the console's "New request" — give them a way home. */
  admin = computed(() => this.session.user().role === 'admin');
  /** The persona the role-switcher offers to become (the opposite of the current one). */
  other = computed(() => (this.admin() ? SUBMITTER : ADMIN));
  otherRoleLabel = computed(() => (this.admin() ? 'Submitter' : 'Reviewer'));
  homeTip = computed(() => (this.admin() ? 'Back to Mission control' : 'My requests'));

  home() {
    this.router.navigateByUrl(this.admin() ? '/admin/mission' : '/requests');
  }

  switchRole() {
    this.whoOpen = false;
    if (this.admin()) {
      this.session.signIn('submitter');
      this.router.navigateByUrl('/requests');
    } else {
      this.session.signIn('admin');
      this.router.navigateByUrl('/admin/mission');
    }
  }

  active = input<'new' | 'list' | ''>('');
  step = input<number | null>(null);
  /** request id for step navigation; when set, steps before the current are clickable */
  reqId = input<number | null>(null);

  steps = [
    { label: 'Describe', path: () => '/submit/new' },
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
