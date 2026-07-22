import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { Theme } from '../theme.service';

/* ---- the ignition glyph field ----
   A canvas of monospace glyphs lit by a glow rising from below the frame: the
   intake hero's ambient depth, carried onto the console Overview so the two
   faces read as one product.

   How it works: the scene (a radial gradient, dark or light) is painted once at
   one-pixel-per-cell into an offscreen canvas, then read back. Each cell's alpha
   picks a glyph tier — heavy ink where the glow is strong, punctuation where it
   crumbles — and its rgb becomes the glyph's colour. The same offscreen scene is
   also drawn back blurred as a soft underlay, which is what makes it read as
   light rather than as text. */

const CELL_W = 21;
const CELL_H = 17;

/** Glyph choices per intensity tier — bright cells get heavy-ink glyphs, dim
 *  cells crumble into punctuation. Each tier is a wide alphabet of roughly equal
 *  ink weight, so the tier carries the density and the pick only has to look
 *  unrepeating. */
const TIERS: readonly [number, readonly string[]][] = [
  [0.78, ['A', 'R', '8', '#', '@', 'B', '%', 'W', 'N', '&']],
  [0.58, ['A', 'R', '#', '8', '0', '&', 'K', 'H', '$']],
  [0.4, ['#', '8', '0', 'A', 'X', 'E', 'S', 'P', '6']],
  [0.24, ['X', '8', '0', '+', 'x', 'v', 'z', 'c', '7']],
  [0.1, ['+', '=', '·', 'x', '-', ':', '~', "'", ',']],
];

/** Stable per-cell noise — no Math.random, so a repaint never reshuffles the
 *  field and a resize does not make it crawl. */
function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

@Component({
  selector: 'sf-glyph-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<canvas #cv aria-hidden="true"></canvas>`,
  styles: `
    /* height is left overridable so a host can confine the field to a band and
       mask it out before it reaches dense content */
    :host {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 100%;
      z-index: 0;
      overflow: hidden;
      pointer-events: none;
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
  `,
})
export class GlyphField implements OnDestroy {
  private theme = inject(Theme);
  private host = inject(ElementRef<HTMLElement>);
  // not `.required` — the theme effect runs before the view exists, and a
  // required query throws rather than returning undefined
  private cv = viewChild<ElementRef<HTMLCanvasElement>>('cv');
  private ro?: ResizeObserver;

  /** Where the glow sits, as a fraction of height below the frame. Lower values
   *  pull the light up into the content. */
  origin = input(1.52);
  /** Scales every alpha. 1 is the intake hero's strength, which is tuned for a
   *  mostly-empty band; behind dense content it has to come well down or the
   *  glyphs compete with the data. */
  intensity = input(1);

  constructor() {
    afterNextRender(() => {
      this.paint();
      // repaint on resize — the field is sized in cells, so it must be redrawn
      // rather than stretched, or the glyphs smear
      this.ro = new ResizeObserver(() => this.paint());
      this.ro.observe(this.host.nativeElement);
    });
    // the palette is theme-dependent, so a toggle has to repaint
    effect(() => {
      this.theme.resolved();
      this.paint();
    });
  }

  ngOnDestroy() {
    this.ro?.disconnect();
  }

  private paint() {
    const canvas = this.cv?.()?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // test environments have no canvas backend
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;

    const dark = document.documentElement.dataset['theme'] === 'dark';
    const dpr = globalThis.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cols = Math.ceil(w / CELL_W);
    const rows = Math.ceil(h / CELL_H);
    const off = document.createElement('canvas');
    off.width = cols;
    off.height = rows;
    const o = off.getContext('2d');
    if (!o) return;
    this.scene(o, cols, rows, dark);
    const px = o.getImageData(0, 0, cols, rows).data;

    const k = this.intensity();

    // soft luminous underlay: the same scene, blurred way up
    ctx.save();
    ctx.filter = 'blur(48px)';
    ctx.globalAlpha = (dark ? 0.5 : 0.16) * k;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, cols, rows, 0, 0, w, h);
    ctx.restore();

    const aBase = (dark ? 0.35 : 0.3) * k;
    const aSpan = (dark ? 0.65 : 0.5) * k;
    const mono = getComputedStyle(canvas).getPropertyValue('--mono') || 'monospace';
    ctx.font = `600 12px ${mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 4;
        const a = px[i + 3] / 255;
        if (a < 0.1) continue;
        if (hash(c, r) < 0.07) continue; // a few gaps, even when dense
        if (hash(c * 7 + 13, r * 3 + 5) < (0.8 - a) * 0.5) continue; // crumble as it dims
        const tier = TIERS.find(([t]) => a >= t);
        if (!tier) continue;
        const chars = tier[1];
        const ch = chars[Math.floor(hash(c * 31 + 7, r * 17 + 3) * chars.length)];
        ctx.fillStyle = `rgba(${px[i]},${px[i + 1]},${px[i + 2]},${(aBase + aSpan * a).toFixed(3)})`;
        ctx.fillText(ch, c * CELL_W + CELL_W / 2, r * CELL_H + CELL_H / 2);
      }
    }
  }

  /** The scene the glyphs sample: a glow rising from below the frame — dark:
   *  cream core → magenta → violet on graphite; light: a quiet orchid tint so
   *  the field whispers on the pale canvas rather than dirtying it. */
  private scene(o: CanvasRenderingContext2D, w: number, h: number, dark: boolean) {
    const oy = h * this.origin();
    const g = o.createRadialGradient(w * 0.5, oy, 0, w * 0.5, oy, h * 1.5);
    if (dark) {
      g.addColorStop(0.36, 'rgba(255,233,214,.97)');
      g.addColorStop(0.46, 'rgba(225,115,250,.92)');
      g.addColorStop(0.58, 'rgba(189,3,247,.8)');
      g.addColorStop(0.7, 'rgba(75,22,224,.5)');
      g.addColorStop(0.86, 'rgba(40,14,96,0)');
    } else {
      g.addColorStop(0.36, 'rgba(210,59,249,.55)');
      g.addColorStop(0.46, 'rgba(225,115,250,.46)');
      g.addColorStop(0.58, 'rgba(238,166,252,.38)');
      g.addColorStop(0.7, 'rgba(246,208,254,.28)');
      g.addColorStop(0.86, 'rgba(246,208,254,0)');
    }
    o.fillStyle = g;
    o.fillRect(0, 0, w, h);
  }
}
