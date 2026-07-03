import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { Api, AppEntry, Icon } from '@sf/shared';
import { AttachField } from './attach-field';
import { IntakeDraft } from './intake-draft.service';
import { SubShell } from './sub-shell';

/** S1 — New Request: ledger layout — label-left rows with hairline dividers,
 *  no helper subtitles (hints live in placeholders). Chosen from the 2026-07
 *  form prototype (variant 2 of 10). */
@Component({
  selector: 'sf-new-request',
  imports: [SubShell, Icon, FormsModule, AttachField],
  template: `
    <sub-shell active="new" [step]="0" [reqId]="draft.requestId">
      <div class="sub-col pop-in" style="max-width:820px">
        <h1 style="font-size:26px;margin-bottom:6px">New request</h1>
        <div class="lg">
          <div class="lg__row">
            <div class="lg__lbl" id="nr-type-lbl">Type</div>
            <div class="lg__ctl">
              <div class="seg wrap" role="group" aria-labelledby="nr-type-lbl">
                @for (t of types; track t[0]) {
                  <button
                    [class.on]="draft.type === t[0]"
                    [attr.aria-pressed]="draft.type === t[0]"
                    (click)="draft.type = $any(t[0])"
                  >
                    {{ t[1] }}
                  </button>
                }
              </div>
            </div>
          </div>

          @if (draft.type) {
            @if (draft.type === 'bug' || draft.type === 'enh') {
              <div class="lg__row fade-in">
                <label class="lg__lbl" id="nr-app-lbl" for="nr-app-dd">Application</label>
                <div class="lg__ctl">
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
                      (focus)="!customApp() && appsMenuOpen.set(true)"
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
                        <sf-icon name="back" [size]="13" color="var(--muted)" /> Choose from the
                        list instead
                      </button>
                    }
                  </div>
                </div>
              </div>
            }
            @if (draft.type === 'new') {
              <div class="lg__row fade-in">
                <label class="lg__lbl" for="nr-name">Name</label>
                <div class="lg__ctl">
                  <input
                    id="nr-name"
                    class="input"
                    placeholder="e.g. Quarterly headcount dashboard"
                    [(ngModel)]="draft.newName"
                  />
                </div>
              </div>
            }

            <div class="lg__row fade-in">
              <label class="lg__lbl" for="nr-desc">Description</label>
              <div class="lg__ctl">
                <textarea
                  id="nr-desc"
                  class="input area"
                  placeholder="Describe it in your own words — a sentence or two is plenty."
                  [(ngModel)]="draft.desc"
                ></textarea>
              </div>
            </div>

            @if (draft.type === 'bug') {
              <div class="lg__row fade-in">
                <label class="lg__lbl" for="nr-where">Where seen</label>
                <div class="lg__ctl">
                  <input
                    id="nr-where"
                    class="input"
                    placeholder="Page or screen"
                    [(ngModel)]="draft.bugWhere"
                  />
                </div>
              </div>
              <div class="lg__row fade-in">
                <div class="lg__lbl" id="nr-freq-lbl">Frequency</div>
                <div class="lg__ctl">
                  <div class="seg wrap" role="group" aria-labelledby="nr-freq-lbl">
                    @for (f of freqs; track f) {
                      <button
                        [class.on]="draft.bugFreq === f"
                        [attr.aria-pressed]="draft.bugFreq === f"
                        (click)="draft.bugFreq = f"
                      >
                        {{ f }}
                      </button>
                    }
                  </div>
                </div>
              </div>
            } @else {
              <div class="lg__row fade-in">
                <div class="lg__lbl" id="nr-reach-lbl">
                  Who's affected<span class="lg__opt">Optional</span>
                </div>
                <div class="lg__ctl">
                  <div class="seg wrap" role="group" aria-labelledby="nr-reach-lbl">
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
                    style="margin-top:8px"
                    aria-labelledby="nr-reach-lbl"
                    placeholder="…or describe them, e.g. all shift supervisors in Penang"
                    [ngModel]="draft.reachText"
                    (ngModelChange)="typeReach($event)"
                  />
                </div>
              </div>
              <div class="lg__row fade-in">
                <div class="lg__lbl" id="nr-impact-lbl">
                  Impact<span class="lg__opt">Optional</span>
                </div>
                <div class="lg__ctl">
                  <div class="seg wrap" role="group" aria-labelledby="nr-impact-lbl">
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
                      style="margin-top:8px;max-width:280px"
                      aria-labelledby="nr-impact-lbl"
                      [placeholder]="metricPlaceholder()"
                      [(ngModel)]="draft.impactValue"
                    />
                  }
                </div>
              </div>
            }

            <div class="lg__row fade-in">
              <div class="lg__lbl" id="nr-urgency-lbl">Urgency</div>
              <div class="lg__ctl">
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
            </div>

            <div class="lg__row fade-in">
              <div class="lg__lbl">Attachments<span class="lg__opt">Optional</span></div>
              <div class="lg__ctl"><sf-attach-field source="describe" /></div>
            </div>

            <div class="lg__foot fade-in">
              <button
                class="btn primary lg"
                [disabled]="!canContinue() || saving()"
                (click)="continue_()"
              >
                {{ saving() ? 'Saving…' : 'Continue' }} <sf-icon name="arrowRight" [size]="16" />
              </button>
            </div>
          }
        </div>
      </div>
    </sub-shell>
  `,
  styles: `
    .lg {
      margin-top: 18px;
    }
    .lg__row {
      display: grid;
      grid-template-columns: 190px 1fr;
      gap: 22px;
      padding: 18px 0;
      border-bottom: 1px solid var(--hairline);
    }
    .lg__lbl {
      font-size: 13.5px;
      font-weight: 600;
      color: var(--fg1);
      padding-top: 9px;
      margin: 0;
    }
    .lg__opt {
      display: block;
      font-weight: 400;
      color: var(--faint);
      font-size: 11.5px;
      margin-top: 2px;
    }
    .lg__ctl {
      min-width: 0;
    }
    .lg__foot {
      display: flex;
      justify-content: flex-end;
      padding: 20px 0;
    }
    @media (max-width: 640px) {
      .lg__row {
        grid-template-columns: 1fr;
        gap: 8px;
      }
      .lg__lbl {
        padding-top: 0;
      }
    }
    .seg.wrap {
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
  types: [string, string][] = [
    ['bug', 'Bug fix'],
    ['enh', 'Enhancement'],
    ['new', 'New app'],
    ['other', 'Other'],
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
