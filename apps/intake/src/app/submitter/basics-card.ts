import { Component, computed, inject, input, OnInit, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Api, AppEntry } from '@sf/shared';
import { IntakeDraft } from './intake-draft.service';

/** all basics answered for this request type (identity + the two facts) */
export function basicsAnswered(d: IntakeDraft, type: string | null): boolean {
  // New apps and uncategorised requests take their title from the description.
  const identity =
    type === 'new' || type === 'other' ? true : d.appId !== null || !!d.appName.trim();
  if (type === 'bug') return identity && bugEvidenceAnswered(d) && !!d.bugFreq;
  return (
    identity && (!!d.reach || !!d.reachText.trim()) && !!d.impactMetric && !!d.impactValue.trim()
  );
}

export function bugEvidenceAnswered(d: IntakeDraft): boolean {
  return (
    !!d.bugWhere.trim() ||
    d.attachments().some((a) => a.kind === 'image' || a.mime.startsWith('image/')) ||
    d.pending().some((f) => f.type.startsWith('image/'))
  );
}

/** The Clarify step's BASICS card — the fixed questions moved off the Describe
 *  step: Type, Name/Application, Who's affected + Impact (or Where seen +
 *  Frequency for bugs). Edits PATCH the request through the shared IntakeDraft;
 *  a dirty check keeps no-op blurs free. */
