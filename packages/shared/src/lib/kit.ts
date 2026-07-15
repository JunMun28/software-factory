import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import { FactoryRequest } from './models';
import { TYPE_LABEL, confirmSteps } from './util';

/** Reliable focus for dynamically-inserted inputs (the `autofocus` attribute only
 *  works at document parse time, not for @if-rendered overlays). */
@Directive({ selector: '[sfAutofocus]' })
export class Autofocus {
  constructor() {
    const el = inject(ElementRef);
    afterNextRender(() => el.nativeElement.focus());
  }
}

/* ---- status-type glyph: shape carries the type, colour second ----
   dotted = Intake/early · ring = in-progress (fill = position) ·
   check = done · strike = cancelled · flag = needs-human */
@Component({
  selector: 'sf-glyph',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (type() === 'ring') {
      <svg
        class="glyph"
        [attr.width]="size()"
        [attr.height]="size()"
        [attr.viewBox]="vb()"
        fill="none"
        [attr.stroke]="color()"
        [attr.stroke-width]="sw()"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <circle [attr.cx]="c()" [attr.cy]="c()" [attr.r]="r()" stroke-opacity="0.28" />
        <circle
          [attr.cx]="c()"
          [attr.cy]="c()"
          [attr.r]="r()"
          [attr.stroke-dasharray]="dash()"
          [attr.transform]="rot()"
        />
      </svg>
    } @else if (type() === 'flag') {
      <svg
        class="glyph"
        [attr.width]="size()"
        [attr.height]="size()"
        [attr.viewBox]="vb()"
        fill="none"
        [attr.stroke]="color()"
        [attr.stroke-width]="sw()"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path [attr.d]="flagPole()" />
        <path [attr.d]="flagBody()" [attr.fill]="color()" fill-opacity="0.9" stroke="none" />
      </svg>
    } @else {
      <svg
        class="glyph"
        [attr.width]="size()"
        [attr.height]="size()"
        [attr.viewBox]="vb()"
        fill="none"
        [attr.stroke]="color()"
        [attr.stroke-width]="sw()"
        stroke-linecap="round"
        [attr.stroke-dasharray]="type() === 'dotted' ? '1.5 3' : null"
        aria-hidden="true"
      >
        <circle [attr.cx]="c()" [attr.cy]="c()" [attr.r]="r()" />
        @if (type() === 'check') {
          <path [attr.d]="checkPath()" stroke-dasharray="none" />
        }
        @if (type() === 'strike') {
          <path [attr.d]="strikePath()" stroke-dasharray="none" />
        }
      </svg>
    }
  `,
})
export class Glyph {
  type = input<string>('dotted');
  size = input<number>(18);
  color = input<string>('currentColor');
  fill = input<number>(0.45);
  sw = computed(() => 2);

  c = computed(() => this.size() / 2);
  r = computed(() => this.size() / 2 - this.sw() / 2 - 0.5);
  vb = computed(() => `0 0 ${this.size()} ${this.size()}`);
  dash = computed(() => {
    const circ = 2 * Math.PI * this.r();
    return `${circ * Math.max(0.06, this.fill())} ${circ}`;
  });
  rot = computed(() => `rotate(-90 ${this.c()} ${this.c()})`);
  checkPath = computed(() => {
    const c = this.c(),
      r = this.r();
    return `M${c - r * 0.46} ${c + r * 0.02} l${r * 0.34} ${r * 0.42} l${r * 0.66} -${r * 0.74}`;
  });
  strikePath = computed(() => {
    const c = this.c(),
      r = this.r();
    return `M${c - r * 0.66} ${c + r * 0.66} L${c + r * 0.66} ${c - r * 0.66}`;
  });
  flagPole = computed(() => {
    const c = this.c(),
      r = this.r();
    return `M${c - r} ${c - r - 0.5} L${c - r} ${c + r + 1}`;
  });
  flagBody = computed(() => {
    const c = this.c(),
      r = this.r();
    return `M${c - r} ${c - r - 0.5} h${r * 1.6} l-${r * 0.5} ${r * 0.55} l${r * 0.5} ${r * 0.55} h-${r * 1.6}`;
  });
}

/* ---- UI line icons (Lucide-spec, 1.75px, 24-grid) ---- */
const ICONS: Record<string, string> = {
  board:
    '<rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="11" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  inbox:
    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.5A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.5Z"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  search: '<circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  chevRight: '<path d="m9 18 6-6-6-6"/>',
  chevUp: '<path d="m6 15 6-6 6 6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  bug: '<rect x="8" y="7" width="8" height="12" rx="4"/><path d="M12 3v4M5 9h3M16 9h3M4.5 14H8M16 14h3.5M6 19l2-2M18 19l-2-2"/>',
  spark: '<path d="m12 3 1.9 5.2L19 10l-5.1 1.8L12 17l-1.9-5.2L5 10l5.1-1.8z"/>',
  app: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  mute: '<path d="M6 9v6M10 5c2 0 2.5 2 2.5 4.5S13 14 15 15H4"/><path d="M3 3l18 18"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  command:
    '<path d="M15 6a3 3 0 1 1 3 3h-3V6zm0 12a3 3 0 1 0 3-3h-3v3zM9 6a3 3 0 1 0-3 3h3V6zm0 12a3 3 0 1 1-3-3h3v3zM9 9h6v6H9z"/>',
  back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m21 15-4.5-4.5L7 20"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.3a3 3 0 0 1 5.6 1.3c0 2-3 2.4-3 4M12 17h.01"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  pipeline: '<path d="M2.5 12h6M15.5 12h6"/><path d="M12 9.2 14.8 12 12 14.8 9.2 12z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  maximize:
    '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  target:
    '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
};

@Component({
  selector: 'sf-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
    viewBox="0 0 24 24"
    [attr.width]="size()"
    [attr.height]="size()"
    fill="none"
    stroke="currentColor"
    [attr.stroke-width]="sw()"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    [innerHTML]="paths()"
  ></svg>`,
  host: {
    '[style.display]': '"inline-flex"',
    '[style.color]': 'color() || null',
    '[style.flex]': '"0 0 auto"',
  },
})
export class Icon {
  private sanitizer = inject(DomSanitizer);
  name = input.required<string>();
  size = input<number>(18);
  sw = input<number>(1.75);
  color = input<string>('');
  paths = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(ICONS[this.name()] ?? ''),
  );
}

