import { Component, Injector, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Observable, map } from 'rxjs';
import {
  Api,
  ApproveModal,
  CancelConfirm,
  CommentItem,
  FactoryRequest,
  Poll,
  ProgressEvent,
  RecoveryConfirm,
  RequestDetail,
  SendBackModal,
  SendBackStageModal,
  clock,
  inFlight,
} from '@sf/shared';

import { Session } from '../core/session.service';
import {
  FloorActionError,
  FloorActionVerb,
  floorActionOutcome,
} from '../floor/floor-action-outcome';
import { ConsoleShell } from '../shell/console-shell';
import { DossierChapter, buildDossierChapters } from './dossier-view';

@Component({
  selector: 'sf-dossier-page',
  imports: [
    ConsoleShell,
    ApproveModal,
    SendBackModal,
    SendBackStageModal,
    RecoveryConfirm,
    CancelConfirm,
  ],
  template: `
    <sf-console-shell active="dossier">
      @if (request(); as r) {
        <article class="dossier">
          <header class="dossier-header">
            <div class="identity">
              <span class="ref mono">{{ r.ref }}</span>
              <span class="app">{{ r.app_name }}</span>
              <span>requested by {{ r.reporter }}</span>
            </div>
            <h1>{{ r.title }}</h1>
            <p
              class="state-sentence"
              [attr.data-state]="stateTone(r)"
              role="status"
              aria-live="polite"
            >
              <span class="state-shape" aria-hidden="true">{{ stateShape(r) }}</span>
              {{ stateSentence(r) }}
            </p>
            @if (r.needs_human_reason && r.needs_human) {
              <p class="escalation-reason">
                <strong>Why it stopped</strong> {{ r.needs_human_reason }}
              </p>
            }

            <div class="header-actions" aria-label="Request actions">
              @if (r.gate) {
                <button class="btn primary" type="button" (click)="confirming.set(true)">
                  Approve
                </button>
                <button class="btn" type="button" (click)="sendingBack.set(true)">
                  Send back with a note
                </button>
              } @else if (r.needs_human) {
                <button class="btn primary" type="button" (click)="retrying.set(true)">
                  Retry this stage
                </button>
                <button class="btn" type="button" (click)="sendingStageBack.set(true)">
                  Send back to…
                </button>
                <button class="btn" type="button" (click)="takingOver.set(true)">Take over</button>
              } @else if (isInFlight(r)) {
                <form class="steer" (submit)="$event.preventDefault(); steer()">
                  <label class="sr-only" for="dossier-steer">Steer this run</label>
                  <input
                    id="dossier-steer"
                    type="text"
                    placeholder="Steer this run…"
                    [value]="steerText()"
                    (input)="steerText.set($any($event.target).value)"
                  />
                  <button class="btn" type="submit" [disabled]="!steerText().trim()">Send</button>
                </form>
              }
              @if (canCancel(r)) {
                <button class="btn danger cancel" type="button" (click)="cancelling.set(true)">
                  Cancel
                </button>
              }
            </div>
            @if (actionOutcome(); as outcome) {
              <p
                class="action-outcome"
                [class.conflict]="outcome.kind === 'conflict'"
                role="status"
              >
                {{ outcome.message }}
              </p>
            }
          </header>

          <section class="story" aria-labelledby="story-title">
            <div class="section-heading">
              <div>
                <p class="eyebrow">The full story</p>
                <h2 id="story-title">Timeline</h2>
              </div>
              <p>Open any chapter for the unedited evidence beneath it.</p>
            </div>

            <ol class="timeline">
              @if (traceTruncated()) {
                <li class="trace-limit" role="status">
                  Showing the latest 500 events. This may omit older evidence because the current
                  trace endpoint has no backward cursor.
                </li>
              }
              @for (chapter of chapters(); track chapter.id) {
                <li
                  class="chapter"
                  [id]="chapter.id"
                  [attr.data-kind]="chapter.kind"
                  [class.open]="openChapter() === chapter.id"
                >
                  <span class="spine-shape" aria-hidden="true">{{ chapter.glyph }}</span>
                  <div class="chapter-card">
                    <button
                      class="chapter-toggle"
                      type="button"
                      [attr.aria-expanded]="openChapter() === chapter.id"
                      [attr.aria-controls]="chapter.id + '-evidence'"
                      (click)="toggleChapter(chapter.id)"
                    >
                      <span class="chapter-copy">
                        <span class="chapter-meta">
                          <span class="kind-word">{{ chapter.statusWord }}</span>
                          <span>{{ chapter.label }}</span>
                        </span>
                        <span class="chapter-title" role="heading" aria-level="3">{{
                          chapterTitle(chapter)
                        }}</span>
                        @if (chapter.steerState; as steerState) {
                          <span class="steer-state" [class.heard]="steerState.state === 'heard'">
                            {{
                              steerState.state === 'heard'
                                ? 'heard ✓ at step ' + (steerState.atStep ?? 'unknown')
                                : 'queued'
                            }}
                          </span>
                        }
                        @if (chapter.decidedBy && chapter.decidedAt) {
                          <span class="signature">
                            decided by {{ chapter.decidedBy }} ·
                            <time [attr.datetime]="chapter.decidedAt">{{
                              signedTime(chapter.decidedAt)
                            }}</time>
                          </span>
                        }
                      </span>
                      <span class="drawer-label" aria-hidden="true">
                        {{ openChapter() === chapter.id ? 'Hide evidence ↑' : 'Raw evidence ↓' }}
                      </span>
                    </button>

                    @if (openChapter() === chapter.id) {
                      <div
                        class="evidence-drawer"
                        [id]="chapter.id + '-evidence'"
                        role="region"
                        [attr.aria-label]="'Raw evidence for ' + chapter.label"
                      >
                        @for (raw of chapter.events; track raw.id) {
                          <article class="raw-event">
                            <div class="raw-head mono">
                              <span>#{{ raw.id }} · {{ raw.kind }} · {{ raw.stage }}</span>
                              <time [attr.datetime]="raw.created_at">{{
                                signedTime(raw.created_at)
                              }}</time>
                            </div>
                            <p>
                              <strong>{{ raw.actor }}</strong> · {{ raw.title }}
                            </p>
                            @if (raw.body) {
                              <p>{{ raw.body }}</p>
                            }
                            @if (raw.payload) {
                              <pre>{{ payloadJson(raw.payload) }}</pre>
                            }
                          </article>
                        }
                        @if (r.attachments?.length) {
                          <div class="drawer-attachments">
                            <h3>Attachments</h3>
                            <ul>
                              @for (attachment of r.attachments; track attachment.id) {
                                <li>
                                  <a
                                    [href]="api.attachmentRawUrl(attachment.id)"
                                    target="_blank"
                                    rel="noopener"
                                    >{{ attachment.filename }}</a
                                  >
                                  <span class="mono">{{ attachment.mime }}</span>
                                </li>
                              }
                            </ul>
                          </div>
                        }
                      </div>
                    }
                  </div>
                </li>
              } @empty {
                <li class="empty-story">
                  No trace yet — the first chapter appears when work begins.
                </li>
              }
            </ol>
          </section>

          <section class="comments" aria-labelledby="comments-title">
            <div class="section-heading">
              <div>
                <p class="eyebrow">Discussion</p>
                <h2 id="comments-title">Comments</h2>
              </div>
              <p>Every note lands on {{ r.ref }}.</p>
            </div>
            <ol class="comment-thread">
              @for (comment of comments(); track comment.id) {
                <li>
                  <span
                    class="comment-avatar"
                    [style.background]="comment.color"
                    aria-hidden="true"
                  >
                    {{ comment.initials }}
                  </span>
                  <div>
                    <p class="comment-signature">
                      <strong>{{ comment.author }}</strong>
                      <time [attr.datetime]="comment.created_at">{{
                        signedTime(comment.created_at)
                      }}</time>
                    </p>
                    <p>{{ comment.body }}</p>
                  </div>
                </li>
              } @empty {
                <li class="no-comments">No comments yet.</li>
              }
            </ol>
            <form class="composer" (submit)="$event.preventDefault(); postComment()">
              <label for="dossier-comment">Add a comment to {{ r.ref }}</label>
              <textarea
                id="dossier-comment"
                rows="3"
                placeholder="Leave a comment…"
                [value]="commentText()"
                (input)="commentText.set($any($event.target).value)"
              ></textarea>
              <button class="btn primary" type="submit" [disabled]="!commentText().trim()">
                Comment
              </button>
            </form>
          </section>
        </article>
      } @else {
        <p class="loading" role="status">Opening this request’s story…</p>
      }
    </sf-console-shell>

    @if (confirming() && request(); as r) {
      <sf-approve-modal [r]="r" (cancelled)="confirming.set(false)" (approved)="approve()" />
    }
    @if (sendingBack() && request(); as r) {
      <sf-send-back-modal
        [reporter]="r.reporter"
        hint="Say what must change before this can move forward."
        placeholder="Add a clear note…"
        (cancelled)="sendingBack.set(false)"
        (sent)="sendBack($event)"
      />
    }
    @if (retrying()) {
      <sf-recovery-confirm
        title="Retry this stage?"
        [consequence]="'Re-runs the ' + stageLabel(request()!.stage) + ' stage from the top.'"
        confirmLabel="Retry stage"
        (kept)="retrying.set(false)"
        (confirmed)="retry()"
      />
    }
    @if (takingOver()) {
      <sf-recovery-confirm
        title="Take over this request?"
        consequence="Stops automation. You’ll finish this request by hand in the PR."
        confirmLabel="Take over"
        (kept)="takingOver.set(false)"
        (confirmed)="takeOver()"
      />
    }
    @if (sendingStageBack() && request(); as r) {
      <sf-send-back-stage-modal
        [currentStage]="r.stage"
        (cancelled)="sendingStageBack.set(false)"
        (sent)="sendBackToStage($event)"
      />
    }
    @if (cancelling() && request(); as r) {
      <sf-cancel-confirm [r]="r" (kept)="cancelling.set(false)" (confirmed)="cancel()" />
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .dossier {
      padding: 42px 0 96px;
    }
    .dossier-header {
      padding: 26px 28px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
    }
    .identity,
    .chapter-meta,
    .signature,
    .comment-signature,
    .raw-head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 6px 12px;
      color: var(--muted);
      font-size: 12.5px;
    }
    .ref {
      color: var(--fg2);
      font-size: 11.5px;
    }
    .app {
      padding: 3px 11px;
      color: var(--accent-tx);
      background: var(--accent-tint);
      border-radius: var(--r-pill);
      font-weight: 600;
    }
    h1 {
      max-width: 760px;
      margin: 14px 0 10px;
      font-size: clamp(28px, 4vw, 42px);
    }
    .state-sentence {
      display: flex;
      align-items: center;
      gap: 9px;
      margin: 0;
      color: var(--fg2);
      font-size: 15px;
      font-weight: 500;
    }
    .state-shape {
      color: var(--accent-tx);
      font-family: var(--mono);
    }
    .state-sentence[data-state='gate'] .state-shape {
      color: var(--amber-tx);
    }
    .state-sentence[data-state='human'] .state-shape {
      color: var(--red-tx);
    }
    .state-sentence[data-state='success'] .state-shape {
      color: var(--green-tx);
    }
    .escalation-reason {
      margin: 16px 0 0;
      padding: 10px 13px;
      color: var(--red-tx);
      background: var(--red-bg);
      border: 1px solid var(--red-line);
      border-radius: var(--r);
      font-size: 13px;
    }
    .escalation-reason strong {
      margin-right: 8px;
    }
    .header-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 9px;
      margin-top: 22px;
    }
    .btn {
      padding: 8px 17px;
      color: var(--fg1);
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--r-pill);
      font-size: 13.5px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn:hover:not(:disabled) {
      background: var(--surface-2);
    }
    .btn.primary {
      color: #fff;
      background: var(--accent);
      border-color: var(--accent);
    }
    .btn.primary:hover:not(:disabled) {
      background: var(--accent-hover);
    }
    .btn.danger {
      color: var(--red-tx);
      border-color: var(--red-line);
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .cancel {
      margin-left: auto;
    }
    .steer {
      display: flex;
      flex: 1 1 480px;
      gap: 8px;
      max-width: 620px;
    }
    .steer input,
    .composer textarea {
      width: 100%;
      color: var(--fg1);
      background: var(--surface);
      border: 1px solid var(--border-strong);
      outline: none;
      font: 400 13.5px var(--body);
    }
    .steer input {
      padding: 8px 14px;
      border-radius: var(--r-pill);
    }
    .steer input:focus,
    .composer textarea:focus {
      border-color: var(--accent);
    }
    .action-outcome {
      margin: 14px 0 0;
      color: var(--muted);
      font-size: 12.5px;
    }
    .action-outcome.conflict {
      color: var(--fg2);
      font-weight: 600;
    }
    .story,
    .comments {
      margin-top: 48px;
    }
    .section-heading {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 18px;
    }
    .section-heading h2 {
      font-size: 25px;
    }
    .section-heading > p {
      max-width: 420px;
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      text-align: right;
    }
    .eyebrow {
      margin: 0 0 3px;
      color: var(--accent-tx);
      font: 600 11px var(--mono);
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .timeline,
    .comment-thread {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .chapter {
      position: relative;
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 12px;
      padding-bottom: 14px;
    }
    .chapter::before {
      content: '';
      position: absolute;
      top: 26px;
      bottom: -2px;
      left: 13px;
      width: 1px;
      background: var(--border);
    }
    .chapter:last-child::before {
      display: none;
    }
    .spine-shape {
      position: relative;
      z-index: 1;
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      margin-top: 14px;
      color: var(--accent-tx);
      background: var(--bg);
      font: 600 13px var(--mono);
    }
    .chapter[data-kind='gate'] .spine-shape,
    .chapter[data-kind='gate'] .kind-word {
      color: var(--amber-tx);
    }
    .chapter[data-kind='escalation'] .spine-shape,
    .chapter[data-kind='escalation'] .kind-word {
      color: var(--red-tx);
    }
    .chapter[data-kind='recovery'] .spine-shape,
    .chapter[data-kind='recovery'] .kind-word {
      color: var(--green-tx);
    }
    .chapter-card {
      overflow: hidden;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
    }
    .chapter.open .chapter-card {
      border-color: var(--border-strong);
    }
    .chapter-toggle {
      display: flex;
      width: 100%;
      align-items: center;
      justify-content: space-between;
      gap: 22px;
      padding: 16px 19px;
      color: var(--fg1);
      background: transparent;
      border: 0;
      text-align: left;
      cursor: pointer;
    }
    .chapter-toggle:hover {
      background: var(--surface-2);
    }
    .chapter-copy {
      display: grid;
      gap: 5px;
      min-width: 0;
    }
    .chapter-title {
      overflow-wrap: anywhere;
      font: 600 15px var(--display);
    }
    .kind-word {
      color: var(--accent-tx);
      font-weight: 700;
    }
    .signature {
      font-size: 11.5px;
    }
    .steer-state {
      width: fit-content;
      padding: 2px 9px;
      color: var(--muted);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--r-pill);
      font-size: 11.5px;
      font-weight: 600;
    }
    .steer-state.heard {
      color: var(--green-tx);
      background: var(--green-bg);
      border-color: var(--green-line);
    }
    .drawer-label {
      flex: none;
      color: var(--accent-link);
      font: 500 11.5px var(--mono);
    }
    .evidence-drawer {
      padding: 8px 19px 18px;
      background: var(--surface-2);
      border-top: 1px solid var(--hairline);
    }
    .raw-event {
      padding: 14px 0;
      border-bottom: 1px solid var(--border);
    }
    .raw-event:last-of-type {
      border-bottom: 0;
    }
    .raw-head {
      justify-content: space-between;
      font-size: 10.5px;
    }
    .raw-event p {
      margin: 8px 0 0;
      color: var(--fg2);
      font-size: 13px;
    }
    pre {
      overflow-x: auto;
      margin: 10px 0 0;
      padding: 11px 12px;
      color: var(--fg2);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r);
      font: 400 11px/1.55 var(--mono);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .drawer-attachments {
      padding-top: 14px;
    }
    .drawer-attachments h3 {
      font-size: 13px;
    }
    .drawer-attachments ul {
      margin: 8px 0 0;
      padding: 0;
      list-style: none;
    }
    .drawer-attachments li {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 7px 0;
      font-size: 12px;
    }
    .drawer-attachments a {
      color: var(--accent-link);
    }
    .drawer-attachments span {
      color: var(--faint);
      font-size: 10.5px;
    }
    .empty-story,
    .trace-limit,
    .no-comments,
    .loading {
      padding: 28px;
      color: var(--muted);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      text-align: center;
    }
    .loading {
      margin: 64px 0;
    }
    .trace-limit {
      margin: 0 0 14px 40px;
      padding: 10px 14px;
      color: var(--amber-tx);
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
      text-align: left;
      font-size: 12.5px;
    }
    .comments {
      padding-top: 4px;
      border-top: 1px solid var(--hairline);
    }
    .comment-thread {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
    }
    .comment-thread li {
      display: grid;
      grid-template-columns: 32px 1fr;
      gap: 12px;
      padding: 15px 18px;
      border-bottom: 1px solid var(--hairline);
    }
    .comment-thread li:last-child {
      border-bottom: 0;
    }
    .comment-thread p {
      margin: 0;
      color: var(--fg2);
      font-size: 13.5px;
    }
    .comment-thread .comment-signature {
      margin-bottom: 4px;
      font-size: 11.5px;
    }
    .comment-signature strong {
      color: var(--fg1);
      font-size: 13px;
    }
    .comment-avatar {
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      color: #fff;
      border-radius: 50%;
      font-size: 10px;
      font-weight: 700;
    }
    .composer {
      display: grid;
      gap: 8px;
      margin-top: 13px;
      padding: 18px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
    }
    .composer label {
      color: var(--fg2);
      font-size: 12.5px;
      font-weight: 600;
    }
    .composer textarea {
      min-height: 74px;
      padding: 10px 12px;
      border-radius: var(--r);
      resize: vertical;
    }
    .composer .btn {
      justify-self: end;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    @media (max-width: 640px) {
      .dossier {
        padding-top: 24px;
      }
      .dossier-header {
        padding: 21px 18px;
      }
      .header-actions,
      .header-actions .btn,
      .steer {
        width: 100%;
      }
      .header-actions .btn {
        text-align: center;
      }
      .cancel {
        margin-left: 0;
      }
      .section-heading {
        display: block;
      }
      .section-heading > p {
        margin-top: 6px;
        text-align: left;
      }
      .chapter {
        grid-template-columns: 18px minmax(0, 1fr);
        gap: 8px;
      }
      .chapter::before {
        left: 8px;
      }
      .spine-shape {
        width: 18px;
      }
      .chapter-toggle {
        align-items: flex-start;
        padding: 15px;
      }
      .drawer-label {
        max-width: 58px;
        text-align: right;
      }
      .evidence-drawer {
        padding-inline: 15px;
      }
      .raw-head,
      .drawer-attachments li {
        display: grid;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        scroll-behavior: auto !important;
        transition: none !important;
      }
    }
  `,
})
export class DossierPage {
  protected api = inject(Api);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private poll = inject(Poll);
  private session = inject(Session);
  private injector = inject(Injector);

