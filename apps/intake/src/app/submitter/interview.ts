import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { Api, Icon, InterviewState, Mark, RequestDetail, streamState, TrackChip } from '@sf/shared';
import { BasicsCard, basicsAnswered } from './basics-card';
import { PlanPanel } from './plan-panel';
import { SubShell } from './sub-shell';
import { IntakeDraft } from './intake-draft.service';

/** S2 — the adaptive AI interview: a chat thread with the intake assistant, with an
 *  AskUserQuestion panel docked above the composer, copying claude.ai's
 *  widget: question + × header, hairline rows with square keycaps, focused
 *  row carries ↩, pencil "Something else" row + Skip, ↑↓/Enter selection,
 *  "Or reply directly…" composer with the key-hint bar beneath.
 *  Chosen from the 2026-07 Clarify prototype (chat persona + command palette). */
@Component({
  selector: 'sf-interview',
  imports: [SubShell, Mark, Icon, TrackChip, FormsModule, BasicsCard, PlanPanel],
  host: {
    '(window:keydown)': 'onKeys($event)',
  },
  template: `
    <sub-shell active="new">
      @if (phase() === 'basics') {
        <!-- arrival beat: the brain is genuinely pre-generating its first question
             in the background — the submitter settles the basics meanwhile -->
        <div class="intro">
          <span class="intro__badge blurin"
            ><i class="intro__pulse"></i>Preparing your questions…</span
          >
          <h1 class="intro__t blurin blurin--2">
            A few quick questions while the agent digs into your request.
          </h1>
          @if (req(); as r) {
            <div class="intro__card blurin blurin--3">
              <sf-basics-card
                [id]="id"
                [rtype]="r.type"
                (typeChanged)="onTypeChanged()"
                (saved)="onBasicsSaved()"
              />
              <div class="intro__foot">
                <p class="intro__note">
                  <b>That's the basics.</b> The interview covers everything else.
                </p>
                <button class="btn primary intro__go" (click)="startInterview()">
                  Start the interview
                </button>
              </div>
              @if (nudge()) {
                <p class="intro__nudge" role="alert">
                  Add the missing details before you continue.
                </p>
              }
            </div>
          }
        </div>
      } @else {
        <div class="cl">
          <div class="iv">
            <!-- sr-only live region: announces each new question / thinking / done -->
            <div class="sr-only" role="status" aria-live="polite">{{ liveQuestion() }}</div>

            <div class="iv__thread scroll" #thread data-lenis-prevent>
              @if (req(); as r) {
                <div class="iv__ctx">
                  <!-- pulses while an escalation proposal is pending (ADR 0023) -->
                  <sf-track-chip [t]="r.type" [state]="escalation() ? 'pulse' : 'confident'" />
                  <span class="iv__ctxt">{{ r.title }}</span>
                </div>
              }

              @for (t of turns(); track t.order) {
                <div class="brow">
                  <span class="bav"><sf-mark [size]="13" color="#fff" /></span>
                  <div class="bub bub--ai">{{ t.question }}</div>
                </div>
                <div class="brow brow--me">
                  <div class="bub bub--me" [class.bub--skip]="t.skipped">
                    {{ t.skipped ? 'Skipped' : t.answer }}
                  </div>
                </div>
              }
              @if (st(); as s) {
                <!-- the question always lives in the thread; when it has options the docked
                 panel below carries only the answer choices (no duplicated question) -->
                @if (!s.done && s.question && !working()) {
                  <div class="brow fade-in">
                    <span class="bav"><sf-mark [size]="13" color="#fff" /></span>
                    <div class="bub bub--ai">
                      {{ s.question }}
                    </div>
                  </div>
                }
                @if (s.done && !working()) {
                  <div class="brow fade-in">
                    <span class="bav"><sf-mark [size]="13" color="#fff" /></span>
                    <div class="bub bub--ai">
                      Thanks — that's everything I need for now.
                      <span class="bsub">Add anything else below, or review the summary.</span>
                    </div>
                  </div>
                }
              }
              <!-- consent-gated type change (ADR 0023): the AI may change how much it asks
                   silently, but never WHAT the request is without the submitter's say-so -->
              @if (escalation(); as esc) {
                <div class="brow fade-in">
                  <span class="bav"><sf-mark [size]="13" color="#fff" /></span>
                  <div class="bub bub--ai">
                    This sounds bigger than a {{ typeWord(req()?.type) }} — switch to
                    <b>{{ typeWord(esc.to_type) }}</b
                    >?
                    @if (esc.why) {
                      <span class="bsub">{{ esc.why }}</span>
                    }
                    <div class="esc__row">
                      <button class="btn primary sm" (click)="acceptEscalation(esc.to_type)">
                        Switch
                      </button>
                      <button class="dock__skip" (click)="declineEscalation(esc.to_type)">
                        Keep as is
                      </button>
                    </div>
                  </div>
                </div>
              }
              @if (working()) {
                <div class="brow fade-in">
                  <span class="bav"><sf-mark [size]="13" color="#fff" /></span>
                  <div class="bub bub--ai typing" aria-hidden="true">
                    <span></span><span></span><span></span> thinking…
                  </div>
                </div>
              }
            </div>

            <div class="iv__foot">
              @if (st(); as s) {
                @if (!s.done && !working() && !dismissed() && s.options; as opts) {
                  <!-- the AskUserQuestion panel, docked above the composer (claude.ai).
                   The question sits in the thread above; this panel is choices only. -->
                  <div class="dock fade-in" role="group" aria-label="Answer options">
                    @for (o of opts; track o.t; let i = $index) {
                      <button
                        class="dock__opt dock__opt--top"
                        [class.on]="hi() === i"
                        (mouseenter)="hi.set(i)"
                        (click)="answer(o.t)"
                      >
                        <span class="dock__k">{{ i + 1 }}</span>
                        <span class="dock__body">
                          <span class="dock__t">{{ o.t }}</span>
                          @if (o.d) {
                            <span class="dock__d">{{ o.d }}</span>
                          }
                        </span>
                        @if (hi() === i) {
                          <span class="dock__ret" aria-hidden="true">↩</span>
                        }
                      </button>
                    }
                    <div class="dock__opt dock__row">
                      <span class="dock__k dock__k--pen" aria-hidden="true">
                        <svg
                          viewBox="0 0 24 24"
                          width="11"
                          height="11"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                        </svg>
                      </span>
                      <textarea
                        class="dock__else"
                        rows="1"
                        [ngModel]="elseText()"
                        (ngModelChange)="elseText.set($event)"
                        (keydown.enter)="onEnter($event, 'else')"
                        placeholder="Something else…"
                        aria-label="Type your own answer"
                      ></textarea>
                      @if (elseText().trim()) {
                        <button class="dock__go" (click)="submitElse()" aria-label="Send answer">
                          ↩
                        </button>
                      }
                      <button class="dock__skip" (click)="skip()">Skip</button>
                    </div>
                  </div>
                }
              }
              <!-- claude.ai-style composer: + attach inside the box, chips above the input -->
              <div
                class="comp"
                [class.comp--over]="dragOver()"
                (dragover)="$event.preventDefault(); dragOver.set(true)"
                (dragleave)="dragOver.set(false)"
                (drop)="onDrop($event)"
                (paste)="onPaste($event)"
              >
                @if (draft.attachments().length || draft.pending().length) {
                  <div class="attach__chips comp__files">
                    @for (a of draft.attachments(); track a.id) {
                      <span class="attach__chip">
                        @if (a.kind === 'image') {
                          <img class="attach__thumb" [src]="api.attachmentRawUrl(a.id)" alt="" />
                        } @else {
                          <sf-icon name="app" [size]="14" color="var(--muted)" />
                        }
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
                        <sf-icon name="clock" [size]="13" color="var(--faint)" />
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
                <div class="comp__row">
                  <button
                    class="comp__add"
                    type="button"
                    aria-label="Attach files"
                    title="Attach files — any type, up to 100 MB each"
                    (click)="picker.click()"
                  >
                    <sf-icon name="plus" [size]="16" />
                  </button>
                  <textarea
                    class="comp__in"
                    rows="1"
                    [ngModel]="msg()"
                    (ngModelChange)="msg.set($event)"
                    [placeholder]="composerPlaceholder()"
                    (keydown.enter)="onEnter($event, 'composer')"
                  ></textarea>
                  @if (msg().trim()) {
                    <button class="comp__send" (click)="enter()" aria-label="Send">
                      <sf-icon name="chevUp" [size]="17" color="#fff" />
                    </button>
                  } @else if (st()?.done) {
                    <button class="btn primary sm" style="flex:0 0 auto" (click)="toReview()">
                      {{ req()?.type === 'new' ? 'Design prototype' : 'Review summary' }}
                      <sf-icon name="arrowRight" [size]="14" />
                    </button>
                  } @else if (st() && (!st()!.options || dismissed())) {
                    <button class="dock__skip" style="flex:0 0 auto" (click)="skip()">Skip</button>
                  }
                </div>
                <input #picker type="file" multiple hidden (change)="onPick($event)" />
              </div>
              @if (draft.lastError()) {
                <p class="attach__err">{{ draft.lastError() }}</p>
              }
              @if (showKeys()) {
                <div class="iv__keys" aria-hidden="true">
                  ↑↓ to navigate · Enter to select · or type below
                </div>
              }
            </div>
          </div>

          <!-- the live plan: a structured summary that rewrites itself as answers land -->
          <sf-plan-panel [id]="id" [answers]="turns().length" [facts]="facts()" />
        </div>
      }
    </sub-shell>
  `,
  styles: `
    .intro {
      max-width: 800px;
      margin: 0 auto;
      min-height: calc(100dvh - 170px);
      padding: 20px 26px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
    }
    .intro__badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      background: transparent;
      border: 0;
      padding: 0;
    }
    .intro__pulse {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--a500);
      animation: iv-pulse 1.4s infinite;
    }
    @keyframes iv-pulse {
      50% {
        opacity: 0.25;
      }
    }
    .intro__t {
      font-size: clamp(24px, 3.4vw, 34px);
      font-weight: 800;
      letter-spacing: -0.02em;
      line-height: 1.1;
      margin: 18px 0 26px;
    }
    .intro__card {
      width: 100%;
      text-align: left;
    }
    .intro__foot {
      margin-top: 30px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      flex-wrap: wrap;
    }
    .intro__note {
      margin: 0;
      font-size: 13px;
      color: var(--muted);
      text-align: left;
      max-width: 300px;
    }
    .intro__note b {
      color: var(--fg1);
      font-weight: 600;
    }
    .intro__go {
      justify-content: center;
      padding: 12px 26px;
      border-radius: 999px;
      font-size: 15px;
    }
    .intro__nudge {
      margin: 10px 0 0;
      font-size: 12.5px;
      color: var(--amber-tx);
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
      border-radius: var(--r);
      padding: 7px 12px;
    }
    /* blur-in: the analyzing line lands first, then the ask, then the card */
    .blurin {
      animation: iv-blurin 0.5s var(--ease-out) both;
    }
    .blurin--2 {
      animation-delay: 0.45s;
    }
    .blurin--3 {
      animation-delay: 0.95s;
    }
    @keyframes iv-blurin {
      from {
        opacity: 0;
        filter: blur(8px);
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        filter: blur(0);
        transform: none;
      }
    }
    /* the full workspace animates in once the basics are settled */
    .cl > .iv {
      animation: iv-in 0.5s var(--ease-out) both;
    }
    .cl > sf-plan-panel {
      animation: iv-in 0.5s var(--ease-out) 0.12s both;
      min-height: 0;
      display: block;
      height: 100%;
    }
    @keyframes iv-in {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .intro__pulse,
      .blurin,
      .cl > .iv,
      .cl > sf-plan-panel {
        animation: none;
      }
    }
    .cl {
      max-width: min(1600px, 94vw);
      margin: 0 auto;
      padding: 20px 26px;
      height: calc(100dvh - 58px);
      display: grid;
      grid-template-columns: minmax(380px, 460px) 1fr;
      gap: 22px;
      align-items: stretch;
    }
    @media (max-width: 960px) {
      .cl {
        grid-template-columns: 1fr;
        height: auto;
      }
      .plan {
        max-height: none;
      }
    }
    .iv {
      height: 100%;
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
    }

    .iv__thread {
      flex: 1;
      overflow-y: auto;
      padding: 20px 26px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .iv__ctx {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding-bottom: 6px;
    }
    .iv__ctxt {
      font-size: 12.5px;
      color: var(--faint);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .brow {
      display: flex;
      gap: 10px;
      align-items: flex-end;
    }
    .brow--me {
      justify-content: flex-end;
    }
    .bav {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--a600);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }
    .bub {
      max-width: 78%;
      padding: 10px 14px;
      font-size: 14.5px;
      line-height: 1.45;
      width: fit-content;
    }
    .bub--ai {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px 14px 14px 4px;
      color: var(--fg1);
    }
    .bub--me {
      background: var(--a600);
      color: #fff;
      border-radius: 14px 14px 4px 14px;
    }
    .bub--skip {
      background: var(--surface-2);
      color: var(--muted);
      font-size: 13px;
    }
    .bsub {
      display: block;
      margin-top: 4px;
      font-size: 12.5px;
      color: var(--muted);
    }
    .esc__row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 10px;
    }
    .typing {
      color: var(--muted);
      font-size: 12.5px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .typing span {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--faint);
      animation: iv-tb 1s infinite;
    }
    .typing span:nth-child(2) {
      animation-delay: 0.15s;
    }
    .typing span:nth-child(3) {
      animation-delay: 0.3s;
      margin-right: 4px;
    }
    @keyframes iv-tb {
      0%,
      60%,
      100% {
        opacity: 0.35;
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
    /* ── the docked AskUserQuestion panel ── */
    .iv__foot {
      padding: 10px 26px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .dock {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: var(--shadow-pop);
      overflow: hidden;
    }
    .dock__opt {
      display: flex;
      align-items: flex-start;
      gap: 11px;
      width: 100%;
      text-align: left;
      padding: 10px 15px;
      border: none;
      border-top: 1px solid var(--hairline);
      background: none;
      cursor: pointer;
      font-family: var(--body);
      transition: background var(--dur-i) var(--ease);
    }
    .dock__opt--top {
      border-top: none; /* the first row is the panel's top edge now the header is gone */
    }
    .dock__opt.on {
      background: var(--surface-2);
    }
    .dock__opt:active {
      background: var(--surface-3);
    }
    .dock__k {
      width: 21px;
      height: 21px;
      border-radius: 5px;
      background: var(--surface-3);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      flex: 0 0 auto;
    }
    .dock__opt.on .dock__k {
      background: var(--surface);
      color: var(--fg1);
    }
    .dock__k--pen {
      color: var(--faint);
    }
    .dock__body {
      flex: 1;
      min-width: 0;
      line-height: 1.4;
    }
    .dock__t {
      font-size: 14px;
      font-weight: 500;
      color: var(--fg1);
    }
    .dock__d {
      font-size: 12.5px;
      color: var(--muted);
      margin-left: 6px;
    }
    .dock__ret {
      color: var(--faint);
      font-size: 13px;
      flex: 0 0 auto;
    }
    .dock__row {
      justify-content: space-between;
      cursor: default;
      padding-top: 8px;
      padding-bottom: 8px;
    }
    .dock__row:active {
      background: none;
    }
    .dock__else {
      flex: 1;
      min-width: 0;
      background: none;
      border: none;
      outline: none;
      resize: none;
      cursor: text;
      font-family: var(--body);
      font-size: 13.5px;
      line-height: 1.4;
      color: var(--fg1);
      padding: 0;
      field-sizing: content; /* auto-grow with content; long custom answers wrap */
      max-height: 96px;
      overflow-y: auto;
    }
    .dock__else::placeholder {
      color: var(--faint);
    }
    .dock__go {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--faint);
      font-size: 13px;
      padding: 2px 4px;
      flex: 0 0 auto;
      transition: color var(--dur) var(--ease);
    }
    .dock__go:hover {
      color: var(--fg1);
    }
    .dock__skip {
      background: var(--surface-3);
      border: none;
      border-radius: 7px;
      cursor: pointer;
      font-family: var(--body);
      font-size: 12.5px;
      font-weight: 500;
      color: var(--fg1);
      padding: 5px 13px;
      flex: 0 0 auto;
    }
    .dock__skip:hover {
      background: var(--border-strong);
    }
    .comp {
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: 14px;
      padding: 8px 10px;
      transition:
        border-color var(--dur) var(--ease),
        box-shadow var(--dur) var(--ease);
    }
    .comp:focus-within {
      border-color: var(--a400);
      box-shadow: 0 0 0 3px rgba(189, 3, 247, 0.18);
    }
    .comp--over {
      border-color: var(--a400);
      border-style: dashed;
      background: var(--a50);
    }
    .comp__files {
      padding: 2px 2px 8px;
      border-bottom: 1px solid var(--hairline);
      margin-bottom: 6px;
    }
    .comp__row {
      display: flex;
      align-items: flex-end;
      gap: 10px;
    }
    .comp__add {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      border: 1px solid var(--border-strong);
      background: var(--surface);
      color: var(--muted);
      cursor: pointer;
      flex: 0 0 auto;
      transition:
        color var(--dur) var(--ease),
        border-color var(--dur) var(--ease);
    }
    .comp__add:hover {
      color: var(--fg1);
      border-color: var(--faint);
    }
    .comp__in {
      flex: 1;
      min-width: 0;
      border: none;
      background: none;
      outline: none;
      resize: none;
      font-family: var(--body);
      font-size: 15px;
      line-height: 1.4;
      color: var(--fg1);
      padding: 4px 0;
      field-sizing: content; /* grow into a multi-line composer as you type */
      max-height: 140px;
      overflow-y: auto;
    }
    .comp__in::placeholder {
      color: var(--faint);
    }
    .comp__send {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      border: none;
      background: var(--accent);
      cursor: pointer;
      flex: 0 0 auto;
      transition: background var(--dur) var(--ease);
    }
    .comp__send:hover {
      background: var(--accent-hover);
    }
    .attach__err {
      margin: 0;
    }
    .iv__keys {
      text-align: center;
      font-size: 11.5px;
      color: var(--faint);
    }
    @media (max-width: 560px) {
      .bub {
        max-width: 92%;
      }
      .iv__keys {
        display: none;
      }
    }
  `,
})
export class Interview implements OnInit {
  api = inject(Api);
  draft = inject(IntakeDraft);
  id = Number(inject(ActivatedRoute).snapshot.paramMap.get('id'));
  private router = inject(Router);

