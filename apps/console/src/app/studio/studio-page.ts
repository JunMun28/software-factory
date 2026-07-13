import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, AppSubscription, Operator, Poll } from '@sf/shared';

import { Session } from '../core/session.service';
import { ConsoleShell } from '../shell/console-shell';

const HUES = ['#6E5A8A', '#7C5CFC', '#0F766E', '#B45309', '#B42318', '#2563EB'];

@Component({
  selector: 'sf-studio-page',
  imports: [ConsoleShell, FormsModule],
  template: `
    <sf-console-shell active="studio">
      <section class="studio">
        <p class="eyebrow">Studio · Operator profile</p>
        <h1>Who’s at the controls?</h1>
        <p class="intro">
          Pick your named profile, or add yourself. This device remembers only your profile pointer.
        </p>

        <div class="profiles" aria-label="Existing operators">
          @for (operator of operators(); track operator.id) {
            <button
              type="button"
              [class.selected]="session.operatorId() === operator.id"
              (click)="pick(operator)"
            >
              <span class="avatar" [style.background]="operator.hue">{{ operator.initials }}</span>
              <span
                ><b>{{ operator.name }}</b
                ><small>{{ operator.email }}</small></span
              >
              <span class="pick">{{
                session.operatorId() === operator.id ? 'Selected' : 'Pick'
              }}</span>
            </button>
          } @empty {
            <p class="quiet">No operators yet. Create the first profile below.</p>
          }
        </div>

        <section class="notifications" aria-labelledby="notifications-title">
          <div class="notification-head">
            <div>
              <p class="eyebrow">Human-needed pings</p>
              <h2 id="notifications-title">Notification subscriptions</h2>
            </div>
            <p class="smtp-note">
              @if (smtp() === 'configured') {
                Email delivery is configured.
              } @else {
                Email delivery is log-only until SMTP is configured.
              }
            </p>
          </div>
          @if (session.operatorId()) {
            <p class="notification-copy">
              Gate approvals and stalled runs only. Healthy progress and deliveries stay quiet.
            </p>
            <div class="subscription-list">
              @for (subscription of subscriptions(); track subscription.app_id) {
                <div class="subscription-row">
                  <span>
                    <b>{{ subscription.name }}</b>
                    <small>{{ subscription.key }}</small>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    [attr.aria-checked]="subscription.subscribed"
                    [attr.aria-label]="
                      (subscription.subscribed ? 'Mute ' : 'Subscribe to ') + subscription.name
                    "
                    [class.on]="subscription.subscribed"
                    [disabled]="subscriptionPending(subscription.app_id)"
                    (click)="toggleSubscription(subscription)"
                  >
                    <i aria-hidden="true"></i>
                    {{ subscription.subscribed ? 'Subscribed' : 'Muted' }}
                  </button>
                </div>
              } @empty {
                <p class="quiet">No registered apps yet.</p>
              }
            </div>
          } @else {
            <p class="notification-copy">Pick an operator profile to manage app subscriptions.</p>
          }
        </section>

        <form (ngSubmit)="create()">
          <div class="form-head">
            <div>
              <h2>Add an operator</h2>
              <p>Profiles are shared with this Factory.</p>
            </div>
            <span class="preview" [style.background]="hue()">{{ initials() || '—' }}</span>
          </div>
          <label
            >Name<input
              name="name"
              autocomplete="name"
              required
              [ngModel]="name()"
              (ngModelChange)="setName($event)"
          /></label>
          <div class="pair">
            <label
              >Initials<input
                name="initials"
                maxlength="4"
                required
                [ngModel]="initials()"
                (ngModelChange)="setInitials($event)"
            /></label>
            <label
              >Email<input
                name="email"
                type="email"
                autocomplete="email"
                required
                [(ngModel)]="email"
            /></label>
          </div>
          <fieldset>
            <legend>Operator hue</legend>
            <div class="hues">
              @for (choice of hues; track choice) {
                <button
                  type="button"
                  [attr.aria-label]="'Use hue ' + choice"
                  [class.chosen]="hue() === choice"
                  [style.background]="choice"
                  (click)="hue.set(choice)"
                ></button>
              }
            </div>
          </fieldset>
          @if (error()) {
            <p class="error" role="alert">{{ error() }}</p>
          }
          <button class="create" type="submit" [disabled]="saving()">
            {{ saving() ? 'Adding…' : 'Create and use profile' }}
          </button>
        </form>
      </section>
    </sf-console-shell>
  `,
  styles: `
    .studio {
      padding: 56px 0 88px;
      max-width: 760px;
    }
    .eyebrow {
      color: var(--accent-tx);
      font: 600 12px var(--mono);
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    h1 {
      font-size: clamp(34px, 5vw, 52px);
    }
    .intro,
    .quiet,
    form p {
      color: var(--muted);
    }
    .profiles {
      display: grid;
      gap: 8px;
      margin: 30px 0 44px;
    }
    .profiles > button {
      display: flex;
      align-items: center;
      gap: 14px;
      width: 100%;
      padding: 14px 16px;
      color: var(--fg1);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      text-align: left;
      cursor: pointer;
    }
    .profiles > button:hover,
    .profiles > button.selected {
      border-color: var(--accent);
    }
    .avatar,
    .preview {
      display: grid;
      place-items: center;
      width: 38px;
      height: 38px;
      border-radius: 50%;
      color: white;
      font-size: 12px;
      font-weight: 700;
    }
    .notifications {
      padding: 24px;
      margin: 0 0 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
    }
    .notification-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 28px;
    }
    .notification-head .eyebrow,
    .notification-head h2,
    .smtp-note {
      margin: 0;
    }
    .notification-head h2 {
      margin-top: 5px;
      font-size: 22px;
    }
    .smtp-note {
      max-width: 250px;
      color: var(--muted);
      font: 500 12px/1.45 var(--mono);
      text-align: right;
    }
    .notification-copy {
      margin: 14px 0 18px;
      color: var(--muted);
      font-size: 13px;
    }
    .subscription-list {
      border-top: 1px solid var(--hairline);
    }
    .subscription-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 62px;
      border-bottom: 1px solid var(--hairline);
    }
    .subscription-row small {
      display: block;
      margin-top: 3px;
      color: var(--muted);
      font: 500 11px var(--mono);
    }
    [role='switch'] {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 112px;
      padding: 7px 10px;
      color: var(--muted);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--r-pill);
      font: 700 11px var(--body);
      cursor: pointer;
    }
    [role='switch'] i {
      width: 9px;
      height: 9px;
      background: var(--muted);
      border-radius: 50%;
    }
    [role='switch'].on {
      color: var(--accent-tx);
      border-color: var(--accent);
    }
    [role='switch'].on i {
      background: var(--accent);
    }
    [role='switch']:disabled {
      cursor: wait;
      opacity: 0.55;
    }
    .profiles small {
      display: block;
      margin-top: 2px;
      color: var(--muted);
    }
    .pick {
      margin-left: auto;
      color: var(--accent-tx);
      font-size: 12px;
      font-weight: 700;
    }
    form {
      padding: 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
    }
    .form-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .form-head h2,
    .form-head p {
      margin: 0;
    }
    .preview {
      width: 44px;
      height: 44px;
    }
    label {
      display: grid;
      gap: 7px;
      margin: 14px 0;
      color: var(--fg2);
      font-size: 13px;
      font-weight: 600;
    }
    input {
      padding: 10px 12px;
      color: var(--fg1);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--r);
      font: 400 14px var(--body);
    }
    input:focus-visible {
      border-color: var(--accent);
      outline: none;
    }
    .pair {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 14px;
    }
    fieldset {
      padding: 0;
      margin: 18px 0;
      border: 0;
    }
    legend {
      margin-bottom: 9px;
      color: var(--fg2);
      font-size: 13px;
      font-weight: 600;
    }
    .hues {
      display: flex;
      gap: 10px;
    }
    .hues button {
      width: 28px;
      height: 28px;
      border: 2px solid var(--surface);
      border-radius: 50%;
      box-shadow: 0 0 0 1px var(--border);
      cursor: pointer;
    }
    .hues button.chosen {
      box-shadow: 0 0 0 2px var(--fg1);
    }
    .create {
      padding: 9px 16px;
      color: white;
      background: var(--accent);
      border: 0;
      border-radius: var(--r-pill);
      font-weight: 700;
      cursor: pointer;
    }
    .create:disabled {
      opacity: 0.55;
    }
    .error {
      color: var(--red-tx);
    }
    @media (max-width: 640px) {
      .studio {
        padding-top: 34px;
      }
      .pair {
        grid-template-columns: 1fr;
      }
      form {
        padding: 18px;
      }
      .notifications {
        padding: 18px;
      }
      .notification-head {
        display: grid;
        gap: 10px;
      }
      .smtp-note {
        max-width: none;
        text-align: left;
      }
      .subscription-row {
        align-items: flex-start;
        padding: 13px 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      * {
        transition: none !important;
      }
    }
  `,
})
export class StudioPage {
  private api = inject(Api);
  private poll = inject(Poll);
  private router = inject(Router);
  session = inject(Session);
  operators = signal<Operator[]>([]);
  subscriptions = signal<AppSubscription[]>([]);
  smtp = signal<'configured' | 'log-only'>('log-only');
  private pendingSubscriptions = signal<Set<number>>(new Set());
  name = signal('');
  initials = signal('');
  hue = signal(HUES[0]);
  email = '';
  saving = signal(false);
  error = signal('');
  hues = HUES;
  private autoInitials = true;
  constructor() {
    this.api.operators().subscribe((operators) => this.operators.set(operators));
    this.api.health().subscribe((health) => this.smtp.set(health.smtp));
    effect(() => {
      this.poll.version();
      const operatorId = this.session.operatorId();
      if (!operatorId) return;
      this.api
        .operatorSubscriptions(operatorId)
        .subscribe((subscriptions) => this.subscriptions.set(subscriptions));
    });
  }
  setName(value: string) {
    this.name.set(value);
    if (this.autoInitials)
      this.initials.set(
        value
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((part) => part[0])
          .join('')
          .slice(0, 4)
          .toUpperCase(),
      );
  }
  setInitials(value: string) {
    this.autoInitials = false;
    this.initials.set(value.toUpperCase());
  }
  pick(operator: Operator) {
    this.session.select(operator);
    this.router.navigateByUrl('/');
  }
  subscriptionPending(appId: number) {
    return this.pendingSubscriptions().has(appId);
  }
  toggleSubscription(subscription: AppSubscription) {
    const operatorId = this.session.operatorId();
    if (!operatorId || this.subscriptionPending(subscription.app_id)) return;
    this.pendingSubscriptions.update((pending) => new Set(pending).add(subscription.app_id));
    const clearPending = () =>
      this.pendingSubscriptions.update((pending) => {
        const next = new Set(pending);
        next.delete(subscription.app_id);
        return next;
      });
    this.api
      .updateOperatorSubscription(operatorId, subscription.app_id, !subscription.subscribed)
      .subscribe({
        next: (updated) => {
          this.subscriptions.update((all) =>
            all.map((item) => (item.app_id === updated.app_id ? updated : item)),
          );
          clearPending();
        },
        error: () => {
          this.error.set('Could not update that notification preference.');
          clearPending();
        },
      });
  }
  create() {
    if (!this.name().trim() || !this.initials().trim() || !this.email.trim()) return;
    this.saving.set(true);
    this.error.set('');
    this.api
      .createOperator({
        name: this.name().trim(),
        initials: this.initials().trim(),
        hue: this.hue(),
        email: this.email.trim(),
      })
      .subscribe({
        next: (operator) => {
          this.operators.update((all) => [...all, operator]);
          this.session.select(operator);
          this.router.navigateByUrl('/');
        },
        error: (error) => {
          this.saving.set(false);
          this.error.set(error.error?.detail || 'Could not create that profile.');
        },
      });
  }
}