  id = toSignal(this.route.paramMap.pipe(map((params) => Number(params.get('id')))), {
    initialValue: Number(this.route.snapshot.paramMap.get('id')),
    injector: this.injector,
  });
  private fragment = toSignal(this.route.fragment, {
    initialValue: this.route.snapshot.fragment,
    injector: this.injector,
  });
  request = signal<RequestDetail | null>(null);
  events = signal<ProgressEvent[]>([]);
  comments = signal<CommentItem[]>([]);
  traceTruncated = signal(false);
  chapters = computed(() => buildDossierChapters(this.events()));
  openChapter = signal<string | null>(null);
  actionOutcome = signal<{ kind: 'conflict' | 'error'; message: string } | null>(null);
  commentText = signal('');
  steerText = signal('');

  confirming = signal(false);
  sendingBack = signal(false);
  retrying = signal(false);
  takingOver = signal(false);
  sendingStageBack = signal(false);
  cancelling = signal(false);

  isInFlight = inFlight;

  constructor() {
    let lastId: number | null = null;
    effect(() => {
      const id = this.id();
      this.poll.version();
      if (id !== lastId) {
        lastId = id;
        this.request.set(null);
        this.events.set([]);
        this.comments.set([]);
        this.traceTruncated.set(false);
        this.actionOutcome.set(null);
      }
      this.refresh();
    });
    effect(() => {
      const fragment = this.fragment();
      this.openChapter.set(fragment?.startsWith('chapter-') ? fragment : null);
    });
  }