/* ---- the factory mark — micron-dot square (nods to wafer motif) ---- */
@Component({
  selector: 'sf-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
    [attr.width]="size()"
    [attr.height]="size()"
    viewBox="0 0 48 48"
    style="flex:0 0 auto;display:block"
    aria-hidden="true"
  >
    <path
      d="M38 11 H17 a5.5 5.5 0 0 0 0 11 h14 a5.5 5.5 0 0 1 0 11 H10"
      fill="none"
      [attr.stroke]="color() || 'currentColor'"
      stroke-width="6"
      stroke-linecap="round"
    />
    <circle cx="10" cy="33" r="4.5" [attr.fill]="color() || 'var(--a500)'" />
  </svg>`,
})
/** "Stacked S" brand mark: one continuous production line bent into the initial,
 *  with the accent dot as the part coming off the end. `color` is a mono override
 *  (e.g. #fff inside accent chips); left empty the S inherits currentColor and the
 *  dot stays accent. */
export class Mark {
  size = input<number>(20);
  color = input<string>('');
}

@Component({
  selector: 'sf-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="avatar" [class.sm]="sm()" [class.lg]="lg()" [style.background]="color()"
    ><ng-content
  /></span>`,
})
export class Avatar {
  color = input<string>('var(--avatar)');
  sm = input<boolean>(false);
  lg = input<boolean>(false);
}

