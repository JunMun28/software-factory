import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';

import {
  Api,
  ApproveModal,
  Avatar,
  CancelConfirm,
  EscalationBox,
  EvidenceStrip,
  Glyph,
  Icon,
  Poll,
  ProgressEvent,
  RequestDetail,
  SendBackModal,
  TraceGroup,
  TypeChip,
  adminStateLine,
  groupTrace,
  timeAgo,
} from '@sf/shared';
import { Session } from '../core/session.service';
import { DeliveryGate, DeliveryStage, deliveryGates, deliveryStages } from '../core/map-view';
import { AdminShell } from './admin-shell';

/** Request detail (spec §6) — the supervision replacement for the Jira issue page.
 *  Header: waiting-on / decided-by. Body: the stage-grouped trace timeline.
 *  No assignee/labels/attachments/checklist/subscribers — deliberately gone.
 *  Actions (gate approve/send-back, recovery, comments) ship in Task 5. */
@Component({
  selector: 'sf-request-detail-page',
  imports: [
    AdminShell,
    Glyph,
    Icon,
    TypeChip,
    EvidenceStrip,
    Avatar,
    FormsModule,
    ApproveModal,
    SendBackModal,
    CancelConfirm,
    EscalationBox,
  ],
  template: `
    <admin-shell active="request-detail" title="Request">
      <span headerExtra class="row" style="gap:7px;font-size:12.5px;color:var(--muted)">
        <button class="btn ghost sm" style="margin-left:-6px;color:var(--muted)" (click)="back()">
          <sf-icon name="back" [size]="15" /> Mission control
        </button>
        <span style="color:var(--faint)">/</span
        ><span class="mono" style="font-size:12px">{{ d()?.ref }}</span>
      </span>
      <div style="position:absolute;inset:0;overflow-y:auto" class="scroll">
        @if (!d()) {
          <!-- P2: Loading skeleton — shown until first poll resolves -->
          <div class="rd-skel-wrap" aria-busy="true" aria-label="Loading request…">
            <div class="rd-skel rd-skel--chip"></div>
            <div class="rd-skel rd-skel--title"></div>
            <div class="rd-skel rd-skel--line"></div>
            <div class="rd-skel rd-skel--line rd-skel--short"></div>
            <div class="rd-skel-rings" aria-hidden="true">
              @for (_ of [0, 1, 2, 3, 4, 5]; track $index) {
                <div class="rd-skel rd-skel--ring"></div>
              }
            </div>
            <div class="rd-skel rd-skel--block"></div>
            <div class="rd-skel rd-skel--block rd-skel--short"></div>
          </div>
        }
        @if (d(); as r) {
          <div style="max-width:760px;margin:0 auto;padding:24px 28px 80px">
            <!-- header -->
            <div class="row" style="gap:9px;margin-bottom:9px">
              <sf-type-chip [t]="r.type" />
              <span style="font-size:12.5px;color:var(--muted)">{{ r.app_name }}</span>
              @if (r.repo) {
                <span class="mono" style="font-size:11.5px;color:var(--faint)">{{ r.repo }}</span>
              }
            </div>
            <h1 style="font-size:25px;margin-bottom:12px">{{ r.title }}</h1>

            <div
              class="row"
              style="gap:14px;margin-bottom:16px;font-size:12.5px;color:var(--muted)"
            >
              <span class="rd-state" role="status" aria-live="polite">{{ stateLine(r) }}</span>
              <span class="rd-who">{{ whoLine(r) }}</span>
            </div>

            <!-- Recovery cluster: Take over / Send back to stage need backend endpoints (not built) — Retry/Cancel are the backed actions. -->
            <div class="row" style="gap:9px;margin-bottom:20px">
              @if (r.needs_human) {
                <button class="btn primary sm" (click)="retry(r)">Retry stage</button>
                <button class="btn sm" (click)="showRetryNote.set(!showRetryNote())">
                  Retry with a note
                </button>
              } @else if (r.gate) {
                <button class="btn primary" (click)="confirming.set(true)">
                  {{ r.gate === 'approve_merge' ? 'Approve merge' : 'Approve spec' }}
                  <kbd class="kbd">A</kbd>
                </button>
                @if (r.gate === 'approve_spec') {
                  <button class="btn" (click)="sendingBack.set(true)">
                    Send back <kbd class="kbd">S</kbd>
                  </button>
                }
              }
              @if (!['done', 'cancelled'].includes(r.status)) {
                <button
                  class="btn sm"
                  style="margin-left:auto;border-style:dashed;color:var(--muted)"
                  (click)="cancelling.set(true)"
                >
                  Cancel request <kbd class="kbd">C</kbd>
                </button>
              }
            </div>
            @if (showRetryNote()) {
              <div class="row" style="gap:8px;margin-bottom:16px">
                <input
                  class="input"
                  style="flex:1"
                  placeholder="What should the retry do differently?"
                  [value]="retryNote()"
                  (input)="retryNote.set($any($event.target).value)"
                  (keydown.enter)="retry(r)"
                />
                <button class="btn primary sm" (click)="retry(r)">Retry</button>
              </div>
            }
            @if (r.needs_human) {
              <sf-escalation-box
                title="Escalated — needs a person"
                [reason]="r.needs_human_reason"
                style="margin-bottom:16px"
              />
            }

            @if (r.evidence) {
              <div class="rd-evidence">
                <sf-evidence-strip [evidence]="r.evidence" />
              </div>
            }

            @if (d()?.attachments?.length) {
              <div class="att-strip">
                <div class="att-strip__hd">Attachments ({{ d()!.attachments!.length }})</div>
                <div class="att-strip__items">
                  @for (a of d()!.attachments!; track a.id) {
                    <a
                      class="att-item"
                      [href]="api.attachmentRawUrl(a.id)"
                      target="_blank"
                      rel="noopener"
                      [title]="a.filename"
                    >
                      @if (a.kind === 'image') {
                        <img class="att-item__thumb" [src]="api.attachmentRawUrl(a.id)" alt="" />
                      } @else {
                        <span class="att-item__doc"
                          ><sf-icon name="app" [size]="18" color="var(--muted)"
                        /></span>
                      }
                      <span class="att-item__name">{{ a.filename }}</span>
                    </a>
                  }
                </div>
              </div>
            }

            <!-- trace / map toggle — real tablist (P1 a11y) -->
            <div class="row" style="margin:8px 0 14px;justify-content:space-between">
              <span class="section-eyebrow">{{ view() === 'map' ? 'Delivery map' : 'Trace' }}</span>
              <div class="rd-seg" role="tablist" aria-label="View">
                <button
                  class="rd-seg__b"
                  role="tab"
                  [attr.aria-selected]="view() === 'trace'"
                  [class.on]="view() === 'trace'"
                  (click)="setView('trace')"
                >
                  Trace
                </button>
                <button
                  class="rd-seg__b"
                  role="tab"
                  [attr.aria-selected]="view() === 'map'"
                  [class.on]="view() === 'map'"
                  (click)="setView('map')"
                >
                  Map
                </button>
              </div>
            </div>

            @if (view() === 'map') {
              <!-- Map tabpanel -->
              <div role="tabpanel" aria-label="Delivery map">
                <div class="rd-dmap">
                  @for (s of dstages(); track s.key) {
                    <div class="rd-dstage">
                      <div
                        class="rd-dring"
                        [class.rd-dring--done]="s.state === 'done'"
                        [class.rd-dring--todo]="s.state === 'todo'"
                        [style.--rp]="s.state === 'done' ? 100 : s.pct"
                        [style.--rc]="ringColor(s)"
                      >
                        <span class="rd-dring__n">{{ s.pct }}%</span>
                      </div>
                      <div class="rd-dname">{{ s.label }}</div>
                      <div class="rd-dart" [class.todo]="s.state === 'todo'">{{ s.artifact }}</div>
                      <div class="rd-ddetail">{{ s.detail }}</div>
                    </div>
                  }
                </div>
                <div class="rd-dgates">
                  @for (g of dgates(); track g.label) {
                    <span class="rd-dgate" [attr.data-st]="g.state"
                      >{{ g.label }} · {{ g.state }}</span
                    >
                  }
                </div>
              </div>
              <!-- /tabpanel map -->
            } @else {
              <!-- Trace tabpanel -->
              <div role="tabpanel" aria-label="Trace">
                @for (g of trace(); track g.stage) {
                  <div class="rd-stage">
                    <div class="rd-stage__head">
                      <sf-glyph type="ring" [size]="12" color="var(--a500)" [fill]="0.5" />
                      {{ g.label }}
                    </div>
                    @for (row of g.rows; track row.id) {
                      @if (row.kind === 'steer_note') {
                        <div class="rd-steer">
                          <sf-icon name="back" [size]="12" color="var(--a600)" />
                          <span class="rd-steer__txt">{{ row.title }}</span>
                          <span class="rd-steer__tag">{{ row.acked ? 'honored' : 'queued' }}</span>
                        </div>
                      } @else {
                        <div class="rd-row" [class.rd-row--gate]="row.kind === 'gate_event'">
                          <span class="rd-row__dot"
                            ><sf-glyph [type]="rowGlyph(row.kind)" [size]="11" color="var(--muted)"
                          /></span>
                          <div class="rd-row__body">
                            <div class="rd-row__head">
                              <span class="rd-row__title">{{ rowTitle(row) }}</span>
                              @if (row.acksSteer) {
                                <span class="rd-row__ack">honoring your note</span>
                              }
                              <span class="rd-row__time">{{ ago(row.created_at) }}</span>
                            </div>
                            @if (row.why) {
                              <button class="rd-row__why" (click)="toggleWhy(row.id)">
                                <sf-icon
                                  [name]="openWhy().has(row.id) ? 'chevDown' : 'chevRight'"
                                  [size]="12"
                                />
                                why
                              </button>
                              @if (openWhy().has(row.id)) {
                                <div class="rd-row__whytext">{{ row.why }}</div>
                              }
                            }
                          </div>
                        </div>
                      }
                    }
                  </div>
                } @empty {
                  <div style="color:var(--faint);font-size:12.5px;padding:8px 0">
                    No trace yet — work begins after the spec gate.
                  </div>
                }
              </div>
              <!-- /tabpanel trace -->
            }

            <!-- comments -->
            <div class="section-eyebrow" style="margin:24px 0 12px">Comments</div>
            @for (c of r.comments; track c.id) {
              <div class="rd-cmt">
                <sf-avatar [color]="c.color">{{ c.initials }}</sf-avatar>
                <div style="flex:1">
                  <div class="row" style="gap:8px">
                    <span style="font-size:13px;font-weight:600">{{ c.author }}</span>
                    <span style="font-size:11px;color:var(--faint)">{{ ago(c.created_at) }}</span>
                  </div>
                  <div style="font-size:13.5px;color:var(--fg1);margin-top:2px">{{ c.body }}</div>
                </div>
              </div>
            }
            <div class="row" style="gap:11px;margin-top:10px;align-items:flex-start">
              <sf-avatar color="var(--avatar)">{{ session.user().initials }}</sf-avatar>
              <div style="flex:1;display:flex;flex-direction:column;gap:8px">
                <textarea
                  class="input"
                  rows="2"
                  placeholder="Leave a comment…"
                  [(ngModel)]="commentText"
                  style="resize:vertical;min-height:54px"
                ></textarea>
                <button
                  class="btn primary sm"
                  style="align-self:flex-end"
                  [disabled]="!commentText.trim()"
                  (click)="comment(r)"
                >
                  Comment
                </button>
              </div>
            </div>
          </div>
        }
      </div>

      @if (confirming() && d(); as r) {
        <sf-approve-modal [r]="r" (cancelled)="confirming.set(false)" (approved)="approve(r)" />
      }
      @if (sendingBack() && d(); as r) {
        <sf-send-back-modal
          [reporter]="r.reporter"
          (cancelled)="sendingBack.set(false)"
          (sent)="sendBack(r, $event)"
        />
      }
      @if (cancelling() && d(); as r) {
        <sf-cancel-confirm [r]="r" (kept)="cancelling.set(false)" (confirmed)="cancel(r)" />
      }
    </admin-shell>
  `,
  styles: `
    .rd-state {
      font-weight: 500;
      color: var(--fg2);
    }
    .rd-evidence {
      padding: 12px 0 18px;
      border-bottom: 1px solid var(--hairline);
      margin-bottom: 4px;
    }
    .rd-stage {
      margin-bottom: 14px;
    }
    .rd-stage__head {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--fg2);
      margin-bottom: 8px;
    }
    .rd-row {
      display: flex;
      gap: 10px;
      padding: 5px 0 5px 4px;
    }
    .rd-row__title {
      font-size: 13px;
      color: var(--fg1);
    }
    .rd-row__head {
      display: flex;
      align-items: baseline;
      gap: 9px;
    }
    .rd-row__ack {
      font-size: 11px; /* P0: raised from 10.5px */
      color: var(--accent-tx);
      background: var(--a50);
      border-radius: 4px;
      padding: 1px 6px;
    }
    .rd-row__time {
      margin-left: auto;
      font-size: 11px;
      color: var(--faint);
      white-space: nowrap;
    }
    .rd-row__why {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-top: 3px;
      padding: 0;
      background: none;
      border: none;
      cursor: pointer;
      font-family: inherit;
      font-size: 11.5px;
      color: var(--muted);
    }
    .rd-row__whytext {
      font-size: 12px;
      color: var(--muted);
      margin: 3px 0 0 16px;
      line-height: 1.5;
    }
    .rd-row--gate .rd-row__title {
      color: var(--amber-tx);
      font-weight: 500;
    }
    .rd-steer {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 0 5px 4px;
      font-size: 12.5px;
      color: var(--accent-tx);
    }
    .rd-steer__txt {
      color: var(--fg2);
    }
    .rd-steer__tag {
      font-size: 11px; /* P0: raised from 10.5px */
      color: var(--muted);
      background: var(--surface-2);
      border-radius: 4px;
      padding: 1px 6px;
    }
    .rd-cmt {
      display: flex;
      gap: 11px;
      padding: 9px 0;
      border-bottom: 1px solid var(--hairline);
    }
    .rd-seg {
      display: inline-flex;
      gap: 2px;
      padding: 3px;
      border: 1px solid var(--border);
      border-radius: 9px;
      background: var(--surface-2);
    }
    .rd-seg__b {
      border: 0;
      cursor: pointer;
      font-family: var(--body);
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      background: transparent;
      padding: 4px 12px;
      border-radius: 6px;
    }
    .rd-seg__b.on {
      background: var(--a500);
      color: #fff;
    }
    /* ── P2: Loading skeleton ── */
    .rd-skel-wrap {
      max-width: 760px;
      margin: 0 auto;
      padding: 24px 28px 80px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .rd-skel {
      border-radius: var(--r-lg);
      background: var(--surface-3);
      animation: rd-shimmer 1.4s ease infinite alternate;
    }
    @keyframes rd-shimmer {
      from {
        opacity: 0.4;
      }
      to {
        opacity: 0.9;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .rd-skel {
        animation: none;
        opacity: 0.5;
      }
    }
    .rd-skel--chip {
      width: 64px;
      height: 22px;
      border-radius: 999px;
    }
    .rd-skel--title {
      width: 70%;
      height: 30px;
      border-radius: 6px;
      margin: 4px 0;
    }
    .rd-skel--line {
      width: 50%;
      height: 14px;
      border-radius: 4px;
    }
    .rd-skel--short {
      width: 35%;
    }
    .rd-skel--ring {
      width: 50px;
      height: 50px;
      border-radius: 50%;
      flex: none;
    }
    .rd-skel--block {
      height: 44px;
    }
    .rd-skel-rings {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
      gap: 10px;
      margin: 8px 0;
    }
    .rd-skel-rings .rd-skel--ring {
      margin: 0 auto;
    }

    /* ── P1 + P2: Delivery map container ── */
    .rd-dmap {
      position: relative;
      display: grid;
      /* P2: responsive — auto-fit at ≥560px stays 6 across; below wraps to 3×2 */
      grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
      padding: 16px 0 8px;
    }
    /* P1: gradient rail connecting all rings — same family as map.ts .fm-lane::before */
    .rd-dmap::before {
      content: '';
      position: absolute;
      top: 41px; /* center on 50px rings with 16px top padding */
      left: calc(100% / 12);
      right: calc(100% / 12);
      height: 2px;
      background: linear-gradient(90deg, var(--a700), var(--a200));
      opacity: 0.4;
      pointer-events: none;
      /* P2: slow left→right flow, same as fm-rail */
      background-size: 200% 100%;
      animation: rd-rail 10s linear infinite;
    }
    @keyframes rd-rail {
      from {
        background-position: 0% 0%;
      }
      to {
        background-position: 200% 0%;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .rd-dmap::before {
        animation: none;
      }
    }
    /* Direction arrow at rail end */
    .rd-dmap::after {
      content: '›';
      position: absolute;
      top: 32px;
      right: calc(100% / 12 - 14px);
      font-size: 15px;
      line-height: 1;
      color: var(--a300);
      pointer-events: none;
    }

    .rd-dstage {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 5px;
      position: relative;
      z-index: 1; /* sit above the rail */
    }

    /* ── Delivery map ring — 3 visual states (P1) ── */
    .rd-dring {
      position: relative;
      width: 50px;
      height: 50px;
      border-radius: 50%;
      /* default: conic ring (current stage) */
      background: conic-gradient(var(--rc) calc(var(--rp) * 1%), var(--surface-3) 0);
    }
    /* done: fully filled solid disc */
    .rd-dring.rd-dring--done {
      background: var(--rc); /* solid fill — no track needed */
    }
    /* todo: hollow/faint — only a faint border, no fill */
    .rd-dring.rd-dring--todo {
      background: var(--surface-2);
      border: 2px solid var(--border);
      opacity: 0.55;
    }
    .rd-dring::before {
      content: '';
      position: absolute;
      inset: 5px;
      border-radius: 50%;
      background: var(--bg);
    }
    /* done: no inner cutout — it's a filled disc */
    .rd-dring.rd-dring--done::before {
      display: none;
    }
    /* todo: cutout keeps hollow look */
    .rd-dring.rd-dring--todo::before {
      background: var(--bg);
    }
    .rd-dring__n {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      font-size: 12px;
      font-weight: 700;
    }
    /* done: white text on colored disc */
    .rd-dring--done .rd-dring__n {
      color: #fff;
    }
    /* todo: faint text */
    .rd-dring--todo .rd-dring__n {
      color: var(--faint);
    }

    .rd-dname {
      font-size: 11.5px;
      font-weight: 700;
    }
    .rd-dart {
      font-size: 11px; /* P0: raised from 10.5px */
      color: var(--fg2);
    }
    .rd-dart.todo {
      color: var(--faint);
    }
    .rd-ddetail {
      font-size: 11px; /* P0: raised from 10px */
      color: var(--faint);
      line-height: 1.3;
    }
    .rd-dgates {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    }
    .rd-dgate {
      font-size: 11.5px; /* P0: raised from 10.5px; status-bearing */
      font-weight: 600;
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid var(--border);
      color: var(--muted);
      background: var(--surface-2);
      text-transform: capitalize;
    }
    .rd-dgate[data-st='passed'] {
      color: var(--green-tx);
      background: var(--green-bg);
      border-color: var(--green-line);
    }
    .rd-dgate[data-st='await'] {
      color: var(--amber-tx);
      background: var(--amber-bg);
      border-color: var(--amber-line);
    }
  `,
})
export class RequestDetailPage {
  protected api = inject(Api);
  private router = inject(Router);
  private poll = inject(Poll);
  protected session = inject(Session);
  private route = inject(ActivatedRoute);
  id = toSignal(this.route.paramMap.pipe(map((p) => Number(p.get('id')))), {
    initialValue: Number(this.route.snapshot.paramMap.get('id')),
  });