  private refresh() {
    const id = this.id();
    this.api.request(id).subscribe((request) => this.request.set(request));
    this.api.trace(id, 0, 500).subscribe((trace) => {
      this.events.set(trace.items);
      this.traceTruncated.set(trace.items.length === 500);
    });
    this.refreshComments();
  }

  private refreshComments() {
    this.api.comments(this.id()).subscribe((comments) => this.comments.set(comments));
  }

  stateSentence(request: RequestDetail): string {
    if (request.needs_human) return 'Needs human — automation stopped';
    if (request.gate === 'approve_spec') return 'Waiting at the spec gate';
    if (request.gate === 'approve_merge') return 'Waiting at the merge gate';
    if (request.status === 'human_owned') {
      const owner = [...this.events()]
        .reverse()
        .find(
          (event) => event.kind === 'recovery_action' && /taken over/i.test(event.title),
        )?.actor;
      return `Human-owned — ${owner ?? 'an operator'} is finishing by hand`;
    }
    if (request.status === 'done') return 'Shipped';
    if (request.status === 'sent_back') return 'Sent back to the submitter';
    if (request.status === 'cancelled') return 'Cancelled';
    if (request.run)
      return `Building · ${this.stageLabel(request.stage)} · step ${request.run.step} of ${request.run.of}`;
    if (request.status === 'approved') return `Building · ${this.stageLabel(request.stage)}`;
    if (request.status === 'pending_approval') return 'Waiting for approval';
    return `In ${this.stageLabel(request.stage).toLowerCase()}`;
  }

