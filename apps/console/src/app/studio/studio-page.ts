import { Component, HostListener, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, AppEntry, AppSubscription, Operator, Poll } from '@sf/shared';

import { Session } from '../core/session.service';
import { Store } from '../core/store.service';
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

        <section class="registry" aria-labelledby="registry-title">
          <div class="registry-head">
            <div>
              <p class="eyebrow">Factory connections</p>
              <h2 id="registry-title">App registry</h2>
            </div>
            <button class="new-app" type="button" (click)="startNewApp()">Register an app</button>
          </div>
          <p class="registry-copy">
            Registration records the app, owner, and repo mapping used by the Factory. It does not
            by itself verify repository access or finish provisioning.
          </p>
          <div class="app-grid">
            @for (app of apps(); track app.id) {
              <article class="app-card">
                <div class="app-title">
                  <span aria-hidden="true">#</span>
                  <div>
                    <h3>{{ app.name }}</h3>
                    <small>{{ app.key }}</small>
                  </div>
                  <button type="button" (click)="editApp(app)">Edit</button>
                </div>
                <dl>
                  <div>
                    <dt>Repo</dt>
                    <dd>{{ app.repo || 'Not mapped' }}</dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd>{{ app.owner || 'Not assigned' }}</dd>
                  </div>
                  <div>
                    <dt>Provisioning</dt>
                    <dd>{{ app.provisioning }}</dd>
                  </div>
                </dl>
              </article>
            } @empty {
              <p class="quiet">No apps registered yet.</p>
            }
          </div>

          @if (editingApp()) {
            <form class="app-form" (ngSubmit)="saveApp()" aria-labelledby="app-form-title">
              <div class="app-form-head">
                <div>
                  <p class="eyebrow">{{ newApp() ? 'New registration' : 'Edit registration' }}</p>
                  <h3 id="app-form-title">
                    {{ newApp() ? 'Connect an app' : editingApp()!.name }}
                  </h3>
                </div>
                <button type="button" class="close-app" (click)="closeAppForm()">Close</button>
              </div>
              <div class="app-fields">
                <label>Name<input name="app-name" required [(ngModel)]="appForm.name" /></label>
                <label
                  >Owner<input name="app-owner" [(ngModel)]="appForm.owner" placeholder="team-name"
                /></label>
                <label
                  >Repo mapping<input
                    name="app-repo"
                    [(ngModel)]="appForm.repo"
                    placeholder="org/repository"
                /></label>
                <label
                  >Provisioning<input
                    name="app-provisioning"
                    [(ngModel)]="appForm.provisioning"
                    placeholder="Manual"
                /></label>
              </div>
              <p class="verification-note">
                Saving records this mapping. The Factory will still report connection or
                provisioning failures honestly when it tries to use it.
              </p>
              @if (appError()) {
                <p class="error" role="alert">{{ appError() }}</p>
              }
              <div class="app-actions">
                <button
                  class="save-app"
                  type="submit"
                  [disabled]="appSaving() || !appForm.name.trim()"
                >
                  {{ appSaving() ? 'Saving…' : 'Save registration' }}
                </button>
                <button type="button" class="cancel-app" (click)="closeAppForm()">Cancel</button>
              </div>
            </form>
          }
        </section>

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
    .registry {
      padding: 24px;
      margin: 0 0 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
    }
    .registry-head,
    .app-title,
    .app-form-head,
    .app-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .registry-head,
    .app-form-head {
      justify-content: space-between;
    }
    .registry-head .eyebrow,
    .registry-head h2,
    .app-form-head .eyebrow,
    .app-form-head h3 {
      margin: 0;
    }
    .registry-head h2 {
      margin-top: 5px;
      font-size: 22px;
    }
    .new-app,
    .save-app {
      padding: 8px 14px;
      color: white;
      background: var(--accent);
      border: 0;
      border-radius: var(--r-pill);
      font-weight: 700;
      cursor: pointer;
    }
    .registry-copy,
    .verification-note {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }
    .registry-copy {
      margin: 14px 0 18px;
    }
    .app-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .app-card {
      padding: 16px;
      background: var(--surface-2);
      border: 1px solid var(--hairline);
      border-radius: var(--r);
    }
    .app-title {
      align-items: flex-start;
    }
    .app-title > span {
      color: var(--faint);
      font: 600 13px var(--mono);
    }
    .app-title h3,
    .app-title small {
      margin: 0;
    }
    .app-title h3 {
      font-size: 15px;
    }
    .app-title small {
      display: block;
      margin-top: 3px;
      color: var(--muted);
      font: 500 10.5px var(--mono);
    }
    .app-title button,
    .close-app,
    .cancel-app {
      margin-left: auto;
      padding: 5px 8px;
      color: var(--accent-tx);
      background: transparent;
      border: 0;
      border-radius: var(--r);
      font-weight: 700;
      cursor: pointer;
    }
    .app-title button:hover,
    .close-app:hover,
    .cancel-app:hover {
      background: var(--accent-tint);
    }
    dl {
      display: grid;
      gap: 8px;
      margin: 16px 0 0;
    }
    dl div {
      display: grid;
      grid-template-columns: 78px 1fr;
      gap: 8px;
    }
    dt {
      color: var(--muted);
      font: 500 10px var(--mono);
      text-transform: uppercase;
    }
    dd {
      min-width: 0;
      margin: 0;
      overflow: hidden;
      color: var(--fg2);
      font-size: 12px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .app-form {
      padding: 18px;
      margin-top: 14px;
      background: var(--surface-2);
      border: 1px solid var(--accent-tint-bd);
      border-radius: var(--r);
    }
    .app-form-head h3 {
      margin-top: 5px;
      font-size: 18px;
    }
    .app-fields {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0 14px;
    }
    .verification-note {
      padding: 10px 12px;
      background: var(--surface);
      border: 1px dashed var(--border-strong);
      border-radius: var(--r);
    }
    .app-actions {
      justify-content: flex-start;
      margin-top: 14px;
    }
    .app-actions .cancel-app {
      margin-left: 0;
    }
    .save-app:disabled {
      opacity: 0.55;
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
      .registry {
        padding: 18px;
      }
      .registry-head {
        align-items: flex-start;
      }
      .app-grid,
      .app-fields {
        grid-template-columns: 1fr;
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
  private store = inject(Store);
  session = inject(Session);
  apps = this.store.apps;
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
  editingApp = signal<AppEntry | null>(null);
  newApp = signal(false);
  appSaving = signal(false);
  appError = signal('');
  appForm = { name: '', owner: '', repo: '', provisioning: 'Manual', muted: false };
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
  startNewApp() {
    this.newApp.set(true);
    this.appError.set('');
    this.appForm = { name: '', owner: '', repo: '', provisioning: 'Manual', muted: false };
    this.editingApp.set({
      id: -1,
      key: '',
      name: '',
      owner: '',
      repo: '',
      provisioning: 'Manual',
      muted: false,
      open_requests: 0,
      unread: false,
    });
  }
  editApp(app: AppEntry) {
    this.newApp.set(false);
    this.appError.set('');
    this.appForm = {
      name: app.name,
      owner: app.owner,
      repo: app.repo,
      provisioning: app.provisioning,
      muted: app.muted,
    };
    this.editingApp.set(app);
  }
  saveApp() {
    if (!this.appForm.name.trim() || this.appSaving()) return;
    this.appSaving.set(true);
    this.appError.set('');
    const request = this.newApp()
      ? this.api.createApp(this.appForm)
      : this.api.updateApp(this.editingApp()!.id, this.appForm);
    request.subscribe({
      next: (saved) => {
        if (this.newApp()) this.apps.update((all) => [...all, saved]);
        else this.apps.update((all) => all.map((app) => (app.id === saved.id ? saved : app)));
        this.appSaving.set(false);
        this.closeAppForm();
        this.poll.nudge();
      },
      error: (error) => {
        this.appSaving.set(false);
        this.appError.set(error.error?.detail || 'Could not save that app registration.');
      },
    });
  }
  closeAppForm() {
    this.editingApp.set(null);
    this.appSaving.set(false);
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

  @HostListener('window:keydown.escape')
  onEscape() {
    if (this.editingApp()) this.closeAppForm();
  }
}
