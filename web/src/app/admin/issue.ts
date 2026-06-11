import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';

import { Api } from '../core/api.service';
import { RequestDetail } from '../core/models';
import { Poll } from '../core/poll.service';
import { Session } from '../core/session.service';
import { STAGE_LABEL, timeAgo } from '../core/util';
import {
  ApproveModal,
  Avatar,
  CancelConfirm,
  EscalationBox,
  Glyph,
  Icon,
  InterviewAnswers,
  SendBackModal,
  Sig,
  SpecLines,
  TypeChip,
} from '../kit/kit';
import { AdminShell } from './admin-shell';

interface ActivityRow {
  kind: 'comment' | 'act';
  actor: string;
  initials?: string;
  color?: string;
  glyph?: string;
  text: string;
  when: string;
}

/** C4b — full-screen issue view (Jira/Linear-grade): labels, attachments, spec, checklist, activity, details rail. */
@Component({
  selector: 'sf-issue-page',
  imports: [
    AdminShell,
    Glyph,
    Icon,
    Avatar,
    Sig,
    TypeChip,
    FormsModule,
    DatePipe,
    EscalationBox,
    SpecLines,
    InterviewAnswers,
    ApproveModal,
    SendBackModal,
    CancelConfirm,
  ],
  template: `
    <admin-shell active="list" title="Issue">
      <span headerExtra class="row" style="gap:7px;font-size:12.5px;color:var(--muted)">
        <button class="btn ghost sm" style="margin-left:-6px;color:var(--muted)" (click)="back()">
          <sf-icon name="back" [size]="15" /> Waiting on me
        </button>
        <span style="color:var(--faint)">/</span
        ><span class="mono" style="font-size:12px">{{ d()?.ref }}</span>
      </span>
      <div style="position:absolute;inset:0;overflow-y:auto" class="scroll">
        @if (d(); as r) {
          <div
            style="max-width:1060px;margin:0 auto;padding:24px 28px 60px;display:grid;grid-template-columns:1fr 312px;gap:32px;align-items:start"
          >
            <!-- main column -->
            <div>
              <div class="row" style="gap:9px;margin-bottom:9px">
                <sf-glyph
                  [type]="headGlyph(r).t"
                  [size]="16"
                  [color]="headGlyph(r).c"
                  [fill]="0.4"
                />
                <sf-type-chip [t]="r.type" /><span style="font-size:12.5px;color:var(--muted)">{{
                  r.app_name
                }}</span>
              </div>
              <h1 style="font-size:27px;margin-bottom:13px">{{ r.title }}</h1>

              <div class="row" style="gap:7px;margin-bottom:20px;flex-wrap:wrap">
                @for (l of r.labels ?? []; track l.name) {
                  <span class="lbl"
                    ><span class="lbl__dot" [style.background]="l.color"></span>{{ l.name }}</span
                  >
                }
                <span class="lbl lbl--add"><sf-icon name="plus" [size]="12" /> Label</span>
              </div>

              <div class="row" style="gap:9px;margin-bottom:24px">
                @if (r.status === 'approved') {
                  <span class="pill purple"
                    ><sf-glyph type="ring" [size]="13" color="var(--a600)" [fill]="0.55" />Building
                    · {{ stageLabel[r.stage] }}</span
                  >
                } @else if (r.status === 'done') {
                  <span class="pill green"
                    ><sf-glyph type="check" [size]="13" color="var(--green)" />Deployed</span
                  >
                } @else if (r.status === 'cancelled') {
                  <span class="pill"
                    ><sf-glyph type="strike" [size]="13" color="var(--faint)" />Cancelled</span
                  >
                } @else if (r.needs_human) {
                  <sf-sig tone="red" glyph="flag">Needs human</sf-sig>
                  <button class="btn primary sm" (click)="retry(r)">Retry stage</button>
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
                } @else if (r.status === 'sent_back') {
                  <sf-sig tone="amber" glyph="flag">With the submitter</sf-sig>
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

              @if (r.needs_human) {
                <sf-escalation-box [reason]="r.needs_human_reason" style="margin-bottom:18px" />
              }
              @if (r.status === 'sent_back') {
                <div class="attn" style="margin-bottom:18px">
                  <div
                    style="font-size:13px;font-weight:600;color:var(--amber-tx);margin-bottom:5px"
                  >
                    Waiting on the submitter
                  </div>
                  <div class="attn__q" style="margin:6px 0">"{{ r.send_back_question }}"</div>
                </div>
              }

              <div class="section-eyebrow" style="margin-bottom:8px">Description</div>
              <p style="font-size:14.5px;color:var(--fg1);line-height:1.55;margin:0 0 18px">
                {{ r.description }}
              </p>

              @if (r.turns.length) {
                <sf-interview-answers [turns]="r.turns" [(open)]="showTurns" />
              }

              <div class="section-eyebrow" style="margin:20px 0 10px">Attachments</div>
              <div class="attach-grid">
                <div class="attach-drop">
                  <sf-icon name="plus" [size]="20" /><span style="font-size:11.5px;font-weight:500"
                    >Drop or attach</span
                  >
                </div>
              </div>

              @if (r.spec_lines.length) {
                <div class="section-eyebrow" style="margin:22px 0 10px">Draft spec</div>
                <sf-spec-lines [lines]="r.spec_lines" [openNote]="r.spec_open_note" />
              }

              <div class="section-eyebrow" style="margin:22px 0 6px">
                Checklist
                <span style="color:var(--faint);font-weight:500"
                  >· {{ checkedCount() }} of {{ checklist().length }}</span
                >
              </div>
              <div style="margin-bottom:6px">
                @for (s of checklist(); track s.label; let i = $index) {
                  <div class="subtask">
                    <span class="subtask__box" [class.on]="s.done" (click)="toggleCheck(i)">
                      @if (s.done) {
                        <sf-icon name="check" [size]="12" color="#fff" />
                      }
                    </span>
                    <span class="subtask__txt" [class.done]="s.done">{{ s.label }}</span>
                  </div>
                }
              </div>

              <div class="section-eyebrow" style="margin:26px 0 12px">Activity</div>
              <div class="atabs">
                @for (t of tabs; track t[0]) {
                  <button class="atab" [class.on]="tab() === t[0]" (click)="tab.set(t[0])">
                    {{ t[1] }}
                  </button>
                }
              </div>
              @for (a of activity(); track $index) {
                @if (a.kind === 'comment') {
                  <div class="cmt">
                    <sf-avatar [color]="a.color ?? '#6E5A8A'">{{ a.initials }}</sf-avatar>
                    <div class="cmt__body">
                      <div class="cmt__head">
                        <span class="cmt__name">{{ a.actor }}</span
                        ><span class="cmt__time">{{ a.when }}</span>
                      </div>
                      <div class="cmt__bubble">
                        <div class="cmt__text">{{ a.text }}</div>
                      </div>
                    </div>
                  </div>
                } @else {
                  <div class="cmt cmt--act">
                    <span class="cmt__dot"
                      ><sf-glyph [type]="a.glyph ?? 'dotted'" [size]="13" color="var(--muted)"
                    /></span>
                    <div class="cmt__body">
                      <div class="cmt__text">
                        <b style="color:var(--fg2);font-weight:600">{{ a.actor }}</b> {{ a.text }}
                        <span class="cmt__time">· {{ a.when }}</span>
                      </div>
                    </div>
                  </div>
                }
              }
              <div class="row" style="gap:11px;margin-top:6px;align-items:flex-start">
                <sf-avatar color="#6E5A8A">{{ session.user().initials }}</sf-avatar>
                <div class="ccomposer" [class.focus]="composerFocus()" style="flex:1">
                  <textarea
                    class="ccomposer__area"
                    placeholder="Leave a comment…  Use @ to mention, or attach an image"
                    [(ngModel)]="commentText"
                    (focus)="composerFocus.set(true)"
                    (blur)="composerFocus.set(false)"
                  ></textarea>
                  <div class="ccomposer__bar">
                    <button class="ccomposer__ic" title="Attach image">
                      <sf-icon name="image" [size]="17" />
                    </button>
                    <button class="ccomposer__ic" title="Mention">
                      <span style="font-size:15px;font-weight:600">&#64;</span>
                    </button>
                    <button class="ccomposer__ic" title="Code">
                      <sf-icon name="command" [size]="16" />
                    </button>
                    <span style="margin-left:auto"></span>
                    <button
                      class="btn primary sm"
                      [disabled]="!commentText.trim()"
                      (click)="comment(r)"
                    >
                      Comment
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- details sidebar -->
            <div class="card" style="padding:6px 16px 14px;position:sticky;top:0">
              <div
                style="font-size:10.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);padding:12px 0 4px"
              >
                Details
              </div>
              <div class="idmeta">
                <span class="idmeta__k">Status</span
                ><span class="idmeta__v">
                  @if (r.needs_human) {
                    <sf-sig tone="red" glyph="flag">Needs human</sf-sig>
                  } @else if (r.status === 'done') {
                    <span class="pill green"
                      ><sf-glyph type="check" [size]="12" color="var(--green)" />Deployed</span
                    >
                  } @else if (r.status === 'cancelled') {
                    <span class="pill"
                      ><sf-glyph type="strike" [size]="12" color="var(--faint)" />Cancelled</span
                    >
                  } @else {
                    <span class="pill purple"
                      ><sf-glyph type="ring" [size]="12" color="var(--a600)" [fill]="0.4" />{{
                        stageLabel[r.stage]
                      }}</span
                    >
                  }
                </span>
              </div>
              <div class="idmeta">
                <span class="idmeta__k">Assignee</span
                ><span class="idmeta__v row" style="gap:7px">
                  @if (r.assignee) {
                    <sf-avatar [sm]="true" [color]="r.assignee_color ?? '#7A6E9A'">{{
                      r.assignee_initials
                    }}</sf-avatar>
                    {{ r.assignee }}
                  } @else {
                    <span style="color:var(--faint)">Unassigned</span>
                  }
                </span>
              </div>
              <div class="idmeta">
                <span class="idmeta__k">Reporter</span
                ><span class="idmeta__v row" style="gap:7px"
                  ><sf-avatar [sm]="true" color="#7A6E9A">{{ r.reporter_initials }}</sf-avatar>
                  {{ r.reporter }}</span
                >
              </div>
              <div class="idmeta">
                <span class="idmeta__k">Priority</span
                ><span class="idmeta__v row" style="gap:6px">
                  <sf-icon
                    [name]="r.urgency === 'low' ? 'chevDown' : 'chevUp'"
                    [size]="14"
                    [color]="r.urgency === 'high' ? 'var(--a600)' : 'var(--muted)'"
                  />
                  {{ r.urgency === 'high' ? 'High' : r.urgency === 'low' ? 'Low' : 'Normal' }}
                </span>
              </div>
              <div class="idmeta">
                <span class="idmeta__k">App</span
                ><span class="idmeta__v row" style="gap:5px"
                  ><span style="color:var(--faint)">#</span>{{ r.app_name }}</span
                >
              </div>
              @if (r.repo) {
                <div class="idmeta">
                  <span class="idmeta__k">Repo</span
                  ><span class="idmeta__v reflink">{{ r.repo }}</span>
                </div>
              }
              <div class="idmeta">
                <span class="idmeta__k">Created</span
                ><span class="idmeta__v"
                  >{{ r.created_at | date: 'yyyy-MM-dd' }} · {{ ago(r.created_at) }} ago</span
                >
              </div>
              <div class="idmeta">
                <span class="idmeta__k">Updated</span
                ><span class="idmeta__v">{{ ago(r.updated_at) }} ago</span>
              </div>
              <div class="idmeta" style="border-bottom:none">
                <span class="idmeta__k">Subscribers</span>
                <span class="idmeta__v row"
                  ><sf-avatar [sm]="true" color="#6E5A8A">KP</sf-avatar
                  ><sf-avatar [sm]="true" color="#7A6E9A">{{
                    r.reporter_initials
                  }}</sf-avatar></span
                >
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
    .idmeta {
      display: grid;
      grid-template-columns: 104px 1fr;
      gap: 10px;
      align-items: center;
      padding: 9px 0;
      border-bottom: 1px solid var(--hairline);
    }
    .idmeta__k {
      font-size: 12.5px;
      color: var(--muted);
    }
    .idmeta__v {
      font-size: 13.5px;
      color: var(--fg1);
    }
  `,
})
export class IssueDetail {
  private api = inject(Api);
  private router = inject(Router);
  session = inject(Session);
  private poll = inject(Poll);
  private route = inject(ActivatedRoute);
  id = toSignal(this.route.paramMap.pipe(map((p) => Number(p.get('id')))), {
    initialValue: Number(this.route.snapshot.paramMap.get('id')),
  });

