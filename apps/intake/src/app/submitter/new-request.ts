import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { Api, AppEntry, Icon, PopMenu } from '@sf/shared';
import { AttachField } from './attach-field';
import { IntakeDraft } from './intake-draft.service';
import { SubShell } from './sub-shell';

/** S1 — New Request: type-first progressive disclosure. */
@Component({
  selector: 'sf-new-request',
  imports: [SubShell, Icon, FormsModule, PopMenu, AttachField],
  template: `
    <sub-shell active="new" [step]="0" [reqId]="draft.requestId">
      <div class="sub-col pop-in">
        <h1 style="font-size:30px">What do you need?</h1>
        <p style="color:var(--muted);margin:6px 0 22px;font-size:16px">
          Pick a type to get started — the right questions appear next.
        </p>
        <div class="typecards">
          @for (t of types; track t.t) {
            <button
              class="typecard focusable"
              [class.on]="draft.type === t.t"
              [attr.aria-pressed]="draft.type === t.t"
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
                <label class="field-label" id="nr-app-lbl" for="nr-app-dd">Which app?</label>
                <div class="dd-wrap">
                  <input
                    id="nr-app-dd"
                    class="input"
                    role="combobox"
                    autocomplete="off"
                    aria-autocomplete="list"
                    aria-labelledby="nr-app-lbl"
                    aria-controls="nr-app-list"
                    [attr.aria-expanded]="appsMenuOpen() && !customApp()"
                    maxlength="120"
                    [placeholder]="customApp() ? 'Type the app name' : 'Search apps, or pick Other'"
                    [ngModel]="appQuery()"
                    (ngModelChange)="customApp() ? onCustomInput($event) : onAppInput($event)"
                    (focus)="!customApp() && openApps()"
                    (blur)="appsMenuOpen.set(false)"
                    (keydown.escape)="appsMenuOpen.set(false)"
                  />
                  @if (!customApp()) {
                    <sf-icon class="dd__chev" name="chevDown" [size]="16" color="var(--faint)" />
                  }
                  @if (appsMenuOpen() && !customApp()) {
                    <div class="pop pop--fill" role="listbox" id="nr-app-list">
                      @for (a of filteredApps(); track a.id) {
                        <button
                          class="pop__opt"
                          role="option"
                          [attr.aria-selected]="draft.appId === a.id"
                          [class.on]="draft.appId === a.id"
                          (mousedown)="$event.preventDefault(); pickApp(a)"
                        >
                          <span class="dd__hash">#</span>{{ a.name }}
                        </button>
                      } @empty {
                        @if (!appQuery().trim()) {
                          <div class="dd__empty">No apps registered yet.</div>
                        }
                      }
                      <button
                        class="pop__opt dd__other"
                        (mousedown)="$event.preventDefault(); chooseOther()"
                      >
                        <sf-icon name="plus" [size]="14" color="var(--accent-tx)" />
                        @if (appQuery().trim() && !exactApp()) {
                          Other — add “{{ appQuery().trim() }}” as a new app
                        } @else {
                          Other — my app isn’t listed
                        }
                      </button>
                    </div>
                  }
                  @if (customApp()) {
                    <button type="button" class="dd__back" (click)="backToList()">
                      <sf-icon name="back" [size]="13" color="var(--muted)" /> Choose from the list
                      instead
                    </button>
                  }
                </div>
              </div>
            }
            @if (draft.type === 'new') {
              <div>
                <label class="field-label" for="nr-name">What should we call it?</label>
                <input
                  id="nr-name"
                  class="input"
                  placeholder="e.g. Quarterly headcount dashboard"
                  [(ngModel)]="draft.newName"
                />
              </div>
            }
            <div>
              <label class="field-label" for="nr-desc">{{ descLabel() }}</label>
              <span class="field-help"
                >A sentence or two is plenty — we'll ask follow-ups next.</span
              >
              <textarea
                id="nr-desc"
                class="input area"
                placeholder="Describe it in your own words…"
                [(ngModel)]="draft.desc"
              ></textarea>
            </div>
            <div>
              <label class="field-label"
                >Attachments
                <span style="font-weight:400;color:var(--faint)">(optional)</span></label
              >
              <span class="field-help"
                >Screenshots, logs, or docs help the AI understand faster.</span
              >
              <sf-attach-field source="describe" />
            </div>
            @if (draft.type === 'bug') {
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
                <div>
                  <label class="field-label" for="nr-where">Where did you see it?</label
                  ><input
                    id="nr-where"
                    class="input"
                    placeholder="Page or screen"
                    [(ngModel)]="draft.bugWhere"
                  />
                </div>
                <div>
                  <label class="field-label" id="nr-freq-lbl">How often?</label>
                  <div class="dd-wrap">
                    <button
                      id="nr-freq-dd"
                      class="input"
                      style="cursor:pointer;text-align:left"
                      aria-labelledby="nr-freq-lbl nr-freq-dd"
                      [attr.aria-expanded]="freqOpen()"
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
                    <sf-pop-menu [open]="freqOpen()" width="fill" (closed)="freqOpen.set(false)">
                      @for (f of freqs; track f) {
                        <button
                          class="pop__opt"
                          [class.on]="draft.bugFreq === f"
                          (click)="draft.bugFreq = f; freqOpen.set(false)"
                        >
                          {{ f }}
                        </button>
                      }
                    </sf-pop-menu>
                  </div>
                </div>
              </div>
            }
            @if (draft.type !== 'bug') {
              <div>
                <label class="field-label" id="nr-reach-lbl" for="nr-reach"
                  >Who's affected?
                  <span style="font-weight:400;color:var(--faint)">(optional)</span></label
                >
                <span class="field-help">Helps the reviewer see how much this is worth.</span>
                <div
                  class="seg"
                  role="group"
                  aria-labelledby="nr-reach-lbl"
                  style="margin-bottom:8px"
                >
                  @for (r of reaches; track r[0]) {
                    <button
                      [class.on]="!draft.reachText && draft.reach === r[0]"
                      [attr.aria-pressed]="!draft.reachText && draft.reach === r[0]"
                      (click)="pickReach($any(r[0]))"
                    >
                      {{ r[1] }}
                    </button>
                  }
                </div>
                <input
                  id="nr-reach"
                  class="input"
                  placeholder="…or describe them, e.g. all shift supervisors in Penang"
                  [ngModel]="draft.reachText"
                  (ngModelChange)="typeReach($event)"
                />
              </div>
              <div>
                <label class="field-label" id="nr-impact-lbl" for="nr-impact"
                  >What's the impact?
                  <span style="font-weight:400;color:var(--faint)">(optional)</span></label
                >
                <span class="field-help"
                  >A rough number is enough — it strengthens the case for approval.</span
                >
                <div
                  class="seg"
                  role="group"
                  aria-labelledby="nr-impact-lbl"
                  [style.margin-bottom]="draft.impactMetric ? '8px' : ''"
                >
                  @for (m of metrics; track m[0]) {
                    <button
                      [class.on]="draft.impactMetric === m[0]"
                      [attr.aria-pressed]="draft.impactMetric === m[0]"
                      (click)="pickMetric($any(m[0]))"
                    >
                      {{ m[1] }}
                    </button>
                  }
                </div>
                @if (draft.impactMetric) {
                  <input
                    id="nr-impact"
                    class="input fade-in"
                    [placeholder]="metricPlaceholder()"
                    [(ngModel)]="draft.impactValue"
                  />
                }
              </div>
            }
            <div>
              <label class="field-label" id="nr-urgency-lbl">How urgent is it?</label>
              <div class="seg" role="group" aria-labelledby="nr-urgency-lbl">
                @for (u of urgencies; track u[0]) {
                  <button
                    [class.on]="draft.urgency === u[0]"
                    [attr.aria-pressed]="draft.urgency === u[0]"
                    (click)="draft.urgency = $any(u[0])"
                  >
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
    .dd-wrap > input.input {
      padding-right: 36px;
    }
    .dd__chev {
      position: absolute;
      right: 12px;
      top: 13px;
      pointer-events: none;
    }
    .dd__other {
      color: var(--accent-tx);
      font-weight: 500;
    }
    .dd__back {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      margin-top: 8px;
      padding: 2px 0;
      background: none;
      border: none;
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
      color: var(--muted);
      transition: color var(--dur) var(--ease);
    }
    .dd__back:hover {
      color: var(--fg2);
    }
    .dd__hash {
      color: var(--faint);
    }
    .pop__opt.on .dd__hash {
      color: var(--a400);
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
  appsMenuOpen = signal(false);
  appQuery = signal('');
  customApp = signal(false); // "Other" was chosen — the input is a free-text app name
  freqOpen = signal(false);
  saving = signal(false);

  /** apps whose name contains the query (whole list when the query is empty). */
  filteredApps = computed(() => {
    const q = this.appQuery().trim().toLowerCase();
    const list = this.apps();
    return q ? list.filter((a) => a.name.toLowerCase().includes(q)) : list;
  });
  /** the registered app whose name the query matches exactly (case-insensitive). */
  exactApp = computed(() => {
    const q = this.appQuery().trim().toLowerCase();
    return q ? (this.apps().find((a) => a.name.toLowerCase() === q) ?? null) : null;
  });
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
    // restore the prior choice on step return: a name with no appId was an "Other" entry
    this.appQuery.set(this.draft.appName);
    this.customApp.set(!!this.draft.appName && this.draft.appId == null);
    this.api.apps().subscribe((a) => {
      this.apps.set(a.filter((x) => !x.muted));
      // a draft restored with a picked app but no text yet — show its name
      if (!this.appQuery() && this.draft.appId != null) {
        const m = this.apps().find((x) => x.id === this.draft.appId);
        if (m) {
          this.appQuery.set(m.name);
          this.draft.appName = m.name;
        }
      }
    });
  }

  openApps() {
    this.appsMenuOpen.set(true);
    this.freqOpen.set(false);
  }
  toggleFreq() {
    this.freqOpen.set(!this.freqOpen());
    this.appsMenuOpen.set(false);
  }

  /** list mode: the text is a filter; only an exact match selects a known app. */
  onAppInput(text: string) {
    this.appQuery.set(text);
    const ex = this.exactApp();
    this.draft.appId = ex ? ex.id : null;
    this.draft.appName = ex ? ex.name : '';
    this.appsMenuOpen.set(true);
  }
  /** custom mode: the text IS the new app name, saved as new_app_name. */
  onCustomInput(text: string) {
    this.appQuery.set(text);
    this.draft.appName = text;
    this.draft.appId = null;
  }
  pickApp(a: AppEntry) {
    this.customApp.set(false);
    this.draft.appId = a.id;
    this.draft.appName = a.name;
    this.appQuery.set(a.name);
    this.appsMenuOpen.set(false);
  }
  /** "Other" — switch to free-text entry, carrying over anything already typed. */
  chooseOther() {
    this.customApp.set(true);
    this.draft.appId = null;
    this.draft.appName = this.appQuery().trim();
    this.appsMenuOpen.set(false);
  }
  /** back to picking from the registered list. */
  backToList() {
    this.customApp.set(false);
    this.draft.appId = null;
    this.draft.appName = '';
    this.appQuery.set('');
    this.appsMenuOpen.set(true);
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
    if (
      (this.draft.type === 'bug' || this.draft.type === 'enh') &&
      !this.draft.appId &&
      !this.draft.appName.trim()
    )
      return false;
    return true;
  }
  async continue_() {
    this.saving.set(true);
    try {
      const id = await this.draft.save();
      await this.draft.uploadPending(id);
      this.router.navigateByUrl(`/submit/${id}/interview`);
    } finally {
      this.saving.set(false);
    }
  }
}
