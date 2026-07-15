import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import {
  Api,
  Icon,
  Mark,
  PrototypeAnnotation,
  PrototypeState,
  prototypeSrcdoc,
} from '@sf/shared';
import { GenerationStream } from './generation-stream';
import { INSPECTOR } from './proto-inspector';
import { ProtoFullscreen } from './proto-fullscreen';
import { SubShell } from './sub-shell';

/** S3 (new-app only) — the Prototype step: a chat thread on the left co-designs a self-contained
 *  HTML mock rendered in a sandboxed iframe on the right. Point-to-edit (Select mode) lets the user
 *  click one or more elements to scope a change; the mock can be opened full screen for review. */
@Component({
  selector: 'sf-prototype',
  imports: [SubShell, Mark, Icon, FormsModule, ProtoFullscreen],
  host: { '(window:keydown)': 'onKey($event)' },
  template: `
    <sub-shell active="new">
      <div class="pt">
        <div class="pt__intro">
          <h1>Shape the experience</h1>
          <p>
            Chat to build a quick mock of what you have in mind. Point at anything to change it.
          </p>
        </div>

        <div class="pt__panes">
          <!-- CHAT -->
          <section class="panel pt__chat">
            <div class="chat__head">
              <span class="chat__av"><sf-mark [size]="14" color="#fff" /></span>
              <div class="chat__who"><b>Intake assistant</b><span>Stream</span></div>
            </div>
            <div class="chat__thread scroll" #thread data-lenis-prevent>
              @for (t of turns(); track t.order) {
                @if (t.instruction) {
                  <div class="brow brow--me">
                    <div class="bub bub--me">{{ t.instruction }}</div>
                  </div>
                }
                @if (t.note) {
                  <div class="brow">
                    <span class="bav"><sf-mark [size]="12" color="#fff" /></span>
                    <div class="bub bub--ai">{{ t.note }}</div>
                  </div>
                }
              }
              @if (working()) {
                <div class="brow fade-in">
                  <span class="bav"><sf-mark [size]="12" color="#fff" /></span>
                  <div class="bub bub--ai typing" aria-hidden="true">
                    <span></span><span></span><span></span> designing…
                  </div>
                </div>
              }
            </div>
            <div class="chat__composer">
              @if (annotations().length) {
                <div class="chips">
                  @for (a of annotations(); track a.pid; let i = $index) {
                    <span class="chip">
                      <sf-icon name="target" [size]="11" />{{ chipLabel(a) }}
                      <button type="button" (click)="removeAnnot(i)" aria-label="Remove">✕</button>
                    </span>
                  }
                </div>
              }
              <div class="cbox">
                <textarea
                  class="cbox__in"
                  rows="1"
                  [ngModel]="msg()"
                  (ngModelChange)="msg.set($event)"
                  (keydown.enter)="onEnter($event)"
                  [disabled]="working()"
                  [placeholder]="composerPlaceholder()"
                ></textarea>
                <button
                  class="send"
                  (click)="send()"
                  [disabled]="working() || !msg().trim()"
                  aria-label="Send"
                >
                  ↑
                </button>
              </div>
              <div class="crow">
                <button class="ghost" (click)="undo()" [disabled]="!canUndo() || working()">
                  ↺ Undo last change
                </button>
                <button class="ghost" (click)="skip()">Skip prototype</button>
              </div>
            </div>
          </section>

          <!-- PREVIEW -->
          <section class="panel pt__preview">
            <div class="pv__bar">
              <button
                class="sel-btn"
                [class.on]="inspecting()"
                (click)="toggleInspect()"
                [disabled]="!srcdoc()"
                title="Select an element to edit (S)"
              >
                <sf-icon name="target" [size]="14" />
                {{ inspecting() ? 'Selecting…' : 'Select to edit' }}
              </button>
              <span class="pv__sp"></span>
              <button class="tool" (click)="openFull()" [disabled]="!srcdoc()" title="Full screen">
                <sf-icon name="maximize" [size]="14" /> Full screen
              </button>
              <button class="tool" (click)="undo()" [disabled]="!canUndo() || working()">
                ↺ Undo
              </button>
              <button class="btn primary sm" (click)="toReview()">
                Continue to Review <sf-icon name="arrowRight" [size]="14" />
              </button>
            </div>
            <div class="pv__body">
              @if (srcdoc(); as doc) {
                <iframe
                  #frame
                  [srcdoc]="doc"
                  sandbox="allow-scripts"
                  title="Prototype preview"
                  (load)="onFrameLoad()"
                ></iframe>
                @if (inspecting()) {
                  <div class="pv__hint">
                    Click an element to edit it · Cmd/Ctrl-click for several · Esc to stop
                  </div>
                }
              } @else {
                <div class="pv__empty">
                  @if (working()) {
                    <span class="pv__spin"></span>
                    <span>Designing your first prototype…</span>
                  } @else {
                    <span>No prototype yet — say what you'd like below.</span>
                  }
                </div>
              }
            </div>
          </section>
        </div>
      </div>

      <!-- full-screen prototype overlay (shared component) with point-to-edit + a follow-up composer -->
      @if (fullscreen() && srcdoc(); as doc) {
        <sf-proto-fullscreen [doc]="doc" (closed)="closeFull()" (frameReady)="onFsFrame($event)">
          <button
            fs-actions
            type="button"
            class="fs-selbtn"
            [class.on]="inspecting()"
            (click)="toggleInspect()"
            title="Select an element to edit"
          >
            <sf-icon name="target" [size]="14" />
            {{ inspecting() ? 'Selecting…' : 'Select to edit' }}
          </button>
          <div fs-footer class="fs-composer">
            @if (annotations().length) {
              <div class="chips">
                @for (a of annotations(); track a.pid; let i = $index) {
                  <span class="chip">
                    <sf-icon name="target" [size]="11" />{{ chipLabel(a) }}
                    <button type="button" (click)="removeAnnot(i)" aria-label="Remove">✕</button>
                  </span>
                }
              </div>
            }
            <div class="cbox">
              <textarea
                class="cbox__in"
                rows="1"
                [ngModel]="msg()"
                (ngModelChange)="msg.set($event)"
                (keydown.enter)="onEnter($event)"
                [disabled]="working()"
                [placeholder]="working() ? 'Designing…' : 'Ask for follow-up changes'"
              ></textarea>
              <button
                class="send"
                (click)="send()"
                [disabled]="working() || !msg().trim()"
                aria-label="Send"
              >
                ↑
              </button>
            </div>
          </div>
        </sf-proto-fullscreen>
      }
    </sub-shell>
  `,
  styles: `
    /* fill the shell body: .sub-body-inner has no height, so height:100% would
       collapse to content height — anchor to the viewport like the interview step.
       padding keeps the intro + panes off the viewport edges (matches .cl). */
    .pt {
      display: flex;
      flex-direction: column;
      height: calc(100dvh - 58px);
      padding: 20px 26px;
    }
    .pt__intro {
      flex: 0 0 auto;
      margin-bottom: 14px;
    }
    .pt__intro h1 {
      font-size: 24px;
      letter-spacing: -0.02em;
      margin: 0 0 4px;
    }
    .pt__intro p {
      color: var(--muted);
      font-size: 15px;
      margin: 0;
    }
    .pt__panes {
      flex: 1 1 auto;
      display: grid;
      grid-template-columns: minmax(300px, 360px) 1fr;
      gap: 16px;
      min-height: 0;
    }
    .panel {
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--surface);
      border: 1px solid var(--hairline);
      border-radius: 14px;
      overflow: hidden;
    }
    .chat__head {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 11px 14px;
      border-bottom: 1px solid var(--hairline);
    }
    .chat__av {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--a600, #6d28d9);
      display: grid;
      place-items: center;
      flex: 0 0 auto;
    }
    .chat__who b {
      font-size: 13px;
      display: block;
    }
    .chat__who span {
      font-size: 11px;
      color: var(--muted);
    }
    .chat__thread {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 15px 14px;
      display: flex;
      flex-direction: column;
      gap: 13px;
    }
    .brow {
      display: flex;
      gap: 8px;
      align-items: flex-start;
    }
    .brow--me {
      justify-content: flex-end;
    }
    .bav {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--a600, #6d28d9);
      flex: 0 0 auto;
      margin-top: 2px;
      display: grid;
      place-items: center;
    }
    .bub {
      padding: 9px 12px;
      border-radius: 12px;
      font-size: 13.5px;
      line-height: 1.5;
      max-width: 85%;
    }
    .bub--ai {
      background: var(--surface-2);
      border: 1px solid var(--hairline);
      border-top-left-radius: 4px;
      color: var(--fg1);
    }
    .bub--me {
      background: var(--accent);
      color: #fff;
      border-top-right-radius: 4px;
    }
    .typing span {
      display: inline-block;
      width: 5px;
      height: 5px;
      margin-right: 2px;
      border-radius: 50%;
      background: var(--faint);
      animation: pt-dot 1.2s infinite;
    }
    .typing span:nth-child(2) {
      animation-delay: 0.15s;
    }
    .typing span:nth-child(3) {
      animation-delay: 0.3s;
    }
    @keyframes pt-dot {
      0%,
      60%,
      100% {
        opacity: 0.3;
      }
      30% {
        opacity: 1;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .typing span {
        animation: none;
      }
    }

    .chat__composer {
      flex: 0 0 auto;
      border-top: 1px solid var(--hairline);
      padding: 11px 12px;
    }
    /* follow-up composer docked in the full-screen overlay — centered, capped width */
    .fs-composer {
      max-width: 820px;
      margin: 0 auto;
    }
    /* Select-to-edit toggle projected into the full-screen bar (matches .fs__close) */
    .fs-selbtn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--surface-2);
      border: 1px solid var(--hairline);
      border-radius: 9px;
      padding: 7px 13px;
      margin-right: 10px;
      cursor: pointer;
      color: var(--fg1);
      font-weight: 600;
      font-size: 13px;
      font-family: var(--body);
    }
    .fs-selbtn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .fs-selbtn.on {
      background: var(--accent-tint);
      border-color: var(--accent);
      color: var(--accent-tx);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: var(--accent-tint);
      color: var(--accent-link);
      border: 1px solid var(--accent);
      font-size: 12px;
      padding: 3px 8px;
      border-radius: 999px;
      max-width: 220px;
    }
    .chip {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .chip button {
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 0 0 0 1px;
      opacity: 0.7;
      flex: 0 0 auto;
    }
    .cbox {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      background: var(--surface-2);
      border: 1px solid var(--hairline);
      border-radius: 11px;
      padding: 8px 10px;
    }
    .cbox__in {
      flex: 1;
      background: none;
      border: none;
      color: var(--fg1);
      font-size: 13.5px;
      font-family: var(--body);
      outline: none;
      resize: none;
      field-sizing: content;
      max-height: 140px;
      overflow-y: auto;
    }
    .cbox__in::placeholder {
      color: var(--faint);
    }
    .cbox__in:disabled {
      opacity: 0.6;
    }
    .send {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: var(--accent);
      color: #fff;
      border: none;
      cursor: pointer;
      flex: 0 0 auto;
    }
    .send:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .crow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 9px;
    }
    .ghost {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--muted);
      font-size: 12.5px;
      font-family: var(--body);
      padding: 2px 4px;
    }
    .ghost:disabled {
      opacity: 0.4;
      cursor: default;
    }

    .pv__bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 11px;
      border-bottom: 1px solid var(--hairline);
      background: var(--surface-2);
    }
    .pv__sp {
      flex: 1;
    }
    .sel-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--surface);
      border: 1px solid var(--hairline);
      cursor: pointer;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--fg1);
      font-family: var(--body);
      white-space: nowrap;
      padding: 5px 11px;
      border-radius: 8px;
      transition:
        background var(--dur, 0.15s),
        border-color var(--dur, 0.15s);
    }
    .sel-btn.on {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .sel-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .tool {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: none;
      border: none;
      cursor: pointer;
      color: var(--muted);
      font-size: 12.5px;
      font-family: var(--body);
      padding: 4px 6px;
      border-radius: 7px;
    }
    .tool:hover:not(:disabled) {
      color: var(--fg1);
      background: var(--surface);
    }
    .tool:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .pv__body {
      flex: 1 1 auto;
      min-height: 0;
      background: #fff;
      position: relative;
    }
    .pv__body iframe {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
    }
    .pv__hint {
      position: absolute;
      left: 50%;
      bottom: 14px;
      transform: translateX(-50%);
      background: var(--fg1);
      color: var(--bg);
      font-size: 12px;
      font-weight: 500;
      padding: 6px 13px;
      border-radius: 999px;
      white-space: nowrap;
      pointer-events: none;
      box-shadow: 0 3px 12px rgba(0, 0, 0, 0.25);
    }
    .pv__empty {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      color: var(--faint);
      font-size: 14px;
      background: var(--surface-2);
    }
    .pv__spin {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 2px solid var(--hairline);
      border-top-color: var(--accent);
      animation: pt-spin 0.8s linear infinite;
    }
    @keyframes pt-spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .pv__spin {
        animation: none;
      }
    }
  `,
})
export class Prototype implements OnInit {
  api = inject(Api);
  private sanitizer = inject(DomSanitizer);
  id = Number(inject(ActivatedRoute).snapshot.paramMap.get('id'));
  private router = inject(Router);