@Component({
  selector: 'sf-basics-card',
  imports: [FormsModule],
  template: `
    <div class="basics">
      <div class="basics__h">
        <span class="basics__t">{{ cardTitle() }}</span>
        <span class="basics__n">{{ done() }} of {{ total() }}</span>
      </div>
      <div class="brow2">
        <span class="brow2__q">Request</span>
        <span class="bseg">
          @for (t of types; track t[0]) {
            <button [class.on]="draft.type === t[0]" (click)="pickType(t[0])">
              {{ t[1] }}
            </button>
          }
        </span>
      </div>
      @if (rtype() === 'bug' || rtype() === 'enh') {
        <div class="brow2">
          <span class="brow2__q" [class.ok]="draft.appId !== null || draft.appName.trim()">
            App
          </span>
          <span class="dd-wrap">
            <input
              id="nr-app-dd"
              class="input basics__in"
              role="combobox"
              autocomplete="off"
              aria-autocomplete="list"
              aria-controls="nr-app-list"
              [attr.aria-expanded]="appsMenuOpen() && !customApp()"
              maxlength="120"
              [placeholder]="customApp() ? 'Type the app name' : appPlaceholder()"
              [ngModel]="appQuery()"
              (ngModelChange)="customApp() ? onCustomInput($event) : onAppInput($event)"
              (focus)="!customApp() && appsMenuOpen.set(true)"
              (blur)="appsMenuOpen.set(false); save()"
              (keydown.escape)="appsMenuOpen.set(false)"
            />
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
                    {{ a.name }}
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
                  @if (appQuery().trim() && !exactApp()) {
                    Add “{{ appQuery().trim() }}” as a new app
                  } @else {
                    My app isn’t listed
                  }
                </button>
              </div>
            }
          </span>
        </div>
      }
      @if (rtype() === 'bug') {
        <div class="brow2">
          <span class="brow2__q" [class.ok]="bugEvidenceAnswered()">Evidence</span>
          <span class="evidence" (paste)="onEvidencePaste($event)">
            <input
              class="input basics__in evidence__link"
              inputmode="url"
              autocomplete="url"
              placeholder="Paste a page link"
              [(ngModel)]="draft.bugWhere"
              (blur)="save()"
            />
            <button
              type="button"
              class="evidence__add"
              (click)="screenshotInput.click()"
            >
              Add screenshot
            </button>
            <input
              #screenshotInput
              type="file"
              accept="image/*"
              hidden
              (change)="onScreenshotPick($event)"
            />
            @if (screenshots().length) {
              <span class="evidence__files">
                @for (shot of screenshots(); track shot.id) {
                  <span class="evidence__file">
                    {{ shot.filename }}
                    <button
                      type="button"
                      aria-label="Remove {{ shot.filename }}"
                      (click)="removeScreenshot(shot.id)"
                    >
                      ×
                    </button>
                  </span>
                }
              </span>
            }
            @if (draft.lastError()) {
              <span class="evidence__error" role="alert">{{ draft.lastError() }}</span>
            }
          </span>
        </div>
        <div class="brow2">
          <span class="brow2__q" [class.ok]="!!draft.bugFreq">How often?</span>
          <span class="bseg">
            @for (f of freqs; track f) {
              <button [class.on]="draft.bugFreq === f[0]" (click)="pickFreq(f[0])">
                {{ f[1] }}
              </button>
            }
          </span>
        </div>
      } @else {
        <div class="brow2">
          <span class="brow2__q" [class.ok]="!!draft.reach || draft.reachText.trim()">
            {{ audienceLabel() }}
          </span>
          <span class="bcontrols">
            <span class="bseg">
              @for (rc of reaches; track rc[0]) {
                <button
                  [class.on]="!draft.reachText && draft.reach === rc[0]"
                  (click)="pickReach(rc[0])"
                >
                  {{ rc[1] }}
                </button>
              }
            </span>
            <input
              class="input basics__in basics__in--compact"
              placeholder="Or describe the group"
              [ngModel]="draft.reachText"
              (ngModelChange)="onReachInput($event)"
              (blur)="save()"
            />
          </span>
        </div>
        <div class="brow2">
          <span class="brow2__q" [class.ok]="!!draft.impactMetric && !!draft.impactValue.trim()">
            {{ benefitLabel() }}
          </span>
          <span class="bcontrols">
            <input
              class="input basics__in basics__in--compact"
              [placeholder]="metricPlaceholder()"
              [ngModel]="draft.impactValue"
              (ngModelChange)="onImpactInput($event)"
              (blur)="save()"
            />
            <span class="bseg">
              @for (m of metrics; track m[0]) {
                <button [class.on]="draft.impactMetric === m[0]" (click)="pickMetric(m[0])">
                  {{ m[1] }}
                </button>
              }
            </span>
          </span>
        </div>
      }
    </div>
  `,
  styles: `
    .basics {
      border: 1px solid var(--border);
      background: var(--surface-2);
      border-radius: 12px;
      padding: 12px 14px;
      margin-bottom: 4px;
    }
    .basics__h {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2px;
    }
    .basics__t {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--accent-tx);
    }
    .basics__n {
      font-family: var(--mono);
      font-size: 10.5px;
      color: var(--accent-tx);
      opacity: 0.75;
    }
    .brow2 {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 0;
    }
    .brow2__q {
      flex: 0 0 96px;
      font-size: 12.5px;
      font-weight: 500;
      color: var(--fg2);
      padding-top: 5px;
    }
    .brow2__q.ok::after {
      content: ' \u2713';
      color: var(--green);
      font-weight: 700;
    }
    .bseg {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .bcontrols {
      display: flex;
      flex: 1;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .bseg button {
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid var(--border-strong);
      background: var(--surface);
      border-radius: 999px;
      color: var(--fg2);
      cursor: pointer;
      transition:
        border-color var(--dur) var(--ease),
        color var(--dur) var(--ease);
    }
    .bseg button:hover {
      border-color: var(--accent-tint-bd);
      color: var(--accent-tx);
    }
    .bseg button.on {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .evidence {
      display: flex;
      flex: 1;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .evidence__link {
      flex: 1 1 220px;
      min-width: 160px;
    }
    .evidence__add {
      min-height: 32px;
      padding: 5px 10px;
      border: 1px solid var(--border-strong);
      border-radius: var(--r);
      background: var(--surface);
      color: var(--fg2);
      font: 500 12px var(--body);
      cursor: pointer;
    }
    .evidence__add:hover {
      border-color: var(--accent-tint-bd);
      color: var(--accent-tx);
    }
    .evidence__files {
      display: flex;
      flex: 1 0 100%;
      flex-wrap: wrap;
      gap: 4px;
    }
    .evidence__file {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      padding: 3px 7px;
      border-radius: 999px;
      background: var(--surface);
      color: var(--muted);
      font-size: 11.5px;
    }
    .evidence__file button {
      border: 0;
      padding: 0;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
    }
    .evidence__error {
      flex: 1 0 100%;
      color: var(--red);
      font-size: 11.5px;
    }
    .basics__in {
      min-height: 32px;
      padding: 5px 10px;
      font-size: 13px;
    }
    .basics__in--compact {
      flex: 0 1 170px;
      min-width: 120px;
      max-width: 180px;
    }
    .dd-wrap {
      position: relative;
      display: block;
      flex: 1;
      min-width: 0;
    }
    .dd__other {
      color: var(--accent-tx);
      font-weight: 500;
    }
    .dd__empty {
      padding: 12px;
      font-size: 13px;
      color: var(--muted);
    }
  `,
})
export class BasicsCard implements OnInit {
  /** the request these basics belong to */
  id = input.required<number>();
  /** current request type — re-shapes the rows (kept fresh by the parent) */
  rtype = input<string | null>(null);
  /** the Type row changed the request type (already PATCHed) */
  typeChanged = output<string>();
  /** any basics edit was PATCHed — parents refresh what depends on the spec */
  saved = output<void>();

