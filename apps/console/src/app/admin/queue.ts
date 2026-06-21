import { Component, HostListener, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import {
  Api,
  ApproveModal,
  CancelConfirm,
  EscalationBox,
  EvidenceStrip,
  Glyph,
  Icon,
  InterviewAnswers,
  Mark,
  Poll,
  RequestDetail,
  SendBackModal,
  Sig,
  SpecLines,
  TYPE_LABEL,
} from '@sf/shared';
import { Session } from '../core/session.service';
import { Store } from '../core/store.service';
import { AdminShell } from './admin-shell';

/** C3 — Approval queue: the Stage-1 triage workhorse.
 *  Grounded spec + AI-triage-proposes/human-confirms + the one intentional friction point. */
@Component({
  selector: 'sf-queue-page',
  imports: [
    AdminShell,
    Glyph,
    Icon,
    Mark,
    Sig,
    EscalationBox,
    EvidenceStrip,
    SpecLines,
    InterviewAnswers,
    ApproveModal,
    SendBackModal,
    CancelConfirm,
  ],
  template: `
    <admin-shell active="queue" title="Approval queue">
      <span headerExtra style="font-size:11.5px;color:var(--faint)">J/K move · ↵ open</span>
      <div class="split">
        <div class="queue scroll">
          @for (q of queue(); track q.id; let i = $index) {
            <div
              class="qitem focusable"
              tabindex="0"
              role="button"
              [class.on]="sel() === i"
              (click)="sel.set(i)"
              (keydown.enter)="sel.set(i)"
            >
              <sf-glyph
                [type]="q.needs_human ? 'flag' : 'ring'"
                [size]="14"
                [color]="q.needs_human ? 'var(--red)' : 'var(--muted)'"
                [fill]="0.4"
              />
              <div style="flex:1;min-width:0">
                <div class="qitem__app">{{ q.app_name }}</div>
                <div class="qitem__title">{{ q.title }}</div>
              </div>
              @if (q.needs_human) {
                <sf-sig tone="red">Needs human</sf-sig>
              } @else if (q.gate === 'approve_merge') {
                <sf-sig tone="amber">Merge</sf-sig>
              } @else {
                <sf-sig tone="amber">Approve</sf-sig>
              }
            </div>
          } @empty {
            <div style="padding:24px 16px;font-size:13px;color:var(--faint);text-align:center">
              Queue's clear — nothing waiting.
            </div>
          }
        </div>
        <div class="pane scroll">
          @if (detail(); as r) {
            <div class="pane__inner">
              <div class="row" style="gap:9px">
                <sf-glyph
                  [type]="r.needs_human ? 'flag' : 'dotted'"
                  [size]="15"
                  [color]="r.needs_human ? 'var(--red)' : 'var(--muted)'"
                />
                <span class="chip">{{ typeLabel[r.type] }}</span>
                <span style="font-size:12.5px;color:var(--muted)"
                  >{{ r.app_name }} ·
                  <span class="mono" style="font-size:12px">{{ r.ref }}</span></span
                >
              </div>
              <h2 style="font-size:23px;margin:8px 0 12px">{{ r.title }}</h2>

              @if (r.needs_human) {
                <sf-escalation-box
                  title="Escalated — needs a person"
                  [reason]="r.needs_human_reason"
                  style="margin-bottom:12px"
                >
                  <div class="row" style="gap:8px;margin-top:10px">
                    <button class="btn primary sm" (click)="retry(r)">Retry stage</button>
                    <button class="btn sm" (click)="openIssue(r.id)">Open issue</button>
                  </div>
                </sf-escalation-box>
              }

              <!-- collapsible context -->
              <div style="border:1px solid var(--border);border-radius:8px;margin-bottom:10px">
                <button
                  class="row"
                  (click)="showOrig.set(!showOrig())"
                  style="width:100%;gap:8px;padding:9px 12px;background:none;border:none;cursor:pointer;font-family:inherit;font-size:12.5px;color:var(--muted)"
                >
                  <sf-icon [name]="showOrig() ? 'chevDown' : 'chevRight'" [size]="14" />Original
                  request
                </button>
                @if (showOrig()) {
                  <div
                    style="padding:0 14px 12px;font-size:13.5px;color:var(--fg2);line-height:1.5"
                  >
                    "{{ r.description }}"
                  </div>
                }
              </div>
              @if (r.turns.length) {
                <sf-interview-answers [turns]="r.turns" [(open)]="showTurns" />
              }

              @if (r.duplicate && !dupDismissed()) {
                <div class="dup" style="margin-bottom:12px">
                  <sf-glyph type="dotted" [size]="14" color="var(--faint)" />
                  <span style="flex:1;font-size:12.5px;color:var(--muted)"
                    >Looks similar to
                    <span class="mono" style="font-size:12px;color:var(--fg2)">{{
                      r.duplicate.ref
                    }}</span>
                    "{{ r.duplicate.title }}" — possible duplicate.</span
                  >
                  <button class="btn ghost sm" (click)="openIssue(r.duplicate.id)">Compare</button>
                  <button
                    class="btn ghost sm"
                    style="color:var(--faint)"
                    (click)="dupDismissed.set(true)"
                  >
                    Dismiss
                  </button>
                </div>
              }

              <!-- AI triage — propose, human confirms -->
              @if (!r.needs_human) {
                @if (triageDone()) {
                  <div class="triage row" style="margin-bottom:16px;gap:9px;padding:10px 15px">
                    <sf-glyph type="check" [size]="15" color="var(--a600)" />
                    <span style="font-size:12.5px;color:var(--fg2)"
                      >Triage applied —
                      @for (row of triage(r); track row[0]; let last = $last) {
                        <b style="font-weight:600">{{ row[1] }}</b>
                        @if (!last) {
                          <span style="color:var(--faint)"> · </span>
                        }
                      }
                    </span>
                    <button
                      class="btn ghost sm"
                      style="margin-left:auto"
                      (click)="triageDone.set(false)"
                    >
                      Undo
                    </button>
                  </div>
                } @else {
                  <div class="triage" style="margin-bottom:16px">
                    <div class="row" style="gap:8px;margin-bottom:8px">
                      <sf-mark [size]="14" color="var(--a600)" /><span
                        style="font-size:12.5px;font-weight:600"
                        >Suggested triage</span
                      >
                      <span style="font-size:11px;color:var(--faint)">review before approving</span>
                      <span class="row" style="margin-left:auto;gap:7px"
                        ><button class="btn sm" (click)="acceptAllTriage(r)">
                          Accept all
                        </button></span
                      >
                    </div>
                    @for (row of triage(r); track row[0]; let i = $index) {
                      <div class="triage__row" [style.opacity]="triageRow()[i] === 'no' ? 0.45 : 1">
                        <span class="triage__k">{{ row[0] }}</span>
                        <span
                          class="triage__v"
                          [style.text-decoration]="triageRow()[i] === 'no' ? 'line-through' : ''"
                          >{{ row[1] }}</span
                        >
                        <span class="triage__why">— {{ row[2] }}</span>
                        <span style="display:flex;gap:6px">
                          <button
                            class="btn ghost sm"
                            style="padding:2px 5px"
                            [style.color]="triageRow()[i] === 'ok' ? 'var(--a600)' : 'var(--faint)'"
                            title="Accept"
                            (click)="setTriage(i, 'ok')"
                          >
                            <sf-icon name="check" [size]="13" />
                          </button>
                          <button
                            class="btn ghost sm"
                            style="padding:2px 5px"
                            [style.color]="triageRow()[i] === 'no' ? 'var(--fg2)' : 'var(--faint)'"
                            title="Reject"
                            (click)="setTriage(i, 'no')"
                          >
                            <sf-icon name="x" [size]="13" />
                          </button>
                        </span>
                      </div>
                    }
                  </div>
                }
              }

              @if (r.gate === 'approve_merge') {
                <div class="section-eyebrow" style="margin-bottom:10px">Verification</div>
                <sf-evidence-strip [evidence]="r.evidence" />
              } @else {
                <div class="section-eyebrow" style="margin-bottom:10px">Draft spec</div>
                <sf-spec-lines
                  [lines]="r.spec_lines"
                  emptyText="No draft spec yet."
                  [openNote]="r.spec_open_note"
                />
              }
              <div style="height:64px"></div>
            </div>
          }
        </div>
      </div>

      <!-- sticky action bar -->
      @if (detail(); as r) {
        @if (!r.needs_human) {
          <div class="actionbar" style="position:absolute;bottom:0;left:300px;right:0">
            <button class="btn primary" (click)="confirming.set(true)">
              {{ r.gate === 'approve_merge' ? 'Approve merge' : 'Approve spec' }}
              <kbd class="kbd">A</kbd>
            </button>
            @if (r.gate === 'approve_spec') {
              <button class="btn" (click)="sendingBack.set(true)">
                Send back <kbd class="kbd">S</kbd>
              </button>
            }
            <span class="actionbar__note">{{
              r.gate === 'approve_merge'
                ? 'Approve merges to main · promotes to production'
                : 'Approve creates repo · writes SPEC.md PR · starts Architecture'
            }}</span>
            <span style="width:1px;height:22px;background:var(--border);margin:0 2px"></span>
            <button
              class="btn sm"
              style="border-style:dashed;color:var(--muted)"
              (click)="cancelling.set(true)"
            >
              Cancel request <kbd class="kbd">C</kbd>
            </button>
          </div>
        }
      }

      @if (cancelling() && detail(); as r) {
        <sf-cancel-confirm [r]="r" (kept)="cancelling.set(false)" (confirmed)="cancel(r)" />
      }

      @if (confirming() && detail(); as r) {
        <sf-approve-modal [r]="r" (cancelled)="confirming.set(false)" (approved)="approve(r)" />
      }

      @if (sendingBack() && detail(); as r) {
        <sf-send-back-modal
          [reporter]="r.reporter"
          hint="Ask the one question that's blocking the spec — they'll answer without touching GitHub."
          placeholder="e.g. Which systems should we import from?"
          (cancelled)="sendingBack.set(false)"
          (sent)="sendBack(r, $event)"
        />
      }
    </admin-shell>
  `,
})
export class ApprovalQueue {
  private api = inject(Api);
  private router = inject(Router);
  private session = inject(Session);
  private poll = inject(Poll);

  typeLabel = TYPE_LABEL;
  private store = inject(Store);

  queue = this.store.inbox;
  sel = signal(0);
  detail = signal<RequestDetail | null>(null);
  confirming = signal(false);
  sendingBack = signal(false);
  cancelling = signal(false);
  dupDismissed = signal(false);
  showOrig = signal(false);
  showTurns = signal(false);
  triageDone = signal(false);
  triageRow = signal<Record<number, 'ok' | 'no'>>({});
  private wantSel = Number(inject(ActivatedRoute).snapshot.queryParamMap.get('sel')) || null;

  private lastSelId: number | null = null;

  constructor() {
    effect(() => {
      const rs = this.queue();
      if (this.wantSel != null) {
        const i = rs.findIndex((r) => r.id === this.wantSel);
        if (i >= 0) this.sel.set(i);
        this.wantSel = null;
      }
      if (untracked(this.sel) >= rs.length) this.sel.set(Math.max(0, rs.length - 1));
    });
    effect(() => {
      const q = this.queue();
      const i = this.sel();
      const id = q[i]?.id ?? null;
      if (id !== this.lastSelId) {
        // a DIFFERENT request — reset the per-item review state. A poll tick
        // refreshing the same selection must never wipe the reviewer's
        // expanded panels or triage choices mid-review.
        this.lastSelId = id;
        this.dupDismissed.set(false);
        this.showOrig.set(false);
        this.showTurns.set(false);
        this.triageDone.set(false);
        this.triageRow.set({});
      }
      if (id != null) this.api.request(id).subscribe((d) => this.detail.set(d));
      else this.detail.set(null);
    });
  }

  triage(r: RequestDetail): [string, string, string][] {
    const prio = r.urgency === 'high' ? 'High' : r.urgency === 'low' ? 'Low' : 'Normal';
    return [
      [
        'App',
        r.app_name,
        r.app_id ? 'matches the app named in intake' : 'new app — repo created on approval',
      ],
      [
        'Priority',
        prio,
        r.urgency === 'high' ? 'submitter flagged it urgent' : 'no urgency flag from the submitter',
      ],
    ];
  }
  setTriage(i: number, v: 'ok' | 'no') {
    this.triageRow.update((m) => ({ ...m, [i]: m[i] === v ? (undefined as never) : v }));
  }
  acceptAllTriage(_r: RequestDetail) {
    this.triageRow.set({ 0: 'ok', 1: 'ok' });
    this.triageDone.set(true);
  }
  approve(r: RequestDetail) {
    this.confirming.set(false);
    this.api.approve(r.id, this.session.user().name).subscribe(() => this.poll.nudge());
  }
  sendBack(r: RequestDetail, note: string) {
    this.sendingBack.set(false);
    this.api.sendBack(r.id, note, this.session.user().name).subscribe(() => {
      this.poll.nudge();
    });
  }
  cancel(r: RequestDetail) {
    this.cancelling.set(false);
    this.api.cancel(r.id, this.session.user().name).subscribe(() => this.poll.nudge());
  }
  retry(r: RequestDetail) {
    this.api.retry(r.id, this.session.user().name).subscribe(() => this.poll.nudge());
  }
  openIssue(id: number) {
    this.router.navigateByUrl(`/admin/requests/${id}`);
  }

  /** The single-key grammar the headers advertise: J/K move · ↵ open · A/S/C act. */
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
    const r = this.detail();
    if (k === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.sel.update((s) => Math.min(this.queue().length - 1, s + 1));
    } else if (k === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.sel.update((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter' && r) {
      e.preventDefault();
      this.openIssue(r.id);
    } else if (k === 'a' && r && !r.needs_human) {
      e.preventDefault();
      this.confirming.set(true);
    } else if (k === 's' && r && r.gate === 'approve_spec') {
      e.preventDefault();
      this.sendingBack.set(true);
    } else if (k === 'c' && r && !['done', 'cancelled'].includes(r.status)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cancelling.set(true);
    }
  }
}