  /** the generation loop: 1500 ms thinking-poll + SSE-with-fallback (GenerationStream) */
  private gen = new GenerationStream<PrototypeState>(
    (kick) => this.api.prototype(this.id, kick),
    () => this.api.prototypeStreamUrl(this.id),
    (s) => s.thinking,
    inject(DestroyRef),
    {
      isValidEvent: (s) => !!s && typeof s.status === 'string',
      // drive on load when a first draft is owed or a revision is in flight
      needsStreamOnLoad: (s) =>
        s.status !== 'skipped' && (!s.html || s.thinking || this.hasPending(s)),
      needsStreamAfterEvent: (s) => this.hasPending(s), // a queued edit is still owed
      onState: () => this.scrollToEnd(),
    },
  );
  /** the prototype state — the stream's writable state signal */
  st = this.gen.state;
  /** a revision is streaming in over SSE */
  streaming = this.gen.streaming;
  msg = signal('');
  annotations = signal<PrototypeAnnotation[]>([]); // point-to-edit selection (multi)
  inspecting = signal(false);
  private fsFrame = signal<HTMLIFrameElement | null>(null); // the full-screen overlay's iframe

  /** the iframe the user is currently looking at — the full-screen one while it's open,
   *  otherwise the docked preview. All point-to-edit messaging targets this frame. */
  private activeFrame(): HTMLIFrameElement | null {
    const fs = this.fsFrame();
    if (this.fullscreen() && fs) return fs;
    return this.frame()?.nativeElement ?? null;
  }
  fullscreen = signal(false);