  st = signal<InterviewState | null>(null);
  req = signal<RequestDetail | null>(null);
  busy = signal(false);
  msg = signal('');
  /** free-text typed inline in the "Something else" row of the docked panel */
  elseText = signal('');
  /** highlighted option index in the docked panel (↑↓ / hover) */
  hi = signal(0);
  /** the × on the panel hides it for the current question (reply directly instead) */
  dismissed = signal(false);
  /** a file is being dragged over the composer */
  dragOver = signal(false);

  /** the question text streaming in token-by-token (empty when not streaming) */
  streaming = signal(false);

  /** a request is in flight, the server is generating, or the question is streaming
   *  in — the composer holds and the thinking/streaming row shows for all three */
  working = computed(() => this.busy() || !!this.st()?.thinking || this.streaming());

  private destroyed = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private closeStreamFn: (() => void) | null = null;
  /** the interview was live in this session (a question was asked) — so when it finishes
   *  we advance to Review. Stays false when we merely land on an already-finished interview
   *  (returned via "Add more detail"), so we don't bounce straight back to Review. */
  private sawQuestion = false;
  private advancing = false;

  private thread = viewChild<ElementRef<HTMLDivElement>>('thread'); // absent during the basics intro phase

  /** keep the newest turn in view — the thread grows from the bottom */
  private scrollToEnd() {
    setTimeout(() => {
      const el = this.thread()?.nativeElement;
      el?.scrollTo({ top: el.scrollHeight });
    });
  }

