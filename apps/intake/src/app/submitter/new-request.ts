import { afterNextRender, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { Icon } from '@sf/shared';
import { IntakeDraft } from './intake-draft.service';
import { SubShell } from './sub-shell';

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
  },
  template: `
    <sub-shell active="new">
      <div class="sub-col pop-in" style="max-width:820px">
        <section class="hero-screen">
          <h1 class="hero__t">What should we build?</h1>
          <p class="hero__s">
            Describe it in plain language. The factory asks the right follow-ups.
          </p>
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
      min-height: calc(100dvh - 160px);
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      padding: 8px 0 26px;
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
      max-width: 600px;
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

  saving = signal(false);

  /** platform-correct hint for the submit shortcut */
  readonly kbdLabel = /Mac|iP(hone|ad|od)/.test(globalThis.navigator?.platform ?? '')
    ? '\u2318\u21b5'
    : 'Ctrl\u21b5';

  dragOver = signal(false);

  private descTa = viewChild.required<ElementRef<HTMLTextAreaElement>>('descTa');

  constructor() {
    // a restored draft may already hold a long description — size the field to it
    afterNextRender(() => this.growDesc());
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
  private async continue_() {
    // the request needs a type at creation; new-app is the factory's main flow.
    // The Clarify basics card lets the submitter change it (PATCH).
    if (!this.draft.type) this.draft.type = 'new';
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
