import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { Api } from '../core/api.service';
import { RequestDetail } from '@sf/shared';
import { Poll } from '../core/poll.service';
import { Session } from '../core/session.service';
import { liveStatus, plainActivity, plainStage, timeAgo } from '../core/util';
import { Glyph, Icon, Pill, Sig, TypeChip } from '../kit/kit';
import { SubShell } from './sub-shell';

interface TlRow {
  glyph: string;
  fill?: number;
  color?: string;
  title: string;
  meta?: string;
  ghost?: boolean;
}

/** S5 — Request detail + the first-class respond-to-send-back hero state. */
@Component({
  selector: 'sf-sub-detail',
  imports: [SubShell, Glyph, Icon, Pill, Sig, TypeChip, FormsModule],
  template: `
    <sub-shell active="list">
      <div class="sub-col fade-in">
        <button
          class="btn ghost sm"
          style="margin-bottom:8px;margin-left:-8px;color:var(--muted)"
          (click)="go('/requests')"
        >
          <sf-icon name="back" [size]="15" /> My requests
        </button>
        @if (req(); as r) {
          <!-- Screen-reader-only live region: announces status as polling updates it. -->
          <div class="sr-only" role="status" aria-live="polite">{{ live(r) }}</div>
          <div class="row" style="justify-content:space-between;align-items:flex-start;gap:14px">
            <div>
              <h1 style="font-size:25px">{{ r.title }}</h1>
              <div class="row" style="gap:8px;margin-top:8px">
                <sf-type-chip [t]="r.type" />
                <span style="font-size:13px;color:var(--muted)"
                  >{{ r.app_name }} · <span class="mono" style="font-size:12px">{{ r.ref }}</span> ·
                  filed {{ age(r.created_at) }} ago</span
                >
              </div>
            </div>
            <sf-pill [tone]="ps(r).tone" [glyph]="ps(r).glyph" [fill]="ps(r).fill ?? 0.45">{{
              ps(r).label
            }}</sf-pill>
          </div>

          @if (r.status === 'sent_back' && !sent()) {
            <div class="attn lift fade-in" style="margin-top:20px">
              <sf-sig tone="amber" glyph="flag">The reviewer needs a bit more</sf-sig>
              <div class="attn__q">"{{ r.send_back_question }}"</div>
              <textarea
                class="input area"
                placeholder="Add the detail they asked for…"
                style="background:var(--surface)"
                [(ngModel)]="reply"
              ></textarea>
              <div style="margin-top:11px">
                <button class="btn primary" [disabled]="!reply.trim()" (click)="respond(r)">
                  Send back for review <sf-icon name="arrowRight" [size]="16" />
                </button>
              </div>
            </div>
          }
          @if (sent()) {
            <div
              class="card fade-in"
              style="margin-top:20px;padding:14px 16px;display:flex;align-items:center;gap:10px;background:var(--green-bg);border-color:var(--green-line)"
            >
              <sf-glyph type="check" [size]="18" color="var(--green)" />
              <span style="font-size:14px;color:var(--green-tx)"
                >Thanks — it's back with the reviewer. We'll email you with the next step.</span
              >
            </div>
          }
          @if (r.status === 'cancelled') {
            <div
              class="card fade-in"
              style="margin-top:20px;padding:14px 16px;display:flex;align-items:center;gap:10px"
            >
              <sf-glyph type="strike" [size]="18" color="var(--faint)" />
              <span style="font-size:14px;color:var(--muted)"
                >This request was cancelled by a reviewer. File a new one if it's still
                needed.</span
              >
            </div>
          }

          <hr class="divider" style="margin:22px 0 18px" />
          <div class="tl">
            @for (row of timeline(); track row.title; let last = $last) {
              <div class="tl__row" [class.ghost]="row.ghost">
                <div class="tl__rail">
                  <sf-glyph
                    [type]="row.glyph"
                    [size]="19"
                    [color]="row.ghost ? 'var(--border-strong)' : (row.color ?? 'var(--muted)')"
                    [fill]="row.fill ?? 0.45"
                  />
                  @if (!last) {
                    <span class="tl__line"></span>
                  }
                </div>
                <div class="tl__body">
                  <div class="tl__title">{{ row.title }}</div>
                  @if (row.meta) {
                    <div class="tl__meta">{{ row.meta }}</div>
                  }
                </div>
              </div>
            }
          </div>
          @if (
            r.status !== 'sent_back' && !sent() && r.status !== 'cancelled' && r.status !== 'done'
          ) {
            <div style="font-size:13px;color:var(--faint);text-align:center;margin-top:4px">
              Nothing needed from you right now.
            </div>
          }
        }
      </div>
    </sub-shell>
  `,
})
export class SubRequestDetail {
  private api = inject(Api);
  private router = inject(Router);
  private session = inject(Session);
  private poll = inject(Poll);
  id = Number(inject(ActivatedRoute).snapshot.paramMap.get('id'));