  private frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');
  private thread = viewChild<ElementRef<HTMLElement>>('thread');
  private onMsg = (ev: MessageEvent) => this.handleMessage(ev);

  turns = computed(() => this.st()?.turns ?? []);
  working = computed(() => this.streaming() || this.gen.thinking());
  canUndo = computed(() => this.turns().filter((t) => t.revision).length >= 2);
  // rebuild the iframe doc only when the html string actually changes (a stable identity keeps the
  // iframe from reloading — and losing the point-to-edit selection — on unrelated state updates).
  srcdoc = linkedSignal<string | null, SafeHtml | null>({
    source: () => this.st()?.html ?? null,
    computation: (html) => (html ? this.buildSrcdoc(html) : null),
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => window.removeEventListener('message', this.onMsg));
    window.addEventListener('message', this.onMsg);
  }

  ngOnInit() {
    this.gen.refresh();
  }

  chipLabel(a: PrototypeAnnotation) {
    return (a.textSnippet || a.pid || a.tag || 'element').slice(0, 40);
  }
  composerPlaceholder() {
    if (this.working()) return 'Designing…';
    return this.annotations().length
      ? 'Describe the change to the selected element(s)…'
      : 'Describe a change…';
  }

  private buildSrcdoc(html: string): SafeHtml {
    // strip whatever CSP the doc shipped and inject an authoritative one: allow the prototype's
    // (and the inspector's) inline script/style, but block ALL network — so a slipped external
    // URL can't phone home and the point-to-edit inspector always runs. Sandbox is the backstop.
    return this.sanitizer.bypassSecurityTrustHtml(prototypeSrcdoc(html, INSPECTOR));
  }

