import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { Api, AppEntry, Icon } from '@sf/shared';
import { AttachField } from './attach-field';
import { IntakeDraft } from './intake-draft.service';
import { SubShell } from './sub-shell';

/** S1 — New Request: ledger layout — label-left rows with hairline dividers
 *  and mono row indices (spec-sheet feel), no helper subtitles (hints live in
 *  placeholders). Chosen from the 2026-07 form prototype (variant 2 of 10).
 *  ⌘↵ / Ctrl↵ submits. */
@Component({
  selector: 'sf-new-request',
  imports: [SubShell, Icon, FormsModule, AttachField],
  host: {
    '(document:keydown.meta.enter)': 'kbdSubmit()',
    '(document:keydown.control.enter)': 'kbdSubmit()',
  },
  template: `
    <sub-shell active="new" [step]="0" [proto]="draft.type === 'new'" [reqId]="draft.requestId">
      <div class="sub-col pop-in" style="max-width:820px">
        <header class="hero">
          <span class="eyebrow">New request</span>
          <h1 class="hero__t">What should we build?</h1>
          <p class="hero__s">
            Describe it in plain language. The factory asks the right follow-ups.
          </p>
        </header>
        <div class="lg">
          <div class="lg__row">
            <div class="lg__lbl" id="nr-type-lbl">Type</div>
            <div class="lg__ctl">
              <div class="seg wrap seg--type" role="group" aria-labelledby="nr-type-lbl">
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

          @if (!draft.type) {
            <p class="lg__wait">Pick a type. The matching fields appear below.</p>
          }

          @if (draft.type) {
            @if (draft.type === 'bug' || draft.type === 'enh') {
              <div class="lg__row rev">
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
                      [placeholder]="
                        customApp() ? 'Type the app name' : 'Search apps, or pick Other'
                      "
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
              <div class="lg__row rev">
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

            <div class="lg__row rev">
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
              <div class="lg__row rev">
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
              <div class="lg__row rev">
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
              <div class="lg__row rev">
                <div class="lg__lbl" id="nr-reach-lbl">Who's affected</div>
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
              <div class="lg__row rev">
                <div class="lg__lbl" id="nr-impact-lbl">Impact</div>
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

            <div class="lg__row rev">
              <div class="lg__lbl">Attachments<span class="lg__opt">Optional</span></div>
              <div class="lg__ctl"><sf-attach-field source="describe" [zone]="true" /></div>
            </div>

            <div class="lg__foot rev">
              @if (missing().length) {
                <span class="lg__need">Still needed: {{ missing().join(' · ') }}</span>
              }
              <button
                class="btn primary lg"
                [disabled]="!canContinue() || saving()"
                (click)="continue_()"
              >
                {{ saving() ? 'Saving…' : 'Continue' }} <span class="kbd">{{ kbdLabel }}</span>
              </button>
            </div>
          }
        </div>
      </div>
    </sub-shell>
  `,
  styles: `
    .hero {
      padding: 8px 0 6px;
    }
    .hero__t {
      font-size: 38px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-top: 12px;
    }
    .hero__s {
      margin: 9px 0 0;
      font-size: 15px;
      color: var(--muted);
      max-width: 52ch;
    }
    .lg {
      counter-reset: lgrow;
      margin-top: 26px;
    }
    .lg__row {
      display: grid;
      grid-template-columns: 190px 1fr;
      gap: 22px;
      padding: 20px 0;
      border-bottom: 1px solid var(--hairline);
      counter-increment: lgrow;
    }
    .lg__lbl {
      font-size: 13.5px;
      font-weight: 600;
      color: var(--fg1);
      padding-top: 9px;
      margin: 0;
    }
    .lg__lbl::before {
      content: counter(lgrow, decimal-leading-zero);
      display: block;
      font-family: var(--mono);
      font-size: 10.5px;
      letter-spacing: 0.09em;
      color: var(--faint);
      margin-bottom: 5px;
      transition: color var(--dur) var(--ease);
    }
    .lg__row:focus-within .lg__lbl::before {
      color: var(--accent-tx);
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
    .lg__ctl textarea.input {
      min-height: 132px;
      font-size: 15.5px;
    }
    .lg__wait {
      margin: 0;
      padding: 26px 0;
      font-size: 13.5px;
      color: var(--faint);
    }
    .lg__foot {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 18px;
      padding: 22px 0;
    }
    .lg__need {
      margin-right: auto;
      font-size: 12.5px;
      color: var(--faint);
    }
    @media (max-width: 640px) {
      .hero__t {
        font-size: 29px;
      }
      .lg__row {
        grid-template-columns: 1fr;
        gap: 8px;
      }
      .lg__lbl {
        padding-top: 0;
      }
      .lg__lbl::before {
        display: inline;
        margin-right: 8px;
      }
    }
    @keyframes lgrev {
      from {
        opacity: 0;
        transform: translateY(5px);
      }
    }
    .rev {
      animation: lgrev 0.34s cubic-bezier(0.16, 1, 0.3, 1) backwards;
    }
    .rev:nth-child(3) {
      animation-delay: 35ms;
    }
    .rev:nth-child(4) {
      animation-delay: 70ms;
    }
    .rev:nth-child(5) {
      animation-delay: 105ms;
    }
    .rev:nth-child(6) {
      animation-delay: 140ms;
    }
    .rev:nth-child(7) {
      animation-delay: 175ms;
    }
    .rev:nth-child(8) {
      animation-delay: 210ms;
    }
    @media (prefers-reduced-motion: reduce) {
      .rev {
        animation: none;
      }
    }
    .seg.wrap {
      flex-wrap: wrap;
    }
    .seg--type button {
      padding: 8px 17px;
      font-size: 13.5px;
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

  /** platform-correct hint for the submit shortcut shown in the Continue button */
  readonly kbdLabel = /Mac|iP(hone|ad|od)/.test(globalThis.navigator?.platform ?? '')
    ? '⌘↵'
    : 'Ctrl↵';

  kbdSubmit() {
    if (this.canContinue() && !this.saving()) this.continue_();
  }

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
  /** required fields not filled yet — everything except attachments is compulsory */
  missing(): string[] {
    const d = this.draft;
    const m: string[] = [];
    if ((d.type === 'bug' || d.type === 'enh') && !d.appId && !d.appName.trim())
      m.push('Application');
    if (d.type === 'new' && !d.newName.trim()) m.push('Name');
    if (!d.desc.trim()) m.push('Description');
    if (d.type === 'bug') {
      if (!d.bugWhere.trim()) m.push('Where seen');
      if (!d.bugFreq) m.push('Frequency');
    } else {
      if (!d.reach && !d.reachText.trim()) m.push("Who's affected");
      if (!d.impactMetric || !d.impactValue.trim()) m.push('Impact');
    }
    return m;
  }
  canContinue() {
    return !!this.draft.type && this.missing().length === 0;
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