  draft = inject(IntakeDraft);
  private api = inject(Api);

  types: [string, string][] = [
    ['bug', 'Fix a problem'],
    ['enh', 'Improve an app'],
    ['new', 'Build a new app'],
    ['other', 'Something else'],
  ];
  freqs: [string, string][] = [
    ['Every time', 'Every time'],
    ['Most of the time', 'Usually'],
    ['Sometimes', 'Sometimes'],
    ['Only once so far', 'It happened once'],
  ];
  reaches: [string, string][] = [
    ['me', 'Only me'],
    ['team', 'My team'],
    ['dept', 'My department'],
    ['wider', 'Several departments'],
    ['site', 'One site'],
    ['network', 'Across sites'],
  ];
  metrics: [string, string][] = [
    ['hours', 'Hours saved / year'],
    ['cost', 'Cost saved / year ($k)'],
    ['other', 'Another benefit'],
  ];

  apps = signal<AppEntry[]>([]);
  appsMenuOpen = signal(false);
  appQuery = signal('');
  customApp = signal(false); // "Other" was chosen — the input is a free-text app name
  screenshots = computed(() => this.draft.attachments().filter((a) => a.kind === 'image'));
  filteredApps = computed(() => {
    const q = this.appQuery().trim().toLowerCase();
    const list = this.apps();
    return q ? list.filter((a) => a.name.toLowerCase().includes(q)) : list;
  });
  exactApp = computed(() => {
    const q = this.appQuery().trim().toLowerCase();
    return q ? (this.apps().find((a) => a.name.toLowerCase() === q) ?? null) : null;
  });

  /** recompute done() when a non-signal draft field changes */
  private rev = signal(0);
  total = computed(() => (this.rtype() === 'new' || this.rtype() === 'other' ? 2 : 3));
  done = computed(() => {
    this.rev();
    const d = this.draft;
    const t = this.rtype();
    const identity =
      t === 'new' || t === 'other' ? 0 : d.appId !== null || d.appName.trim() ? 1 : 0;
    if (t === 'bug') return identity + (bugEvidenceAnswered(d) ? 1 : 0) + (d.bugFreq ? 1 : 0);
    return (
      identity +
      (d.reach || d.reachText.trim() ? 1 : 0) +
      (d.impactMetric && d.impactValue.trim() ? 1 : 0)
    );
  });

  /** last-saved snapshot — save() is a no-op unless something changed */
  private savedSnapshot = '';
  private snapshot(): string {
    const d = this.draft;
    return JSON.stringify([
      d.type,
      d.newName,
      d.appId,
      d.appName,
      d.bugWhere,
      d.bugFreq,
      d.reach,
      d.reachText,
      d.impactMetric,
      d.impactValue,
    ]);
  }

  ngOnInit() {
    this.api.apps().subscribe((a) => this.apps.set(a.filter((x) => !x.muted)));
    this.seedFromDraft();
    // hydration may still be in flight when the card mounts (two parallel GETs) —
    // one late reseed covers the deep-link/reload race
    setTimeout(() => {
      if (!this.appQuery() && this.draft.appName) this.seedFromDraft();
      this.savedSnapshot = this.snapshot();
      this.rev.update((n) => n + 1);
    }, 500);
    this.savedSnapshot = this.snapshot();
  }
  private seedFromDraft() {
    this.appQuery.set(this.draft.appName);
    this.customApp.set(!!this.draft.appName && this.draft.appId === null);
  }

