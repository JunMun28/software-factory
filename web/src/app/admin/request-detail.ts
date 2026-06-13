import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';

import { Api } from '../core/api.service';
import { ProgressEvent, RequestDetail } from '../core/models';
import { Poll } from '../core/poll.service';
import { Session } from '../core/session.service';
import { STAGE_LABEL, TraceGroup, groupTrace, timeAgo } from '../core/util';
import { EvidenceStrip, Glyph, Icon, TypeChip } from '../kit/kit';
import { AdminShell } from './admin-shell';

/** Request detail (spec §6) — the supervision replacement for the Jira issue page.
 *  Header: waiting-on / decided-by. Body: the stage-grouped trace timeline.
 *  No assignee/labels/attachments/checklist/subscribers — deliberately gone.
 *  Actions (gate approve/send-back, recovery, comments) ship in Task 5. */
@Component({
  selector: 'sf-request-detail-page',
  imports: [AdminShell, Glyph, Icon, TypeChip, EvidenceStrip],
  template: `
    <admin-shell active="mission" title="Request">
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
              style="gap:14px;margin-bottom:20px;font-size:12.5px;color:var(--muted)"
            >
              <span class="rd-state">{{ stateLine(r) }}</span>
              <span class="rd-who">{{ whoLine(r) }}</span>
            </div>

            @if (r.evidence) {
              <div class="rd-evidence">
                <sf-evidence-strip [evidence]="r.evidence" />
              </div>
            }

            <!-- trace timeline -->
            <div class="section-eyebrow" style="margin:8px 0 12px">Trace</div>
            @for (g of trace(); track g.stage; let gi = $index) {
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
        }
      </div>
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
      color: var(--a700);
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
      color: var(--a700);
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

  back() {
    this.router.navigateByUrl('/admin/mission');
  }
}