  stateShape(request: RequestDetail): string {
    if (request.needs_human) return '▲';
    if (request.gate) return '◆';
    if (request.status === 'done') return '✓';
    if (request.status === 'cancelled') return '—';
    if (request.status === 'human_owned' || request.status === 'sent_back') return '↳';
    return '●';
  }

  stateTone(request: RequestDetail): 'gate' | 'human' | 'success' | 'neutral' {
    if (request.needs_human) return 'human';
    if (request.gate) return 'gate';
    if (request.status === 'done') return 'success';
    return 'neutral';
  }

  stageLabel(stage: FactoryRequest['stage']): string {
    if (stage === 'architecture') return 'Plan';
    return stage[0].toUpperCase() + stage.slice(1);
  }

  canCancel(request: RequestDetail): boolean {
    return !['done', 'cancelled'].includes(request.status);
  }

  chapterTitle(chapter: DossierChapter): string {
    if (chapter.kind !== 'stage') return chapter.title;
    const event = chapter.events[chapter.events.length - 1];
    const label = event.payload?.['label'];
    const step = event.payload?.['step'];
    const of = event.payload?.['of'];
    if (typeof label === 'string' && typeof step === 'number' && typeof of === 'number')
      return `${label} · step ${step} of ${of}`;
    return event.title;
  }

