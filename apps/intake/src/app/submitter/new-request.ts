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
import { ActivatedRoute } from '@angular/router';

import { Api } from '@sf/shared';
import { IntakeDraft } from './intake-draft.service';
import { Interview } from './interview';
import { Prototype } from './prototype';
import { Review } from './review';
import { SubShell } from './sub-shell';

/** The intake JOURNEY — one page, four sections (Describe hero → Clarify →
 *  Prototype (new apps) → Review), Lenis-scrolled between them; the left rail's
 *  tracing beam spans the whole trip. Sections mount once the request exists.
 *  Old step routes (/submit/:id/interview|prototype|review) deep-link here and
 *  scroll to their section. ⌘↵ / Ctrl↵ submits the describe hero. */
@Component({
  selector: 'sf-new-request',
  imports: [SubShell, FormsModule, Interview, Prototype, Review],
  host: {
    '(document:keydown.meta.enter)': 'kbdSubmit()',
    '(document:keydown.control.enter)': 'kbdSubmit()',
  },
  template: `
    <sub-shell active="new" [step]="curStep()" [proto]="isNew()" [reqId]="rid()">
      <div class="sub-col pop-in" style="max-width:1200px">
        <section class="hero-screen jsec" id="sec-describe">
          <h1 class="hero__t">What should we build?</h1>
          <p class="hero__s">
            Describe it in plain language. The factory asks the right follow-ups.
          </p>
          <div class="glow">
            <div class="glow__card">
              <label class="sr-only" for="nr-desc">Description</label>
              <textarea
                #descTa
                id="nr-desc"
                placeholder="Describe it in your own words…"
                [(ngModel)]="draft.desc"
                (input)="growDesc()"
              ></textarea>
              <div class="glow__row">
                <div class="glow__pills">
                  @for (p of pills; track p[0]) {
                    <button type="button" class="glow__pill" (click)="prefill(p[1])">
                      {{ p[0] }}
                    </button>
                  }
                </div>
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
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
          <span class="hint">{{
            saving() ? 'Saving…' : 'Press ' + kbdLabel + ' to continue'
          }}</span>
        </section>

        @if (rid(); as id) {
          <section class="jsec" id="sec-clarify">
            <sf-interview [id]="id" (done)="advance()" (typeChange)="isNew.set($event === 'new')" />
          </section>
          @if (isNew()) {
            <section class="jsec" id="sec-prototype">
              <sf-prototype [id]="id" (done)="scrollToSec('sec-review')" />
            </section>
          }
          <section class="jsec" id="sec-review">
            <sf-review
              [id]="id"
              (goto)="scrollToSec($event === 'interview' ? 'sec-clarify' : 'sec-prototype')"
            />
          </section>
        }
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
    .jsec {
      scroll-margin-top: 12px;
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
      border-top: 1px solid var(--hairline);
    }
    .glow__pills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .glow__pill {
      font-size: 12px;
      font-weight: 500;
      padding: 5px 11px;
      border-radius: var(--r-pill);
      border: 1px solid var(--border-strong);
      background: var(--surface-2);
      color: var(--fg2);
      cursor: pointer;
      transition:
        border-color var(--dur) var(--ease),
        color var(--dur) var(--ease);
    }
    .glow__pill:hover {
      border-color: var(--accent-tint-bd);
      color: var(--accent-tx);
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
  private api = inject(Api);

  saving = signal(false);
  /** the created request — sections below the hero mount once this is set */
  rid = signal<number | null>(null);
  /** new-app journeys include the Prototype section */
  isNew = signal(true);
  /** rail highlight: which section is in view (scroll-spy) */
  curStep = signal(0);
  private sectionIo: IntersectionObserver | null = null;

  /** platform-correct hint for the submit shortcut */
  readonly kbdLabel = /Mac|iP(hone|ad|od)/.test(globalThis.navigator?.platform ?? '')
    ? '⌘↵'
    : 'Ctrl↵';

  /** prompt-starter pills under the describe field: [label, prefill text] */
  pills: [string, string][] = [
    ['Dashboard', 'A dashboard that '],
    ['Report', 'A report that '],
    ['Bug fix', 'Fix a bug where '],
    ['Team tool', 'A tool for my team to '],
  ];

  private descTa = viewChild.required<ElementRef<HTMLTextAreaElement>>('descTa');
  private shell = viewChild.required(SubShell);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.sectionIo?.disconnect());
    // a restored draft may already hold a long description — size the field to it
    afterNextRender(() => this.growDesc());
    // deep link (/submit/:id/<section>): hydrate the draft, mount the sections,
    // and land on the requested one
    const snap = inject(ActivatedRoute).snapshot;
    const id = Number(snap.paramMap.get('id'));
    const section = (snap.url[snap.url.length - 1]?.path ?? '') as string;
    if (id) {
      this.api.request(id).subscribe((r) => {
        this.draft.hydrateFrom(r);
        this.isNew.set(r.type === 'new');
        this.rid.set(id);
        if (['interview', 'prototype', 'review'].includes(section)) {
          this.whenSection(section === 'interview' ? 'sec-clarify' : `sec-${section}`, (el) => {
            this.shell().setScrollFloor(el);
            this.shell().scrollToEl(el);
          });
        }
        this.whenSection('sec-review', () => this.watchSections());
      });
    }
  }

  /** run cb once a dynamically-mounted section exists in the DOM (the sections
   *  render on the change-detection pass after rid() is set — retry briefly
   *  instead of guessing a wall-clock delay) */
  private whenSection(sid: string, cb: (el: HTMLElement) => void, tries = 40) {
    const el = document.getElementById(sid);
    if (el) {
      cb(el);
      return;
    }
    if (tries > 0) setTimeout(() => this.whenSection(sid, cb, tries - 1), 25);
  }

  /** rail scroll-spy — the current step follows the section occupying the viewport */
  private watchSections() {
    this.sectionIo?.disconnect();
    const order = ['sec-describe', 'sec-clarify', 'sec-prototype', 'sec-review'];
    this.sectionIo = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = order.indexOf((e.target as HTMLElement).id);
          if (i < 0) continue;
          // step index skips Prototype for non-new journeys
          this.curStep.set(!this.isNew() && i === 3 ? 2 : i);
        }
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    for (const sid of order) {
      const el = document.getElementById(sid);
      if (el) this.sectionIo.observe(el);
    }
  }

  /** the interview finished — glide to the next section */
  advance() {
    this.scrollToSec(this.isNew() ? 'sec-prototype' : 'sec-review');
  }
  /** glide to a section and make it the new scroll floor — the page can no
   *  longer be scrolled above it (explicit back-navigation re-lowers it) */
  scrollToSec(sid: string) {
    const el = document.getElementById(sid);
    if (!el) return;
    this.shell().setScrollFloor(el);
    this.shell().scrollToEl(el);
  }

  /** keep the describe field sized to its content (it has no scrollbar) */
  growDesc() {
    const ta = this.descTa().nativeElement;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }
  /** seed the describe field with a sentence starter (only when empty) */
  prefill(text: string) {
    if (!this.draft.desc.trim()) {
      this.draft.desc = text;
    }
    const ta = this.descTa().nativeElement;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    this.growDesc();
  }

  kbdSubmit() {
    // the shortcut belongs to the describe hero only — once the journey has
    // started, ⌘↵ inside a section must not re-save + yank the scroll back
    if (this.rid() !== null) return;
    this.send();
  }
  send() {
    if (!this.draft.desc.trim() || this.saving()) {
      this.descTa().nativeElement.focus();
      return;
    }
    this.continue_();
  }
  private async continue_() {
    // the request needs a type at creation; new-app is the factory's main flow.
    // The Clarify basics card lets the submitter change it (PATCH).
    if (!this.draft.type) this.draft.type = 'new';
    this.saving.set(true);
    try {
      const id = await this.draft.save();
      await this.draft.uploadPending(id);
      this.isNew.set(this.draft.type === 'new');
      this.rid.set(id); // mounts the sections below…
      this.whenSection('sec-clarify', () => {
        this.scrollToSec('sec-clarify'); // …then Lenis glides down to Clarify
        this.watchSections();
      });
    } finally {
      this.saving.set(false);
    }
  }
}