  d = signal<RequestDetail | null>(null);
  events = signal<ProgressEvent[]>([]);
  openWhy = signal<Set<number>>(new Set());
  ago = timeAgo;
  /** The live one-line state, also announced via the .rd-state aria-live region. */
  stateLine = adminStateLine;

  view = signal<'trace' | 'map'>(
    this.route.snapshot.queryParamMap.get('view') === 'map' ? 'map' : 'trace',
  );
  dstages = computed<DeliveryStage[]>(() => {
    const r = this.d();
    return r ? deliveryStages(r) : [];
  });
  dgates = computed<DeliveryGate[]>(() => {
    const r = this.d();
    return r ? deliveryGates(r) : [];
  });

  ringColor(s: DeliveryStage): string {
    return s.state === 'done'
      ? 'var(--green)'
      : s.state === 'gate'
        ? 'var(--amber)'
        : s.state === 'stalled'
          ? 'var(--red)'
          : s.state === 'run'
            ? 'var(--a500)'
            : 'var(--surface-3)';
  }

  /** P1: persist Trace/Map toggle to URL query param so reload/Back/share round-trips */
  setView(v: 'trace' | 'map') {
    this.view.set(v);
    this.router.navigate([], {
      queryParams: { view: v },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  confirming = signal(false);
  sendingBack = signal(false);
  cancelling = signal(false);
  retryNote = signal('');
  showRetryNote = signal(false);
  commentText = '';

  constructor() {
    let lastId: number | null = null;
    effect(() => {
      const id = this.id();
      this.poll.version();
      if (id !== lastId) {
        lastId = id;
        this.d.set(null);
        this.events.set([]);
        this.openWhy.set(new Set());
        this.confirming.set(false);
        this.sendingBack.set(false);
        this.cancelling.set(false);
        this.retryNote.set('');
        this.showRetryNote.set(false);
        this.commentText = '';
      }
      this.api.request(id).subscribe((r) => this.d.set(r));
      this.api.trace(id).subscribe((p) => this.events.set(p.items));
    });
  }

  trace = computed<TraceGroup[]>(() => groupTrace(this.events()));

  whoLine(r: RequestDetail): string {
    if (r.gate || r.needs_human) return 'waiting on you';
    if (r.status === 'sent_back') return `waiting on ${r.reporter}`;
    if (r.status === 'approved') return 'agents working';
    return `filed by ${r.reporter}`;
  }

  rowGlyph(kind: string): string {
    if (kind === 'gate_event') return 'flag';
    if (kind === 'verification' || kind === 'milestone_summary') return 'check';
    if (kind === 'escalation') return 'flag';
    return 'ring';
  }

  rowTitle(row: {
    kind: string;
    label?: string;
    step?: number;
    of?: number;
    title: string;
  }): string {
    if (row.kind === 'step_summary' && row.label) return `${row.label} (${row.step}/${row.of})`;
    return row.title;
  }

  toggleWhy(id: number) {
    this.openWhy.update((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  approve(r: RequestDetail) {
    this.confirming.set(false);
    this.api.approve(r.id, this.session.user().name).subscribe((d) => {
      this.d.set(d as RequestDetail);
      this.poll.nudge();
    });
  }

  sendBack(r: RequestDetail, note: string) {
    this.sendingBack.set(false);
    this.api.sendBack(r.id, note, this.session.user().name).subscribe((d) => {
      this.d.set(d as RequestDetail);
      this.poll.nudge();
    });
  }

  cancel(r: RequestDetail) {
    this.cancelling.set(false);
    this.api.cancel(r.id, this.session.user().name).subscribe((d) => {
      this.d.set(d as RequestDetail);
      this.poll.nudge();
    });
  }

  retry(r: RequestDetail) {
    this.api.retry(r.id, this.session.user().name, this.retryNote().trim()).subscribe((d) => {
      this.d.set(d as RequestDetail);
      this.poll.nudge();
      this.showRetryNote.set(false);
      this.retryNote.set('');
    });
  }

  comment(r: RequestDetail) {
    const u = this.session.user();
    this.api.comment(r.id, this.commentText.trim(), u.name, u.initials).subscribe(() => {
      this.commentText = '';
      this.api.request(this.id()).subscribe((d) => this.d.set(d));
    });
  }

  back() {
    this.router.navigateByUrl('/admin/mission');
  }

  /** Single-key grammar mirroring queue.ts: guard typing/modals;
   *  A confirm (gate), S send-back (spec gate), C cancel, R retry (needs_human). */
  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.metaKey || e.ctrlKey) return;
    if (this.confirming() || this.sendingBack() || this.cancelling()) {
      if (e.key === 'Escape') {
        this.confirming.set(false);
        this.sendingBack.set(false);
        this.cancelling.set(false);
      }
      return;
    }
    const k = e.key.toLowerCase();
    const r = this.d();
    if (k === 'a' && r && r.gate && !r.needs_human) {
      e.preventDefault();
      this.confirming.set(true);
    } else if (k === 's' && r && r.gate === 'approve_spec') {
      e.preventDefault();
      this.sendingBack.set(true);
    } else if (k === 'c' && r && !['done', 'cancelled'].includes(r.status)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cancelling.set(true);
    } else if (k === 'r' && r && r.needs_human) {
      e.preventDefault();
      this.retry(r);
    }
  }
}