  cardTitle() {
    return {
      bug: 'Help us understand the problem',
      enh: 'Tell us about the improvement',
      new: 'Tell us who this is for',
      other: 'Add a little context',
    }[this.rtype() ?? 'new'];
  }
  appPlaceholder() {
    return this.rtype() === 'bug' ? 'Search for the app with the problem' : 'Search for the app to improve';
  }
  audienceLabel() {
    return {
      enh: 'Who benefits?',
      new: 'Who will use it?',
      other: 'Who is this for?',
    }[this.rtype() ?? 'new'];
  }
  benefitLabel() {
    return this.rtype() === 'other' ? 'Expected outcome' : 'Expected benefit';
  }
  bugEvidenceAnswered() {
    return bugEvidenceAnswered(this.draft);
  }

  /** list mode: the text is a filter; only an exact match selects a known app. */
  onAppInput(text: string) {
    this.appQuery.set(text);
    const ex = this.exactApp();
    this.draft.appId = ex ? ex.id : null;
    this.draft.appName = ex ? ex.name : '';
    this.appsMenuOpen.set(true);
  }
  /** custom mode: the text IS the new app name. */
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
    this.save();
  }
  /** "Other" — switch to free-text entry, carrying over anything already typed. */
  chooseOther() {
    this.customApp.set(true);
    this.draft.appId = null;
    this.draft.appName = this.appQuery().trim();
    this.appsMenuOpen.set(false);
  }

  pickType(t: string) {
    if (this.draft.type === t) return;
    this.draft.type = t as never;
    void this.save(true).then((didSave) => {
      if (didSave) this.typeChanged.emit(t);
    });
  }
  pickReach(r: string) {
    this.draft.reach = this.draft.reach === r && !this.draft.reachText ? null : (r as never);
    this.draft.reachText = '';
    this.save();
  }
  onReachInput(text: string) {
    this.draft.reachText = text;
    this.draft.reach = null;
    this.rev.update((n) => n + 1);
  }
  pickMetric(m: string) {
    this.draft.impactMetric = this.draft.impactMetric === m ? null : (m as never);
    this.rev.update((n) => n + 1);
    if (this.draft.impactMetric === null || this.draft.impactValue.trim()) this.save();
  }
  onImpactInput(text: string) {
    this.draft.impactValue = text;
    this.rev.update((n) => n + 1);
  }
  async onScreenshotPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    await this.uploadScreenshots(files);
  }
  async onEvidencePaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    await this.uploadScreenshots(files);
  }
  private async uploadScreenshots(files: File[]) {
    const images = files.filter(
      (file) => file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(file.name),
    );
    if (!images.length) {
      this.draft.lastError.set('Choose an image file for the screenshot.');
      return;
    }
    await this.draft.addFiles(images, 'interview');
    this.rev.update((n) => n + 1);
    await this.save(true);
  }
  async removeScreenshot(id: number) {
    await this.draft.removeAttachment(id);
    this.rev.update((n) => n + 1);
    await this.save(true);
  }
  pickFreq(f: string) {
    this.draft.bugFreq = this.draft.bugFreq === f ? '' : f;
    this.save();
  }
  metricPlaceholder() {
    if (!this.draft.impactMetric) return 'Enter estimate';
    return { hours: 'Estimated hours', cost: 'Estimated $k', other: 'Describe the benefit' }[
      this.draft.impactMetric
    ];
  }

  /** PATCH the basics onto the request; skips clean saves and un-hydrated drafts */
  async save(force = false): Promise<boolean> {
    this.rev.update((n) => n + 1);
    if (!this.draft.type || this.draft.requestId !== this.id()) return false;
    const snap = this.snapshot();
    if (!force && snap === this.savedSnapshot) return false;
    await this.draft.save();
    this.savedSnapshot = snap;
    this.saved.emit();
    return true;
  }
}
