import { Component, HostListener, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { Api } from '../core/api.service';
import { AppEntry } from '../core/models';
import { Icon } from '../kit/kit';
import { IntakeDraft } from './intake-draft.service';
import { SubShell } from './sub-shell';

/** S1 — New Request: type-first progressive disclosure. */
@Component({
  selector: 'sf-new-request',
  imports: [SubShell, Icon, FormsModule],
  template: `
    <sub-shell active="new" [step]="0" [reqId]="draft.requestId">
      <div class="sub-col fade-in">
        <h1 style="font-size:30px">What do you need?</h1>
        <p style="color:var(--muted);margin:6px 0 22px;font-size:16px">
          Pick a type to get started — the right questions appear next.
        </p>
        <div class="typecards">
          @for (t of types; track t.t) {
            <button
              class="typecard focusable"
              [class.on]="draft.type === t.t"
              (click)="draft.type = $any(t.t)"
            >
              <sf-icon
                [name]="t.icon"
                [size]="24"
                [color]="draft.type === t.t ? 'var(--a600)' : 'var(--muted)'"
              />
              <span class="typecard__t">{{ t.title }}</span>
              <span class="typecard__h">{{ t.help }}</span>
            </button>
          }
        </div>

        @if (!draft.type) {
          <div
            style="margin-top:24px;padding:30px 20px;border:1.5px dashed var(--border-strong);border-radius:10px;text-align:center;color:var(--faint);font-size:14px"
          >
            Choose a type above to continue.
          </div>
        } @else {
          <div class="fade-in" style="margin-top:26px;display:flex;flex-direction:column;gap:18px">
            @if (draft.type === 'bug' || draft.type === 'enh') {
              <div>
                <label class="field-label">Which app?</label>
                <div class="dd-wrap">
                  <button
                    class="input"
                    style="cursor:pointer;text-align:left"
                    (click)="toggleApps()"
                  >
                    @if (selectedApp(); as a) {
                      <span>{{ a.name }}</span>
                    } @else {
                      <span class="ph">Pick an app</span>
                    }
                    <sf-icon
                      name="chevDown"
                      [size]="16"
                      style="margin-left:auto"
                      color="var(--faint)"
                    />
                  </button>
                  @if (appsOpen()) {
                    <div class="dd">
                      @for (a of apps(); track a.id) {
                        <button
                          class="dd__opt"
                          [class.on]="draft.appId === a.id"
                          (click)="draft.appId = a.id; appsOpen.set(false)"
                        >
                          <span class="dd__hash">#</span>{{ a.name }}
                        </button>
                      } @empty {
                        <div class="dd__empty">
                          No apps registered yet. Choose New app instead, or ask an admin to add
                          one.
                        </div>
                      }
                    </div>
                  }
                </div>
              </div>
            }
            @if (draft.type === 'new') {
              <div>
                <label class="field-label">What should we call it?</label>
                <input
                  class="input"
                  placeholder="e.g. Quarterly headcount dashboard"
                  [(ngModel)]="draft.newName"
                />
              </div>
            }
            <div>
              <label class="field-label">{{ descLabel() }}</label>
              <span class="field-help"
                >A sentence or two is plenty — we'll ask follow-ups next.</span
              >
              <textarea
                class="input area"
                placeholder="Describe it in your own words…"
                [(ngModel)]="draft.desc"
              ></textarea>
            </div>
            @if (draft.type === 'bug') {
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
                <div>
                  <label class="field-label">Where did you see it?</label
                  ><input class="input" placeholder="Page or screen" [(ngModel)]="draft.bugWhere" />
                </div>
                <div>
                  <label class="field-label">How often?</label>
                  <div class="dd-wrap">
                    <button
                      class="input"
                      style="cursor:pointer;text-align:left"
                      (click)="toggleFreq()"
                    >
                      <span [class.ph]="!draft.bugFreq">{{ draft.bugFreq || 'Every time' }}</span>
                      <sf-icon
                        name="chevDown"
                        [size]="16"
                        style="margin-left:auto"
                        color="var(--faint)"
                      />
                    </button>
                    @if (freqOpen()) {
                      <div class="dd">
                        @for (f of freqs; track f) {
                          <button
                            class="dd__opt"
                            [class.on]="draft.bugFreq === f"
                            (click)="draft.bugFreq = f; freqOpen.set(false)"
                          >
                            {{ f }}
                          </button>
                        }
                      </div>
                    }
                  </div>
                </div>
              </div>
            }
            @if (draft.type !== 'bug') {
              <div>
                <label class="field-label"
                  >Who's affected?
                  <span style="font-weight:400;color:var(--faint)">(optional)</span></label
                >
                <span class="field-help">Helps the reviewer see how much this is worth.</span>
                <div class="seg" style="margin-bottom:8px">
                  @for (r of reaches; track r[0]) {
                    <button
                      [class.on]="!draft.reachText && draft.reach === r[0]"
                      (click)="pickReach($any(r[0]))"
                    >
                      {{ r[1] }}
                    </button>
                  }
                </div>
                <input
                  class="input"
                  placeholder="…or describe them, e.g. all shift supervisors in Penang"
                  [ngModel]="draft.reachText"
                  (ngModelChange)="typeReach($event)"
                />
              </div>
              <div>
                <label class="field-label"
                  >What's the impact?
                  <span style="font-weight:400;color:var(--faint)">(optional)</span></label
                >
                <span class="field-help"
                  >A rough number is enough — it strengthens the case for approval.</span
                >
                <div class="seg" [style.margin-bottom]="draft.impactMetric ? '8px' : ''">
                  @for (m of metrics; track m[0]) {
                    <button
                      [class.on]="draft.impactMetric === m[0]"
                      (click)="pickMetric($any(m[0]))"
                    >
                      {{ m[1] }}
                    </button>
                  }
                </div>
                @if (draft.impactMetric) {
                  <input
                    class="input fade-in"
                    [placeholder]="metricPlaceholder()"
                    [(ngModel)]="draft.impactValue"
                  />
                }
              </div>
            }
            <div>
              <label class="field-label">How urgent is it?</label>
              <div class="seg">
                @for (u of urgencies; track u[0]) {
                  <button [class.on]="draft.urgency === u[0]" (click)="draft.urgency = $any(u[0])">
                    {{ u[1] }}
                  </button>
                }
              </div>
            </div>
            <div class="row" style="justify-content:flex-end;margin-top:4px">
              <button
                class="btn primary lg"
                [disabled]="!canContinue() || saving()"
                (click)="continue_()"
              >
                {{ saving() ? 'Saving…' : 'Continue to questions' }}
                <sf-icon name="arrowRight" [size]="16" />
              </button>
            </div>
          </div>
        }
      </div>
    </sub-shell>
  `,
  styles: `
    .seg {
      flex-wrap: wrap;
    }
    .seg button {
      white-space: nowrap;
    }
    .dd-wrap {
      position: relative;
    }
    .dd {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      z-index: 9;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow-pop);
      padding: 5px;
    }
    .dd__opt {
      display: flex;
      width: 100%;
      text-align: left;
      padding: 8px 11px;
      border: none;
      border-radius: 6px;
      background: none;
      cursor: pointer;
      font-family: var(--body);
      font-size: 14px;
      color: var(--fg1);
      gap: 8px;
      align-items: center;
      transition: background var(--dur) var(--ease);
    }
    @media (hover: hover) {
      .dd__opt:hover {
        background: var(--surface-2);
      }
    }
    .dd__opt:active {
      background: var(--surface-3);
    }
    .dd__opt.on {
      background: var(--a50);
      color: var(--a700);
    }
    .dd__opt.on .dd__hash {
      color: var(--a400);
    }
    .dd__hash {
      color: var(--faint);
    }
    .dd__empty {
      padding: 12px;
      font-size: 13px;
      color: var(--muted);
    }
  `,
})
export class NewRequest {
  draft = inject(IntakeDraft);
  private api = inject(Api);
  private router = inject(Router);

  apps = signal<AppEntry[]>([]);
  appsOpen = signal(false);
  freqOpen = signal(false);
  saving = signal(false);
  freqs = ['Every time', 'Most of the time', 'Sometimes', 'Only once so far'];
  urgencies: [string, string][] = [
    ['low', 'Low'],
    ['normal', 'Normal'],
    ['high', 'High'],
  ];
  reaches: [string, string][] = [
    ['me', 'Just me'],
    ['team', 'My team'],
    ['dept', 'My department'],
    ['wider', 'Multiple departments'],
    ['site', 'Site'],
    ['network', 'Network'],
  ];
  metrics: [string, string][] = [
    ['hours', 'Man-hours saved / year'],
    ['cost', 'Cost saved / year (k)'],
    ['other', 'Other benefit'],
  ];

  types = [
    { t: 'bug', icon: 'bug', title: 'Bug fix', help: "Something's broken" },
    { t: 'enh', icon: 'spark', title: 'Enhancement', help: 'Improve an app you use' },
    { t: 'new', icon: 'app', title: 'New app', help: 'Start something fresh' },
    { t: 'other', icon: 'help', title: 'Other', help: 'Not sure — help me figure it out' },
  ];

  constructor() {
    this.api.apps().subscribe((a) => this.apps.set(a.filter((x) => !x.muted)));
  }

  toggleApps() {
    this.appsOpen.set(!this.appsOpen());
    this.freqOpen.set(false);
  }
  toggleFreq() {
    this.freqOpen.set(!this.freqOpen());
    this.appsOpen.set(false);
  }

  @HostListener('document:click', ['$event'])
  onDocClick(e: Event) {
    if (!(e.target as HTMLElement).closest('.dd-wrap')) this.closeMenus();
  }
  @HostListener('document:keydown.escape')
  closeMenus() {
    this.appsOpen.set(false);
    this.freqOpen.set(false);
  }

  selectedApp() {
    return this.apps().find((a) => a.id === this.draft.appId) ?? null;
  }
  pickReach(r: 'me' | 'team' | 'dept' | 'wider' | 'site' | 'network') {
    this.draft.reach = this.draft.reach === r && !this.draft.reachText ? null : r;
    this.draft.reachText = '';
  }
  typeReach(text: string) {
    this.draft.reachText = text;
    if (text.trim()) this.draft.reach = null;
  }
  pickMetric(m: 'hours' | 'cost' | 'other') {
    this.draft.impactMetric = this.draft.impactMetric === m ? null : m;
  }
  metricPlaceholder() {
    return {
      hours: 'e.g. 1200',
      cost: 'e.g. 250',
      other: 'e.g. fewer audit findings each quarter',
    }[this.draft.impactMetric!];
  }
  descLabel() {
    return {
      bug: "What's going wrong?",
      new: 'What should it do?',
      other: 'What do you need?',
      enh: 'What should change?',
    }[this.draft.type!];
  }
  canContinue() {
    if (!this.draft.desc.trim()) return false;
    if ((this.draft.type === 'bug' || this.draft.type === 'enh') && !this.draft.appId) return false;
    return true;
  }
  async continue_() {
    this.saving.set(true);
    try {
      const id = await this.draft.save();
      this.router.navigateByUrl(`/submit/${id}/interview`);
    } finally {
      this.saving.set(false);
    }
  }
}
