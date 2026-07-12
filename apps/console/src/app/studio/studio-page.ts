import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, Operator } from '@sf/shared';

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
  private router = inject(Router);
  session = inject(Session);
  operators = signal<Operator[]>([]);
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