  turns = computed(() => this.st()?.turns.filter((t) => t.answer !== null || t.skipped) ?? []);

  /** a pending mid-interview type-change proposal from the brain (ADR 0023), or null */
  escalation = computed(() => this.st()?.escalation ?? null);

  planPanel = viewChild(PlanPanel); // absent during the basics intro phase

  /** Clarify arrives in two beats: first ONLY the basics (centered, while the
   *  first question pre-generates), then the chat + plan animate in. Landing on
   *  an interview that already progressed skips the intro. */
  phase = signal<'basics' | 'full'>('basics');
  private introDecided = false;
  private maybeReveal() {
    if (this.phase() === 'full') return;
    const progressed = this.turns().length > 0 || !!this.st()?.done;
    if (progressed) {
      this.phase.set('full'); // returning to a live interview skips the intro
      return;
    }
    // completed basics on ARRIVAL skip the intro; completing them during the
    // intro does not — the submitter starts the interview with the button
    if (!this.introDecided && this.req()) {
      this.introDecided = true;
      if (basicsAnswered(this.draft, this.req()!.type)) this.phase.set('full');
    }
  }
  nudge = signal(false);
  startInterview() {
    // ngModel keeps the draft current on every keystroke, so this reads fresh
    if (basicsAnswered(this.draft, this.req()?.type ?? this.draft.type)) {
      this.basicsBump.update((n) => n + 1); // facts strip snapshots the answers
      this.phase.set('full');
    } else {
      this.nudge.set(true);
    }
  }
  /** re-evaluate canStart()/facts() when the (non-signal) draft changes */
  private basicsBump = signal(0);