  private hasPending(s: PrototypeState) {
    return s.turns.some((t) => t.mode === 'pending');
  }

  onEnter(e: Event) {
    const ke = e as KeyboardEvent;
    if (ke.isComposing || ke.shiftKey) return;
    ke.preventDefault();
    this.send();
  }

  onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (this.fullscreen()) this.closeFull();
      else if (this.inspecting()) this.setInspect(false);
      return;
    }
    if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (this.srcdoc()) this.toggleInspect();
    }
  }

  send() {
    const instruction = this.msg().trim();
    if (!instruction || this.working()) return;
    const picked = this.annotations();
    const annotation = picked.length === 0 ? null : picked.length === 1 ? picked[0] : picked;
    this.api.instructPrototype(this.id, instruction, annotation).subscribe((s) => {
      this.gen.ingest(s, s.thinking || this.hasPending(s)); // stream the revision (async brain)
      this.msg.set('');
      this.clearAnnots();
      this.scrollToEnd();
    });
  }

  undo() {
    const revs = this.turns().filter((t) => t.revision);
    if (revs.length < 2) return;
    const target = revs[revs.length - 2]; // revert to the revision before the current
    this.api.restorePrototype(this.id, target.order).subscribe((s) => {
      this.gen.ingest(s);
      this.scrollToEnd();
    });
  }

  skip() {
    if (!confirm('Submit without a prototype? You can still add one later.')) return;
    this.api.skipPrototype(this.id).subscribe(() => this.toReview());
  }

  toReview() {
    this.router.navigateByUrl(`/submit/${this.id}/review`);
  }

  // ── full screen ──
  openFull() {
    if (this.srcdoc()) this.fullscreen.set(true);
  }
  closeFull() {
    this.fullscreen.set(false);
    this.fsFrame.set(null);
    // the fs selection belonged to the overlay's document — reset and re-arm the docked frame
    this.annotations.set([]);
    this.postSync([]); // clear any stale highlights in the docked frame
    if (this.inspecting()) this.postInspect(true);
  }
  /** the full-screen overlay's iframe (re)loaded — a fresh document has no valid selection;
   *  clear and re-arm select mode if it's on (mirrors onFrameLoad for the docked frame) */
  onFsFrame(frame: HTMLIFrameElement) {
    this.fsFrame.set(frame);
    this.annotations.set([]);
    if (this.inspecting()) this.postInspect(true);
  }

  // ── point-to-edit ──
  toggleInspect() {
    this.setInspect(!this.inspecting());
  }
  private setInspect(on: boolean) {
    this.inspecting.set(on);
    this.postInspect(on);
  }
  removeAnnot(i: number) {
    const next = this.annotations().filter((_, k) => k !== i);
    this.annotations.set(next);
    this.postSync(next);
  }
  private clearAnnots() {
    this.annotations.set([]);
    this.postSync([]);
  }
  onFrameLoad() {
    // a fresh document has no valid selection — clear, and re-arm select mode if it was on
    this.annotations.set([]);
    if (this.inspecting()) this.postInspect(true);
  }
  private postInspect(on: boolean) {
    this.activeFrame()?.contentWindow?.postMessage({ type: 'sf-inspect', on }, '*');
  }
  private postSync(picked: PrototypeAnnotation[]) {
    const pids = picked.map((a) => a.pid).filter(Boolean);
    this.activeFrame()?.contentWindow?.postMessage({ type: 'sf-sync', pids }, '*');
  }
  private handleMessage(ev: MessageEvent) {
    // only trust our own sandboxed frames — the docked preview or the full-screen overlay
    const docked = this.frame()?.nativeElement?.contentWindow;
    const fs = this.fsFrame()?.contentWindow;
    if (ev.source !== docked && ev.source !== fs) return;
    const d = ev.data || {};
    if (d.type === 'sf-annot' && Array.isArray(d.items)) {
      // coerce every field to a string — a crafted mock could postMessage non-string values,
      // and chipLabel().slice() would throw on e.g. a numeric pid
      const str = (v: unknown): string | null => (v == null ? null : String(v).slice(0, 800));
      this.annotations.set(
        d.items.slice(0, 20).map(
          (it: Record<string, unknown>): PrototypeAnnotation => ({
            pid: str(it['pid']),
            selector: str(it['selector']),
            tag: str(it['tag']),
            textSnippet: str(it['textSnippet']),
            outerHTML: str(it['outerHTML']),
            rect:
              it['rect'] && typeof it['rect'] === 'object'
                ? (it['rect'] as PrototypeAnnotation['rect'])
                : null,
          }),
        ),
      );
    }
  }

  private scrollToEnd() {
    setTimeout(() => {
      const el = this.thread()?.nativeElement;
      if (el) el.scrollTo({ top: el.scrollHeight });
    });
  }
}
