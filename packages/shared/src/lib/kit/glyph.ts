import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

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