  req = signal<RequestDetail | null>(null);
  sent = signal(false);
  reply = '';

  constructor() {
    this.poll.start();
    effect(() => {
      this.poll.version();
      this.api.request(this.id).subscribe((r) => this.req.set(r));
    });
  }

  ps = plainStage;
  age = timeAgo;
  /** Concise status for the aria-live region — announced to SR users on each poll. */
  live(r: RequestDetail): string {
    return liveStatus(r, r.run);
  }
  go(url: string) {
    this.router.navigateByUrl(url);
  }

  respond(r: RequestDetail) {
    this.api.respond(r.id, this.reply.trim(), this.session.user().name).subscribe((d) => {
      this.req.set(d as RequestDetail);
      this.sent.set(true);
      this.poll.nudge();
    });
  }

  timeline = computed<TlRow[]>(() => {
    const r = this.req();
    if (!r) return [];
    const ago = (iso: string) => timeAgo(iso) + ' ago';
    const rows: TlRow[] = [
      { glyph: 'check', color: 'var(--green)', title: 'Submitted', meta: ago(r.created_at) },
    ];
    const specDone = r.status !== 'submitted';
    rows.push(
      specDone
        ? { glyph: 'check', color: 'var(--green)', title: 'Spec drafted', meta: ago(r.updated_at) }
        : {
            glyph: 'ring',
            fill: 0.3,
            color: 'var(--a500)',
            title: 'Spec drafting',
            meta: 'in progress',
          },
    );

    if (r.status === 'cancelled') {
      rows.push({
        glyph: 'strike',
        color: 'var(--faint)',
        title: 'Cancelled',
        meta: ago(r.updated_at),
      });
      return rows;
    }
    if (r.status === 'sent_back' && !this.sent()) {
      rows.push({
        glyph: 'flag',
        color: 'var(--red)',
        title: 'Needs your input',
        meta: 'reviewer replied · ' + ago(r.updated_at),
      });
    } else if (r.status === 'pending_approval') {
      rows.push({
        glyph: 'ring',
        fill: 0.5,
        color: 'var(--a500)',
        title: 'In review',
        meta: 'with the reviewer',
      });
    } else {
      rows.push({ glyph: 'check', color: 'var(--green)', title: 'Approved' });
    }

    const stageIdx = ['architecture', 'build'].includes(r.stage)
      ? 1
      : r.stage === 'review'
        ? 2
        : r.stage === 'done'
          ? 3
          : 0;
    const approvedPast = ['approved', 'done'].includes(r.status);
    if (!approvedPast) {
      rows.push({ glyph: 'dotted', title: 'Approved', ghost: true });
      rows.push({ glyph: 'dotted', title: 'Building', ghost: true });
      rows.push({ glyph: 'dotted', title: 'Deployed', ghost: true });
    } else {
      rows.push(
        stageIdx >= 2
          ? { glyph: 'check', color: 'var(--green)', title: 'Building', meta: 'done' }
          : {
              glyph: 'ring',
              fill: 0.4,
              color: 'var(--a500)',
              title: 'Building',
              meta: plainActivity(r.run) ?? 'the Factory is on it',
            },
      );
      if (stageIdx >= 2 && r.stage !== 'done') {
        rows.push({
          glyph: 'ring',
          fill: 0.6,
          color: 'var(--a500)',
          title: 'In review',
          meta: plainActivity(r.run) ?? 'final checks',
        });
        rows.push({ glyph: 'dotted', title: 'Deployed', ghost: true });
      } else if (r.stage === 'done') {
        rows.push({
          glyph: 'check',
          color: 'var(--green)',
          title: 'Deployed',
          meta: ago(r.updated_at),
        });
      } else {
        rows.push({ glyph: 'dotted', title: 'Deployed', ghost: true });
      }
    }
    return rows;
  });
}