  /** the quick answers, pinned atop the plan */
  facts = computed<[string, string][]>(() => {
    this.basicsBump();
    const r = this.req();
    const d = this.draft;
    const out: [string, string][] = [];
    if (r)
      out.push([
        'Request',
        {
          bug: 'Fix a problem',
          enh: 'Improve an app',
          new: 'Build a new app',
          other: 'Something else',
        }[r.type] ?? r.type,
      ]);
    if ((r?.type === 'bug' || r?.type === 'enh') && d.appName) out.push(['App', d.appName]);
    if (r?.type === 'bug') {
      const evidence = [
        d.bugWhere.trim(),
        d.attachments().some((a) => a.kind === 'image') ? 'Screenshot attached' : '',
      ].filter(Boolean);
      if (evidence.length) out.push(['Evidence', evidence.join(' + ')]);
      if (d.bugFreq)
        out.push([
          'How often?',
          {
            'Every time': 'Every time',
            'Most of the time': 'Usually',
            Sometimes: 'Sometimes',
            'Only once so far': 'It happened once',
          }[d.bugFreq] ?? d.bugFreq,
        ]);
    } else {
      const reachLabels: Record<string, string> = {
        me: 'Only me',
        team: 'My team',
        dept: 'My department',
        wider: 'Several departments',
        site: 'One site',
        network: 'Across sites',
      };
      const reach = d.reachText.trim() || (d.reach ? reachLabels[d.reach] : '');
      if (reach)
        out.push([
          r?.type === 'enh'
            ? 'Who benefits?'
            : r?.type === 'other'
              ? 'Who is this for?'
              : 'Who will use it?',
          reach,
        ]);
      if (d.impactMetric && d.impactValue.trim()) {
        const v = d.impactValue.trim();
        out.push([
          r?.type === 'other' ? 'Expected outcome' : 'Expected benefit',
          { hours: `${v} hours saved/year`, cost: `$${v}k saved/year`, other: v }[d.impactMetric],
        ]);
      }
    }
    return out;
  });