  d = signal<RequestDetail | null>(null);
  stageLabel = STAGE_LABEL;
  tabs: [string, string][] = [
    ['all', 'Activity'],
    ['comments', 'Comments'],
    ['history', 'History'],
  ];
  tab = signal('all');
  confirming = signal(false);
  sendingBack = signal(false);
  cancelling = signal(false);
  commentText = '';
  composerFocus = signal(false);
  showTurns = signal(false);
  checks = signal<boolean[] | null>(null);

  constructor() {
    let lastId: number | null = null;
    effect(() => {
      const id = this.id();
      this.poll.version();
      if (id !== lastId) {
        lastId = id;
        this.d.set(null); // do not show the previous issue while loading
        // reset per-issue UI so nothing bleeds from the previous issue
        this.confirming.set(false);
        this.sendingBack.set(false);
        this.cancelling.set(false);
        this.commentText = '';
        this.checks.set(null);
        this.tab.set('all');
        this.showTurns.set(false);
      }
      this.api.request(id).subscribe((r) => this.d.set(r));
    });
  }

  ago = timeAgo;
  headGlyph(r: RequestDetail): { t: string; c: string } {
    if (r.needs_human) return { t: 'flag', c: 'var(--red)' };
    if (r.status === 'done') return { t: 'check', c: 'var(--green)' };
    if (r.status === 'cancelled') return { t: 'strike', c: 'var(--faint)' };
    if (r.stage === 'intake') return { t: 'dotted', c: 'var(--muted)' };
    return { t: 'ring', c: 'var(--a500)' };
  }

