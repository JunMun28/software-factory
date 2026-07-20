import {
  afterNextRender,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { Api, Icon } from '@sf/shared';
import { IntakeDraft } from './intake-draft.service';
import { SubShell } from './sub-shell';

/** Glyph choices per intensity tier for the hero's ignition field — bright
 *  cells get dense brand letters, dim cells crumble into punctuation. */
const FX_TIERS: readonly [number, readonly string[]][] = [
  [0.78, ['S', 'S', 'S', 'F']],
  [0.58, ['S', 'S', '#', 'F']],
  [0.4, ['#', '8', '0', 'S']],
  [0.24, ['X', '8', '0', '+']],
  [0.1, ['+', '=', '·', 'x']],
];
const FX_CELL_W = 21;
const FX_CELL_H = 17;

interface ActiveClassification {
  token: symbol;
  description: string;
}
const activeClassifications = new WeakMap<IntakeDraft, Map<number, ActiveClassification>>();

function claimClassification(draft: IntakeDraft, id: number, description: string): symbol | null {
  let runs = activeClassifications.get(draft);
  if (!runs) {
    runs = new Map<number, ActiveClassification>();
    activeClassifications.set(draft, runs);
  }
  if (runs.get(id)?.description === description) return null;
  const token = Symbol('classification');
  runs.set(id, { token, description });
  return token;
}

function ownsClassification(
  draft: IntakeDraft,
  id: number,
  token: symbol,
  description: string,
): boolean {
  const run = activeClassifications.get(draft)?.get(id);
  return (
    run?.token === token &&
    run.description === description &&
    draft.requestId === id &&
    draft.desc.trim() === description
  );
}

function releaseClassification(draft: IntakeDraft, id: number, token: symbol): void {
  const runs = activeClassifications.get(draft);
  if (!runs || runs.get(id)?.token !== token) return;
  runs.delete(id);
  if (runs.size === 0) activeClassifications.delete(draft);
}

/** Deterministic per-cell randomness — the field must not reshuffle on
 *  re-render (resize, theme flip), only recolor. */
function fxHash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** S1 — New Request: a pure describe hero — an AI-chat-style composer as the
 *  vertically-centered focal point (animated conic-gradient border, attach
 *  button with drag-drop/paste, send arrow). Files stage on the draft and
 *  upload on Continue. Everything else (type, name/application, reach, impact)
 *  lives in the Clarify step's basics card. The request is created as a New
 *  app by default; picking another type in Clarify PATCHes it.
 *  ⌘↵ / Ctrl↵ submits. */
@Component({
  selector: 'sf-new-request',
  imports: [SubShell, FormsModule, Icon],
  host: {
    '(document:keydown.meta.enter)': 'kbdSubmit()',
    '(document:keydown.control.enter)': 'kbdSubmit()',
    // the whole page is a drop target — files attach to the describe composer
    '(document:dragover)': 'onDragOver($event)',
    '(document:dragleave)': 'onDragLeave($event)',
    '(document:drop)': 'onDrop($event)',
    '(document:paste)': 'onPaste($event)',
    '(window:resize)': 'renderFx()',
  },
  template: `
    <sub-shell active="new">
      <canvas #fx class="hero-fx" aria-hidden="true"></canvas>
      <div class="sub-col pop-in" style="max-width:820px">
        <section class="hero-screen">
          <h1 class="hero__t">What should we build?</h1>
          <p class="hero__s">Put your idea into words. We’ll help turn it into a clear plan.</p>
          <div class="glow" [class.glow--over]="dragOver()">
            <div class="glow__card">
              @if (draft.attachments().length || draft.pending().length) {
                <div class="attach__chips glow__files">
                  @for (a of draft.attachments(); track a.id) {
                    <span class="attach__chip">
                      <sf-icon name="file" [size]="14" color="var(--muted)" />
                      <span class="attach__name">{{ a.filename }}</span>
                      <button
                        type="button"
                        class="attach__x"
                        (click)="draft.removeAttachment(a.id)"
                        aria-label="Remove"
                      >
                        <sf-icon name="x" [size]="12" />
                      </button>
                    </span>
                  }
                  @for (f of draft.pending(); track $index) {
                    <span class="attach__chip attach__chip--pending">
                      <sf-icon name="file" [size]="13" color="var(--faint)" />
                      <span class="attach__name">{{ f.name }}</span>
                      <button
                        type="button"
                        class="attach__x"
                        (click)="draft.removePending($index)"
                        aria-label="Remove"
                      >
                        <sf-icon name="x" [size]="12" />
                      </button>
                    </span>
                  }
                </div>
              }
              <label class="sr-only" for="nr-desc">Description</label>
              <textarea
                #descTa
                id="nr-desc"
                placeholder="Describe it in your own words…"
                [(ngModel)]="draft.desc"
                (input)="growDesc()"
              ></textarea>
              <div class="glow__row">
                <button
                  type="button"
                  class="glow__add"
                  aria-label="Attach files"
                  title="Attach files — any type, up to 100 MB each"
                  (click)="picker.click()"
                >
                  <sf-icon name="plus" [size]="17" />
                </button>
                <button
                  type="button"
                  class="glow__send"
                  [attr.aria-label]="'Continue (' + kbdLabel + ')'"
                  [title]="'Continue (' + kbdLabel + ')'"
                  [disabled]="saving()"
                  (click)="send()"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="17"
                    height="17"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              </div>
              <input #picker type="file" multiple hidden (change)="onPick($event)" />
            </div>
          </div>
          @if (draft.lastError()) {
            <p class="attach__err">{{ draft.lastError() }}</p>
          }
          <span class="hint">{{
            saving() ? 'Saving…' : 'Press ' + kbdLabel + ' to continue'
          }}</span>
        </section>
      </div>
    </sub-shell>
  `,
  styles: `
    @property --ang {
      syntax: '<angle>';
      inherits: false;
      initial-value: 0deg;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
    }
    .hero-screen {
      position: relative;
      isolation: isolate;
      /* 188px = top bar (74) + .sub-col vertical padding (34 + 80): the
         hero fits the scroll host exactly, so the page has no scrollbars
         until the composer grows past one screen of text */
      min-height: calc(100dvh - 188px);
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      padding: 8px 0 26px;
    }
    /* Ambient depth: the "Ignition" glyph field (mockups/hero-ascii-bg v3) —
       a canvas of monospace glyphs whose glow rises from the bottom edge and
       dissolves before the composer, which sits in a cleared pocket.
       Viewport-fixed and out of the scroll flow: it always reaches the
       page's bottom edge and can never create scrollbars (the scene is
       empty near the top, so nothing paints over the top bar). It sits
       OUTSIDE .pop-in — that animation's transform would hijack a fixed
       child's containing block. Explicit width/height because a canvas is
       a replaced element — inset alone won't stretch it. Static,
       decorative; redrawn on resize and theme change. */
    .hero-fx {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100dvh;
      pointer-events: none;
    }
    /* lift the content above the viewport-fixed canvas layer */
    .sub-col {
      position: relative;
      z-index: 1;
    }
    .hero__t {
      font-size: clamp(32px, 4.8vw, 50px);
      font-weight: 800;
      letter-spacing: -0.02em;
      line-height: 1.04;
      margin: 14px 0 6px;
    }
    .hero__s {
      margin: 0 0 28px;
      font-size: 15px;
      color: var(--muted);
      max-width: 44ch;
    }
    .glow {
      width: 100%;
      max-width: 640px;
      border-radius: 20px;
      padding: 2px;
      background: conic-gradient(
        from var(--ang, 0deg),
        #bd03f7,
        #4b16e0,
        #22d3ee,
        #e173fa,
        #bd03f7
      );
      animation: nr-spin 6s linear infinite;
      box-shadow: 0 0 40px -12px rgba(189, 3, 247, 0.5);
      transition: box-shadow var(--dur-s) var(--ease);
    }
    .glow:focus-within {
      box-shadow: 0 0 56px -10px rgba(189, 3, 247, 0.65);
    }
    .glow:hover:not(:focus-within) {
      box-shadow: 0 0 48px -11px rgba(189, 3, 247, 0.58);
    }
    @keyframes nr-spin {
      to {
        --ang: 360deg;
      }
    }
    .glow__card {
      background: var(--surface);
      border-radius: 18px;
      padding: 16px 16px 10px;
      text-align: left;
    }
    .glow__card textarea {
      width: 100%;
      border: none;
      background: none;
      resize: none;
      overflow: hidden;
      outline: none;
      padding: 6px;
      min-height: 104px;
      font-family: inherit;
      font-size: 16px;
      line-height: 1.55;
      color: var(--fg1);
    }
    .glow__card textarea::placeholder {
      color: var(--faint);
    }
    .glow__row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding-top: 8px;
    }
    .glow--over {
      box-shadow: 0 0 56px -6px rgba(189, 3, 247, 0.7);
    }
    .glow__files {
      margin: 2px 4px 10px;
    }
    .glow__add {
      flex: 0 0 auto;
      width: 34px;
      height: 34px;
      border-radius: 10px;
      border: 1px solid transparent;
      background: none;
      color: var(--muted);
      display: grid;
      place-items: center;
      cursor: pointer;
      transition:
        background var(--dur) var(--ease),
        color var(--dur) var(--ease),
        border-color var(--dur) var(--ease);
    }
    .glow__add:hover {
      background: var(--surface-2);
      color: var(--fg1);
    }
    .glow__add:focus-visible {
      border-color: var(--a400);
      outline: 2px solid var(--a200);
      outline-offset: 2px;
    }
    .glow__send {
      flex: 0 0 auto;
      width: 38px;
      height: 38px;
      border-radius: 12px;
      border: none;
      background: var(--accent);
      color: #fff;
      display: grid;
      place-items: center;
      cursor: pointer;
      transition:
        background var(--dur) var(--ease),
        transform var(--dur-i) var(--ease);
    }
    .glow__send:hover {
      background: var(--accent-hover);
    }
    .glow__send:active {
      transform: scale(0.92);
    }
    .glow__send:disabled {
      opacity: 0.55;
      cursor: default;
    }
    .hint {
      margin-top: 24px;
      font-size: 12.5px;
      color: var(--faint);
      font-family: var(--mono);
    }
    @media (prefers-reduced-motion: reduce) {
      .glow {
        animation: none;
      }
    }
  `,
})
export class NewRequest {
  draft = inject(IntakeDraft);
  private router = inject(Router);
  private api = inject(Api);

  saving = signal(false);

  /** platform-correct hint for the submit shortcut */
  readonly kbdLabel = /Mac|iP(hone|ad|od)/.test(globalThis.navigator?.platform ?? '')
    ? '\u2318\u21b5'
    : 'Ctrl\u21b5';

  dragOver = signal(false);

  private descTa = viewChild.required<ElementRef<HTMLTextAreaElement>>('descTa');
  private fx = viewChild.required<ElementRef<HTMLCanvasElement>>('fx');

  constructor() {
    // a restored draft may already hold a long description — size the field to it
    afterNextRender(() => {
      this.growDesc();
      this.renderFx();
    });
    // the Theme service writes <html data-theme> on every change (including
    // OS-level flips while on 'system') — repaint the field to match
    const themeObserver = new MutationObserver(() => this.renderFx());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    inject(DestroyRef).onDestroy(() => themeObserver.disconnect());
  }

  /** Paint the ignition glyph field: a low-res gradient scene is sampled per
   *  glyph cell — the pixel's alpha picks the character density, its color
   *  paints the glyph — over a blurred copy of the scene for the soft glow. */
  renderFx() {
    const canvas = this.fx().nativeElement;
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

    const cols = Math.ceil(w / FX_CELL_W);
    const rows = Math.ceil(h / FX_CELL_H);
    const off = document.createElement('canvas');
    off.width = cols;
    off.height = rows;
    const o = off.getContext('2d');
    if (!o) return;
    this.paintFxScene(o, cols, rows, dark);
    const px = o.getImageData(0, 0, cols, rows).data;

    // soft luminous underlay: the same scene, blurred way up
    ctx.save();
    ctx.filter = 'blur(48px)';
    ctx.globalAlpha = dark ? 0.5 : 0.16;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, cols, rows, 0, 0, w, h);
    ctx.restore();

    const aBase = dark ? 0.35 : 0.3;
    const aSpan = dark ? 0.65 : 0.5;
    ctx.font = `600 12px ${getComputedStyle(canvas).getPropertyValue('--mono') || 'monospace'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 4;
        const a = px[i + 3] / 255;
        if (a < 0.1) continue;
        if (fxHash(c, r) < 0.07) continue; // a few gaps, even when dense
        if (fxHash(c * 7 + 13, r * 3 + 5) < (0.8 - a) * 0.5) continue; // crumble as intensity drops
        const tier = FX_TIERS.find(([t]) => a >= t);
        if (!tier) continue;
        const chars = tier[1];
        const ch = chars[Math.floor(fxHash(c * 31 + 7, r * 17 + 3) * chars.length)];
        ctx.fillStyle = `rgba(${px[i]},${px[i + 1]},${px[i + 2]},${(aBase + aSpan * a).toFixed(3)})`;
        ctx.fillText(ch, c * FX_CELL_W + FX_CELL_W / 2, r * FX_CELL_H + FX_CELL_H / 2);
      }
    }
  }

  /** The scene the glyphs sample: a glow rising from below the viewport —
   *  dark: cream core → magenta → violet on graphite; light: a quiet orchid
   *  tint so the field whispers on the pale canvas. A pocket is cleared
   *  behind the composer + hint so the card reads cleanly. */
  private paintFxScene(o: CanvasRenderingContext2D, w: number, h: number, dark: boolean) {
    const g = o.createRadialGradient(w * 0.5, h * 1.52, 0, w * 0.5, h * 1.52, h * 1.5);
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
    o.save();
    o.globalCompositeOperation = 'destination-out';
    o.translate(w * 0.5, h * 0.56);
    o.scale(1.7, 1);
    const m = o.createRadialGradient(0, 0, 0, 0, 0, h * 0.38);
    m.addColorStop(0, 'rgba(0,0,0,.92)');
    m.addColorStop(0.7, 'rgba(0,0,0,.6)');
    m.addColorStop(1, 'rgba(0,0,0,0)');
    o.fillStyle = m;
    o.fillRect(-w, -h, w * 2, h * 2);
    o.restore();
  }

  /** keep the describe field sized to its content (it has no scrollbar);
   *  empty → no inline height at all, so CSS min-height rules and a stale
   *  measurement (e.g. mid-HMR) can never wedge the field open */
  growDesc() {
    const ta = this.descTa().nativeElement;
    if (!ta.value) {
      ta.style.height = '';
      return;
    }
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }
  onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) void this.draft.addFiles(Array.from(input.files), 'describe');
    input.value = '';
  }
  onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault(); // required so the browser allows the drop
    this.dragOver.set(true);
  }
  onDragLeave(e: DragEvent) {
    // only clear when the drag leaves the window, not when crossing elements
    if (!e.relatedTarget) this.dragOver.set(false);
  }
  onDrop(e: DragEvent) {
    e.preventDefault(); // never let the browser navigate to the dropped file
    this.dragOver.set(false);
    if (e.dataTransfer?.files.length)
      void this.draft.addFiles(Array.from(e.dataTransfer.files), 'describe');
  }
  onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) void this.draft.addFiles(files, 'describe');
  }

  kbdSubmit() {
    this.send();
  }
  send() {
    if (!this.draft.desc.trim() || this.saving()) {
      this.descTa().nativeElement.focus();
      return;
    }
    void this.continue_();
  }
  /** Continue must feel instant: create the request with the New-app default
   *  (ADR 0023) and navigate straight to the basics — classification and file
   *  uploads catch up in the background. */
  private async continue_() {
    this.saving.set(true);
    try {
      if (!this.draft.type) {
        this.draft.type = 'new';
        this.draft.typeConfidence = 0; // provisional — background classify may refine it
      }
      const id = await this.draft.save();
      void this.finishInBackground(id);
      await this.router.navigateByUrl(`/submit/${id}/interview`);
    } finally {
      this.saving.set(false);
    }
  }

  /** Kick classification (ADR 0023), then poll its durable result after navigation.
   *  The user's own pick (typeConfidence 1) always wins over a late guess, and
   *  a failed call just leaves the provisional New app standing. */
  private async finishInBackground(id: number) {
    void this.draft.uploadPending(id);
    if (this.draft.requestId !== id || this.draft.typeConfidence !== 0) return;
    const description = this.draft.desc.trim();
    const token = claimClassification(this.draft, id, description);
    if (token == null) return;
    const ownsPendingRun = () =>
      this.draft.typeConfidence === 0 && ownsClassification(this.draft, id, token, description);
    try {
      if (!ownsPendingRun()) return;
      let c = await firstValueFrom(this.api.classify(description, id));
      while (c.status === 'pending') {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!ownsPendingRun()) return;
        c = await firstValueFrom(this.api.classification(id));
      }
      if (!ownsPendingRun()) return;
      if (c.status !== 'succeeded' || c.type == null || c.confidence == null) return;

      // NOTE(plan-008): This checkout has no pending Track chip. typeConfidence=0
      // is its existing pending signal, and Basics preserves an explicit human pick.
      const inferredType = c.type;
      this.draft.type = inferredType;
      this.draft.typeConfidence = c.confidence;
      if (inferredType !== 'new') {
        if (!ownsClassification(this.draft, id, token, description)) return;
        await firstValueFrom(this.api.updateRequest(id, { type: inferredType }));
        const humanType = this.draft.type;
        if (
          ownsClassification(this.draft, id, token, description) &&
          this.draft.typeConfidence === 1 &&
          humanType != null &&
          humanType !== inferredType
        ) {
          await firstValueFrom(this.api.updateRequest(id, { type: humanType }));
        }
      }
    } catch {
      /* provisional 'new' stands */
    } finally {
      releaseClassification(this.draft, id, token);
    }
  }
}