  showKeys = computed(() => {
    const s = this.st();
    return !!s && !s.done && !this.working() && !!s.options && !this.dismissed();
  });

  /** The active prompt for the sr-only aria-live region, so a screen reader hears
   *  each new question (the question changes in place — never re-read otherwise). */
  liveQuestion = computed(() => {
    if (this.working()) return 'Reading your answer…';
    const s = this.st();
    if (!s) return '';
    if (s.done) return "Thanks — that's everything I need. Check the summary next.";
    return s.question ?? '';
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.closeStream();
    });
    // decide the arrival phase once the request/interview state land
    effect(() => {
      this.req();
      this.st();
      this.maybeReveal();
    });
    // Once the interview is live, its finish auto-advances to the next step (Prototype for a
    // new app, else Review) — no manual click.
    effect(() => {
      const s = this.st();
      if (!s) return;
      if (!s.done) {
        this.sawQuestion = true;
        this.advancing = false; // a reopened interview may finish (and advance) again
      } else if (this.sawQuestion && !this.advancing && !this.destroyed) {
        this.advancing = true;
        this.router.navigate(['/submit', this.id, this.nextStep()]);
      }
    });
  }

  ngOnInit() {
    void this.draft.loadAttachments(this.id);
    this.api.request(this.id).subscribe((r) => this.req.set(r));
    this.busy.set(true); // show the thinking row until the first question lands
    this.load(true);
  }

  /** Read the current state (without kicking pre-generation); if a question still
   *  needs generating, open the SSE stream so it types in live. */
  private load(initial = false) {
    this.api.interview(this.id, false).subscribe({
      next: (s) => {
        this.st.set(s);
        this.busy.set(false);
        if (initial) this.scrollToEnd();
        if (s.thinking) this.openStream();
      },
      error: () => this.busy.set(false),
    });
  }

  /** Drive the next-question generation over SSE: the terminal `state` event carries the
   *  finished InterviewState. Falls back to polling on error. */
  private openStream() {
    this.closeStream();
    if (this.destroyed) return;
    this.streaming.set(true);
    this.closeStreamFn = streamState<InterviewState>(
      this.api.interviewStreamUrl(this.id),
      (s) => {
        this.closeStream();
        this.busy.set(false);
        if (s && typeof s.asked === 'number') this.st.set(s);
        else this.poll(); // empty state → recover via the poll fallback
        this.scrollToEnd();
      },
      () => {
        this.closeStream();
        this.poll(); // network/SSE hiccup → fall back to polling (which kicks pre-gen)
      },
    );
  }

  private closeStream() {
    if (this.closeStreamFn) {
      this.closeStreamFn();
      this.closeStreamFn = null;
    }
    this.streaming.set(false);
  }

  /** Fallback when SSE is unavailable: GET with gen=1 (kicks background pre-gen), then
   *  re-poll every ~1.5s while the server is thinking. */
  private poll() {
    if (this.destroyed) return;
    this.api.interview(this.id, true).subscribe({
      next: (s) => {
        this.st.set(s);
        this.scheduleNextPoll(s);
      },
      error: () => this.busy.set(false), // give up quietly; the batch GET stays retryable
    });
  }

  /** Keep exactly one pending poll: re-fetch in ~1.5s while the server is thinking. */
  private scheduleNextPoll(s: InterviewState) {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (s.thinking && !this.destroyed) {
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null;
        this.poll();
      }, 1500);
    }
  }

  composerPlaceholder() {
    const s = this.st();
    if (!s || s.done) return 'Add more detail…';
    return s.options && !this.dismissed() ? 'Or reply directly…' : 'Type your answer…';
  }

  /** submit the inline "Something else" free-text as this question's answer */
  submitElse() {
    const text = this.elseText().trim();
    if (text) this.push({ answer: text });
  }

  /** Enter submits; Shift+Enter inserts a newline (the inputs are textareas so long
   *  custom answers wrap instead of scrolling). IME composition Enter is left alone. */
  onEnter(e: Event, which: 'else' | 'composer') {
    const ke = e as KeyboardEvent;
    if (ke.isComposing || ke.shiftKey) return;
    ke.preventDefault();
    if (which === 'else') this.submitElse();
    else this.enter();
  }

  onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) this.draft.addFiles(Array.from(input.files), 'interview');
    input.value = '';
  }
  onDrop(e: DragEvent) {
    e.preventDefault();
    this.dragOver.set(false);
    if (e.dataTransfer?.files.length)
      this.draft.addFiles(Array.from(e.dataTransfer.files), 'interview');
  }
  onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) this.draft.addFiles(files, 'interview');
  }

  private push(body: { answer?: string; skip?: boolean }) {
    if (this.working()) return;
    this.busy.set(true);
    this.scrollToEnd(); // the just-sent answer + typing row
    this.api.answer(this.id, body).subscribe({
      next: (s) => {
        this.st.set(s);
        this.msg.set('');
        this.elseText.set('');
        this.hi.set(0);
        this.dismissed.set(false);
        this.busy.set(false);
        this.scrollToEnd();
        if (s.thinking) this.openStream(); // stream the next question in as it generates
        this.planPanel()?.refresh(); // the answer changes the plan — let it catch up
      },
      error: () => this.busy.set(false),
    });
  }

  answer(label: string) {
    this.push({ answer: label });
  }
  skip() {
    this.push({ skip: true });
  }
  enter() {
    const s = this.st();
    if (!s) return;
    const text = this.msg().trim();
    if (s.done) {
      if (text)
        this.reopen(text); // add more detail → reopen the interview for a follow-up
      else this.toReview();
      return;
    }
    if (text) this.push({ answer: text });
  }
  /** A plain-language word for a request type — used in the escalation prompt copy. */
  typeWord(t: string | null | undefined) {
    return (
      (
        { bug: 'bug fix', enh: 'improvement', new: 'new app', other: 'request' } as Record<
          string,
          string
        >
      )[t ?? ''] ?? 'request'
    );
  }
  /** Consent to the proposed type change (ADR 0023): PATCH the type (lossless — the draft's
   *  other facts persist), then let the request, rows and plan re-shape and continue. */
  acceptEscalation(toType: string) {
    if (this.working()) return;
    this.busy.set(true);
    this.api.escalate(this.id, true, toType).subscribe({
      next: (s) => {
        this.st.set(s);
        this.busy.set(false);
        this.api.request(this.id).subscribe((r) => this.req.set(r)); // type/rows re-shape
        this.planPanel()?.refresh();
      },
      error: () => this.busy.set(false),
    });
  }
  /** Decline the proposal: the type stands and the interview continues (the proposal clears). */
  declineEscalation(toType: string) {
    this.api.escalate(this.id, false, toType).subscribe((s) => this.st.set(s));
  }

  /** the basics Type row changed the request — refresh req (rows, stepper,
   *  labels re-shape) and let the plan catch up */
  onTypeChanged() {
    this.api.request(this.id).subscribe((r) => this.req.set(r));
    this.planPanel()?.refresh();
  }
  onBasicsSaved() {
    this.basicsBump.update((n) => n + 1);
    this.planPanel()?.refresh();
  }
  /** The step after the interview: Prototype for a new app, else Review. */
  nextStep(): 'prototype' | 'review' {
    return this.req()?.type === 'new' ? 'prototype' : 'review';
  }
  toReview() {
    this.draft.extra = this.msg().trim();
    this.router.navigate(['/submit', this.id, this.nextStep()]);
  }

  /** Reopen a finished interview with the submitter's added note (the "Add more detail"
   *  path). The assistant records it and may ask one more follow-up before we return to Review. */
  private reopen(text: string) {
    if (this.working()) return;
    this.busy.set(true);
    this.scrollToEnd();
    this.api.reopenInterview(this.id, text).subscribe({
      next: (s) => {
        this.msg.set('');
        this.st.set(s);
        this.busy.set(false);
        this.scrollToEnd();
        if (s.thinking) this.openStream(); // stream the follow-up (or resolve to done → advance)
        this.planPanel()?.refresh();
      },
      error: () => this.busy.set(false),
    });
  }

  /** Docked-panel keys, exactly claude.ai's AskUserQuestion: ↑↓ moves the
   *  highlight, Enter selects it when the composer is empty — typed text
   *  always wins, and typing is never hijacked by shortcut keys. */
  onKeys(e: KeyboardEvent) {
    if (this.phase() !== 'full') return;
    const s = this.st();
    if (!s || s.done || this.working() || !s.options || this.dismissed()) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const n = s.options.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.hi.set((this.hi() + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.hi.set((this.hi() - 1 + n) % n);
    } else if (e.key === 'Enter' && !this.msg().trim() && !this.elseText().trim()) {
      e.preventDefault();
      this.answer(s.options[this.hi()].t);
    }
  }
}