@Component({
  selector: 'sf-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Glyph],
  template: `<span class="pill" [class]="'pill ' + tone()">
    @if (glyph()) {
      <sf-glyph [type]="glyph()!" [size]="13" [color]="glyphColor()" [fill]="fill()" />
    }
    <ng-content />
  </span>`,
})
export class Pill {
  tone = input<string>('neutral');
  glyph = input<string | null>(null);
  fill = input<number>(0.45);
  glyphColor = computed(
    () =>
      (
        ({
          purple: 'var(--a600)',
          green: 'var(--green)',
          amber: 'var(--amber)',
          red: 'var(--red)',
        }) as Record<string, string>
      )[this.tone()] ?? 'var(--muted)',
  );
}

@Component({
  selector: 'sf-type-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `<span class="chip" [class.solid]="solid()"
    ><sf-icon [name]="icon()" [size]="12" />{{ label() }}</span
  >`,
})
export class TypeChip {
  t = input.required<string>();
  solid = input<boolean>(false);
  icon = computed(
    () =>
      (({ bug: 'bug', enh: 'spark', new: 'app', other: 'help' }) as Record<string, string>)[
        this.t()
      ] ?? 'help',
  );
  label = computed(() => TYPE_LABEL[this.t()] ?? this.t());
}

@Component({
  selector: 'sf-track-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <button
      type="button"
      class="tchip"
      [class.tchip--unsure]="state() === 'unsure'"
      [class.tchip--pulse]="state() === 'pulse'"
      (click)="correct.emit()"
      [attr.aria-label]="
        state() === 'unsure' ? 'Choose the request type' : 'Change the request type'
      "
    >
      @if (state() === 'unsure') {
        <sf-icon name="help" [size]="12" />
        <span class="tchip__t">What kind of request is this?</span>
      } @else {
        <sf-icon [name]="icon()" [size]="12" />
        <span class="tchip__t">{{ label() }}</span>
      }
      <span class="tchip__edit">change</span>
    </button>
  `,
  styles: `
    .tchip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(--body);
      font-size: 12.5px;
      color: var(--fg1);
      background: var(--accent-tint);
      border: 1px solid var(--accent-tint-bd);
      border-radius: 999px;
      padding: 5px 12px;
      cursor: pointer;
      transition:
        border-color var(--dur) var(--ease),
        box-shadow var(--dur) var(--ease);
    }
    .tchip:hover {
      border-color: var(--accent);
    }
    .tchip--unsure {
      background: var(--surface-2);
      border-color: var(--border-strong);
      color: var(--muted);
    }
    .tchip__edit {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--faint);
      margin-left: 4px;
    }
    .tchip--pulse {
      animation: tchip-pulse 1.2s ease-in-out 3;
    }
    @keyframes tchip-pulse {
      50% {
        box-shadow: 0 0 0 4px var(--accent-tint);
        border-color: var(--accent);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .tchip--pulse {
        animation: none;
      }
    }
  `,
})
export class TrackChip {
  t = input.required<string>();
  state = input<'confident' | 'unsure' | 'pulse'>('confident');
  correct = output<void>();
  icon = computed(
    () =>
      (({ bug: 'bug', enh: 'spark', new: 'app', other: 'help' }) as Record<string, string>)[
        this.t()
      ] ?? 'help',
  );
  label = computed(() => TYPE_LABEL[this.t()] ?? this.t());
}

/* signal badge — the loud gate / needs-human marker */
@Component({
  selector: 'sf-sig',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Glyph],
  template: `<span [class]="'sig ' + tone()">
    @if (glyph()) {
      <sf-glyph
        [type]="glyph()!"
        [size]="13"
        [color]="tone() === 'red' ? 'var(--red)' : 'var(--amber)'"
        [fill]="0.5"
      />
    }
    <ng-content />
    @if (kbd()) {
      <kbd class="kbd">{{ kbd() }}</kbd>
    }
  </span>`,
})
export class Sig {
  tone = input<string>('amber');
  glyph = input<string | null>(null);
  kbd = input<string | null>(null);
}

/* ---- gate UI — the irreversible-action modals (floor/dossier consume these) ---- */

