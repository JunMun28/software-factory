import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

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
  feed: '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.5"/>',
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
  chevLeft: '<path d="m15 18-6-6 6-6"/>',
  chevUp: '<path d="m6 15 6-6 6 6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  bug: '<rect x="8" y="7" width="8" height="12" rx="4"/><path d="M12 3v4M5 9h3M16 9h3M4.5 14H8M16 14h3.5M6 19l2-2M18 19l-2-2"/>',
  spark: '<path d="m12 3 1.9 5.2L19 10l-5.1 1.8L12 17l-1.9-5.2L5 10l5.1-1.8z"/>',
  app: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  mute: '<path d="M6 9v6M10 5c2 0 2.5 2 2.5 4.5S13 14 15 15H4"/><path d="M3 3l18 18"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
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
    viewBox="0 0 18 18"
    style="flex:0 0 auto;display:block"
    aria-hidden="true"
  >
    @for (x of g; track x) {
      @for (y of g; track y) {
        <circle [attr.cx]="x" [attr.cy]="y" r="1.55" [attr.fill]="color()" />
      }
    }
  </svg>`,
})
export class Mark {
  size = input<number>(20);
  color = input<string>('var(--a500)');
  g = [3.5, 9, 14.5];
}

@Component({
  selector: 'sf-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="avatar" [class.sm]="sm()" [class.lg]="lg()" [style.background]="color()"
    ><ng-content
  /></span>`,
})
export class Avatar {
  color = input<string>('#7A6E9A');
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
  selector: 'sf-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="chip" [class.solid]="solid()"><ng-content /></span>`,
})
export class Chip {
  solid = input<boolean>(false);
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
  label = computed(
    () =>
      (
        ({ bug: 'Bug fix', enh: 'Enhancement', new: 'New app', other: 'Other' }) as Record<
          string,
          string
        >
      )[this.t()] ?? this.t(),
  );
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

/* ---- sf-pop-menu — the one floating options panel (plan 004) ---- */
@Component({
  selector: 'sf-pop-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <span class="pop__scrim" (click)="closed.emit()"></span>
      <span
        class="pop"
        [style.width]="width() === 'fill' ? null : width() + 'px'"
        [class.pop--fill]="width() === 'fill'"
        [style.left]="align() === 'left' || width() === 'fill' ? '0' : null"
        [style.right]="align() === 'right' || width() === 'fill' ? '0' : null"
      >
        <ng-content />
      </span>
    }
  `,
  host: { '(document:keydown.escape)': 'open() && closed.emit()' },
})
export class PopMenu {
  open = input.required<boolean>();
  width = input<number | 'fill'>(200);
  align = input<'left' | 'right'>('right');
  closed = output<void>();
}

export const KIT = [Glyph, Icon, Mark, Avatar, Pill, Chip, TypeChip, Sig, PopMenu] as const;