  signedTime(iso: string): string {
    return `${new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${clock(iso)}`;
  }

  payloadJson(payload: Record<string, unknown>): string {
    return JSON.stringify(payload, null, 2);
  }

  toggleChapter(id: string) {
    const next = this.openChapter() === id ? null : id;
    this.openChapter.set(next);
    void this.router.navigateByUrl(`/requests/${this.id()}${next ? `#${next}` : ''}`);
  }

  approve() {
    this.confirming.set(false);
    this.runAction('approve', this.api.approve(this.id(), this.session.operatorId()!));
  }

  sendBack(note: string) {
    this.sendingBack.set(false);
    this.runAction('send back', this.api.sendBack(this.id(), note, this.session.operatorId()!));
  }

  retry() {
    this.retrying.set(false);
    this.runAction('retry', this.api.retry(this.id(), this.session.operatorId()!));
  }

  takeOver() {
    this.takingOver.set(false);
    this.runAction('take over', this.api.takeOver(this.id(), this.session.operatorId()!));
  }

  sendBackToStage(choice: { stage: 'architecture' | 'build' | 'review'; reason: string }) {
    this.sendingStageBack.set(false);
    this.runAction(
      'send back to stage',
      this.api.sendBackToStage(this.id(), choice.stage, choice.reason, this.session.operatorId()!),
    );
  }

  cancel() {
    this.cancelling.set(false);
    this.runAction('cancel', this.api.cancel(this.id(), this.session.operatorId()!));
  }

  steer() {
    const note = this.steerText().trim();
    if (!note) return;
    this.runAction('steer', this.api.steer(this.id(), note, this.session.operatorId()!));
    this.steerText.set('');
  }

  postComment() {
    const body = this.commentText().trim();
    if (!body) return;
    this.api.comment(this.id(), body, this.session.operatorId()!).subscribe({
      next: () => {
        this.commentText.set('');
        this.refresh();
        this.poll.nudge();
      },
      error: () =>
        this.actionOutcome.set({ kind: 'error', message: 'Couldn’t comment. Try again.' }),
    });
  }

  private runAction(verb: FloorActionVerb, action: Observable<unknown>) {
    action.subscribe({
      next: () => {
        this.actionOutcome.set(null);
        this.refresh();
        this.poll.nudge();
      },
      error: (error: FloorActionError) => {
        this.actionOutcome.set(floorActionOutcome(verb, error));
        this.refresh();
        this.poll.nudge();
      },
    });
  }
}