  checklist = computed(() => {
    const r = this.d();
    if (!r) return [];
    const overrides = this.checks();
    const base = [
      { label: 'Read the grounded draft spec', done: true },
      { label: 'Confirm the open assumption with the submitter', done: r.send_back_rounds > 0 },
      {
        label:
          r.gate === 'approve_merge' ? 'Approve merge & deploy' : 'Approve spec & open SPEC.md PR',
        done: ['approved', 'done'].includes(r.status),
      },
    ];
    return base.map((b, i) => ({ ...b, done: overrides?.[i] ?? b.done }));
  });
  checkedCount = computed(() => this.checklist().filter((c) => c.done).length);
  toggleCheck(i: number) {
    const cur = this.checklist().map((c) => c.done);
    cur[i] = !cur[i];
    this.checks.set(cur);
  }

  activity = computed<ActivityRow[]>(() => {
    const r = this.d();
    if (!r) return [];
    const t = this.tab();
    const comments: ActivityRow[] = r.comments.map((c) => ({
      kind: 'comment',
      actor: c.author,
      initials: c.initials,
      color: c.color,
      text: c.body,
      when: timeAgo(c.created_at) + ' ago',
    }));
    const acts: ActivityRow[] = r.audit.map((a) => ({
      kind: 'act',
      actor: a.actor,
      glyph:
        a.action === 'submitted' ? 'dotted' : a.action.startsWith('approved') ? 'check' : 'ring',
      text: a.note ?? a.action.replaceAll('_', ' '),
      when: timeAgo(a.created_at) + ' ago',
    }));
    const all = t === 'comments' ? comments : t === 'history' ? acts : [...comments, ...acts];
    return all;
  });

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
    this.api.retry(r.id, this.session.user().name).subscribe((d) => {
      this.d.set(d as RequestDetail);
      this.poll.nudge();
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
    this.router.navigateByUrl('/admin/list');
  }
}