/** The "Approve this merge/spec?" confirmation — the one intentional friction point. */
@Component({
  selector: 'sf-approve-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div
      class="palette-scrim"
      style="align-items:center;padding-top:0;z-index:50"
      (click)="cancelled.emit()"
    >
      <div
        class="palette"
        style="width:460px;padding:22px 24px;align-self:center"
        (click)="$event.stopPropagation()"
      >
        <h3 style="font-size:19px;margin-bottom:8px">
          {{ r().gate === 'approve_merge' ? 'Approve this merge?' : 'Approve this spec?' }}
        </h3>
        <p style="font-size:14px;color:var(--muted);margin:0 0 4px">
          Approving <b style="color:var(--fg1)">{{ r().title }}</b> is irreversible. It will:
        </p>
        <ul
          style="margin:12px 0 16px;padding:0;list-style:none;display:flex;flex-direction:column;gap:9px"
        >
          @for (step of steps(); track $index) {
            <li class="row" style="gap:10px;font-size:13.5px">
              <span
                style="width:20px;height:20px;border-radius:50%;background:var(--a50);display:flex;align-items:center;justify-content:center;flex:0 0 auto"
                ><sf-icon name="check" [size]="12" color="var(--a600)"
              /></span>
              <span
                ><b style="font-weight:600">{{ step[0] }}</b>
                <span class="mono" style="font-size:12px;color:var(--muted);margin-left:6px">{{
                  step[1]
                }}</span></span
              >
            </li>
          }
        </ul>
        <div class="row" style="gap:9px;justify-content:flex-end">
          <button class="btn" (click)="cancelled.emit()">Cancel</button>
          <button class="btn primary" (click)="approved.emit()">
            {{ r().gate === 'approve_merge' ? 'Approve & deploy' : 'Approve & start build' }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class ApproveModal {
  r = input.required<FactoryRequest>();
  cancelled = output<void>();
  approved = output<void>();
  steps = computed(() => confirmSteps(this.r()));
}

/** The "Send back to {reporter}?" modal — emits the blocking question. */
@Component({
  selector: 'sf-send-back-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Autofocus],
  template: `
    <div
      class="palette-scrim"
      style="align-items:center;padding-top:0;z-index:50"
      (click)="cancelled.emit()"
    >
      <div
        class="palette"
        style="width:460px;padding:22px 24px;align-self:center"
        (click)="$event.stopPropagation()"
      >
        <h3 style="font-size:19px;margin-bottom:8px">Send back to {{ reporter() }}?</h3>
        @if (hint()) {
          <p style="font-size:14px;color:var(--muted);margin:0 0 10px">{{ hint() }}</p>
        }
        <textarea
          sfAutofocus
          class="input area"
          [placeholder]="placeholder()"
          [(ngModel)]="note"
          style="margin-bottom:14px"
        ></textarea>
        <div class="row" style="gap:9px;justify-content:flex-end">
          <button class="btn" (click)="cancelled.emit()">Cancel</button>
          <button class="btn primary" [disabled]="!note.trim()" (click)="sent.emit(note.trim())">
            Send back
          </button>
        </div>
      </div>
    </div>
  `,
})
export class SendBackModal {
  reporter = input.required<string>();
  hint = input<string | null>(null);
  placeholder = input<string>("What's the one question blocking the spec?");
  cancelled = output<void>();
  sent = output<string>();
  note = '';
}

/** Confirmation for a recovery action whose blast radius must be read first. */
@Component({
  selector: 'sf-recovery-confirm',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="palette-scrim"
      style="align-items:center;padding-top:0;z-index:50"
      (click)="kept.emit()"
    >
      <div
        class="palette"
        style="width:430px;padding:22px 24px;align-self:center"
        (click)="$event.stopPropagation()"
      >
        <h3 style="font-size:19px;margin-bottom:8px">{{ title() }}</h3>
        <p style="font-size:14px;color:var(--muted);margin:0 0 16px">{{ consequence() }}</p>
        <div class="row" style="gap:9px;justify-content:flex-end">
          <button class="btn" (click)="kept.emit()">Keep it stopped</button>
          <button class="btn primary" (click)="confirmed.emit()">{{ confirmLabel() }}</button>
        </div>
      </div>
    </div>
  `,
})
export class RecoveryConfirm {
  title = input.required<string>();
  consequence = input.required<string>();
  confirmLabel = input.required<string>();
  kept = output<void>();
  confirmed = output<void>();
}

/** Pick a valid earlier runner stage, explain discarded work, then require a reason. */
@Component({
  selector: 'sf-send-back-stage-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Autofocus],
  template: `
    <div
      class="palette-scrim"
      style="align-items:center;padding-top:0;z-index:50"
      (click)="cancelled.emit()"
    >
      <div
        class="palette"
        style="width:460px;padding:22px 24px;align-self:center"
        (click)="$event.stopPropagation()"
      >
        <h3 style="font-size:19px;margin-bottom:8px">Send back to…</h3>
        @if (stages().length) {
          <div class="row" style="gap:8px;margin:12px 0">
            @for (stage of stages(); track stage) {
              <button
                class="btn stage-choice"
                [class.primary]="target === stage"
                (click)="target = stage"
              >
                {{ label(stage) }}
              </button>
            }
          </div>
        } @else {
          <p style="font-size:14px;color:var(--muted);margin:12px 0">
            This is already the earliest stage — there's nothing earlier to send it back to. Use
            Retry or Take over instead.
          </p>
        }
        @if (target) {
          <p style="font-size:14px;color:var(--muted);margin:0 0 12px">
            Discards the work after {{ label(target) }} and redoes that stage.
          </p>
          <textarea
            sfAutofocus
            class="input area"
            placeholder="Why does this stage need redoing?"
            [(ngModel)]="reason"
            style="margin-bottom:14px"
          ></textarea>
        }
        <div class="row" style="gap:9px;justify-content:flex-end">
          <button class="btn" (click)="cancelled.emit()">Cancel</button>
          <button class="btn primary" [disabled]="!target || !reason.trim()" (click)="send()">
            Send back
          </button>
        </div>
      </div>
    </div>
  `,
})
export class SendBackStageModal {
  currentStage = input.required<FactoryRequest['stage']>();
  cancelled = output<void>();
  sent = output<{ stage: 'architecture' | 'build' | 'review'; reason: string }>();
  target: 'architecture' | 'build' | 'review' | null = null;
  reason = '';
  stages = computed(() => {
    const stages = ['architecture', 'build', 'review'] as const;
    const here = stages.indexOf(this.currentStage() as (typeof stages)[number]);
    // Only strictly-earlier pipeline stages are valid targets. A request stalled
    // before the pipeline (indexOf === -1, e.g. at 'spec') has none.
    return here <= 0 ? [] : stages.slice(0, here);
  });
  label(stage: string) {
    return stage === 'architecture' ? 'Architecture' : stage[0].toUpperCase() + stage.slice(1);
  }
  send() {
    if (this.target && this.reason.trim())
      this.sent.emit({ stage: this.target, reason: this.reason.trim() });
  }
}

/** Cancel is irreversible too — every surface confirms through this one modal. */
@Component({
  selector: 'sf-cancel-confirm',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="palette-scrim"
      style="align-items:center;padding-top:0;z-index:50"
      (click)="kept.emit()"
    >
      <div
        class="palette"
        style="width:420px;padding:22px 24px;align-self:center"
        (click)="$event.stopPropagation()"
      >
        <h3 style="font-size:19px;margin-bottom:8px">Cancel this request?</h3>
        <p style="font-size:14px;color:var(--muted);margin:0 0 16px">
          Abandons the request and closes its PR.
          <b style="color:var(--fg1)">{{ r().title }}</b> will be closed as won't-do and
          {{ r().reporter }} will be notified.
        </p>
        <div class="row" style="gap:9px;justify-content:flex-end">
          <button class="btn" (click)="kept.emit()">Keep it</button>
          <button class="btn danger" (click)="confirmed.emit()">Cancel request</button>
        </div>
      </div>
    </div>
  `,
})
export class CancelConfirm {
  r = input.required<FactoryRequest>();
  kept = output<void>();
  confirmed = output<void>();
}
