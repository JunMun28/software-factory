import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';

import { Api } from '../core/api.service';
import { ProgressEvent, RequestDetail } from '../core/models';
import { Poll } from '../core/poll.service';
import { Session } from '../core/session.service';
import { STAGE_LABEL, TraceGroup, groupTrace, timeAgo } from '../core/util';
import { DeliveryGate, DeliveryStage, deliveryGates, deliveryStages } from '../core/map-view';
import {
  ApproveModal,
  Avatar,
  CancelConfirm,
  EscalationBox,
  EvidenceStrip,
  Glyph,
  Icon,
  SendBackModal,
  TypeChip,
} from '../kit/kit';
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
              <span class="rd-state">{{ stateLine(r) }}</span>
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

            <!-- trace / map toggle -->
            <div class="row" style="margin:8px 0 14px;justify-content:space-between">
              <span class="section-eyebrow">{{ view() === 'map' ? 'Delivery map' : 'Trace' }}</span>
              <div class="rd-seg" role="group" aria-label="view">
                <button
                  class="rd-seg__b"
                  [class.on]="view() === 'trace'"
                  (click)="view.set('trace')"
                >
                  Trace
                </button>
                <button class="rd-seg__b" [class.on]="view() === 'map'" (click)="view.set('map')">
                  Map
                </button>
              </div>
            </div>

            @if (view() === 'map') {
              <div class="rd-dmap">
                @for (s of dstages(); track s.key) {
                  <div class="rd-dstage">
                    <div class="rd-dring" [style.--rp]="s.pct" [style.--rc]="ringColor(s)">
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
            } @else {
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
      font-size: 10.5px;
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
      font-size: 10.5px;
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
    .rd-dmap {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 10px;
      margin-bottom: 14px;
    }
    .rd-dstage {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 5px;
    }
    .rd-dring {
      position: relative;
      width: 50px;
      height: 50px;
      border-radius: 50%;
      background: conic-gradient(var(--rc) calc(var(--rp) * 1%), var(--surface-3) 0);
    }
    .rd-dring::before {
      content: '';
      position: absolute;
      inset: 5px;
      border-radius: 50%;
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
    .rd-dname {
      font-size: 11.5px;
      font-weight: 700;
    }
    .rd-dart {
      font-size: 10.5px;
      color: var(--fg2);
    }
    .rd-dart.todo {
      color: var(--faint);
    }
    .rd-ddetail {
      font-size: 10px;
      color: var(--faint);
      line-height: 1.3;
    }
    .rd-dgates {
      display: flex;
      gap: 10px;
      margin-bottom: 18px;
    }
    .rd-dgate {
      font-size: 10.5px;
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
  private api = inject(Api);
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
  stageLabel = STAGE_LABEL;
  ago = timeAgo;

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

  stateLine(r: RequestDetail): string {
    if (r.needs_human) return 'Stalled — needs a human';
    if (r.gate === 'approve_spec') return 'Waiting at the spec gate';
    if (r.gate === 'approve_merge') return 'Waiting at the merge gate';
    if (r.status === 'sent_back') return 'With the submitter';
    if (r.status === 'done') return 'Deployed';
    if (r.status === 'cancelled') return 'Cancelled';
    if (r.run) return `Building · ${this.stageLabel[r.stage]} · step ${r.run.step}/${r.run.of}`;
    if (r.status === 'approved') return `Building · ${this.stageLabel[r.stage]}`;
    return this.stageLabel[r.stage] ?? r.stage;
  }

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
