import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { Api } from '../core/api.service';
import { FactoryRequest, RequestDetail } from '../core/models';
import { Poll } from '../core/poll.service';
import { Session } from '../core/session.service';
import { TYPE_LABEL } from '../core/util';
import { Glyph, Icon, Mark, Sig } from '../kit/kit';
import { AdminShell } from './admin-shell';

/** C3 — Approval queue: the Stage-1 triage workhorse.
 *  Grounded spec + AI-triage-proposes/human-confirms + the one intentional friction point. */
@Component({
  selector: 'sf-queue-page',
  imports: [AdminShell, Glyph, Icon, Mark, Sig, FormsModule],
  template: `
    <admin-shell active="queue" title="Approval queue">
      <span headerExtra style="font-size:11.5px;color:var(--faint)">J/K move · ↵ open</span>
      <div class="split">
        <div class="queue scroll">
          @for (q of queue(); track q.id; let i = $index) {
            <div class="qitem focusable" tabindex="0" role="button" [class.on]="sel() === i"
              (click)="sel.set(i)" (keydown.enter)="sel.set(i)">
              <sf-glyph [type]="q.needs_human ? 'flag' : 'ring'" [size]="14" [color]="q.needs_human ? 'var(--red)' : 'var(--muted)'" [fill]="0.4" />
              <div style="flex:1;min-width:0"><div class="qitem__app">{{ q.app_name }}</div><div class="qitem__title">{{ q.title }}</div></div>
              @if (q.needs_human) { <sf-sig tone="red">Needs human</sf-sig> }
              @else if (q.gate === 'approve_merge') { <sf-sig tone="amber">Merge</sf-sig> }
              @else { <sf-sig tone="amber">Approve</sf-sig> }
            </div>
          } @empty {
            <div style="padding:24px 16px;font-size:13px;color:var(--faint);text-align:center">Queue's clear — nothing waiting.</div>
          }
        </div>
        <div class="pane scroll">
          @if (detail(); as r) {
            <div class="pane__inner">
              <div class="row" style="gap:9px">
                <sf-glyph [type]="r.needs_human ? 'flag' : 'dotted'" [size]="15" [color]="r.needs_human ? 'var(--red)' : 'var(--muted)'" />
                <span class="chip">{{ typeLabel[r.type] }}</span>
                <span style="font-size:12.5px;color:var(--muted)">{{ r.app_name }} · <span class="mono" style="font-size:12px">{{ r.ref }}</span></span>
              </div>
              <h2 style="font-size:23px;margin:8px 0 12px">{{ r.title }}</h2>

              @if (r.needs_human) {
                <div class="openq" style="margin-bottom:12px;border-color:#E7AEA7;background:var(--red-bg)">
                  <div class="row" style="gap:8px;margin-bottom:5px"><sf-glyph type="flag" [size]="14" color="var(--red)" /><span style="font-size:13px;font-weight:600;color:var(--red-tx)">Escalated — needs a person</span></div>
                  <div style="font-size:13.5px;color:var(--red-tx);line-height:1.45">{{ r.needs_human_reason }}</div>
                  <div class="row" style="gap:8px;margin-top:10px">
                    <button class="btn primary sm" (click)="retry(r)">Retry stage</button>
                    <button class="btn sm" (click)="openIssue(r.id)">Open issue</button>
                  </div>
                </div>
              }

              <!-- collapsible context -->
              <div style="border:1px solid var(--border);border-radius:8px;margin-bottom:10px">
                <button class="row" (click)="showOrig.set(!showOrig())" style="width:100%;gap:8px;padding:9px 12px;background:none;border:none;cursor:pointer;font-family:inherit;font-size:12.5px;color:var(--muted)">
                  <sf-icon [name]="showOrig() ? 'chevDown' : 'chevRight'" [size]="14" />Original request
                </button>
                @if (showOrig()) { <div style="padding:0 14px 12px;font-size:13.5px;color:var(--fg2);line-height:1.5">"{{ r.description }}"</div> }
              </div>
              @if (r.turns.length) {
                <div style="border:1px solid var(--border);border-radius:8px;margin-bottom:10px">
                  <button class="row" (click)="showTurns.set(!showTurns())" style="width:100%;gap:8px;padding:9px 12px;background:none;border:none;cursor:pointer;font-family:inherit;font-size:12.5px;color:var(--muted)">
                    <sf-icon [name]="showTurns() ? 'chevDown' : 'chevRight'" [size]="14" />Interview answers ({{ r.turns.length }})
                  </button>
                  @if (showTurns()) {
                    <div style="padding:0 14px 12px;display:flex;flex-direction:column;gap:8px">
                      @for (t of r.turns; track t.order) {
                        <div><div style="font-size:12.5px;color:var(--muted)">{{ t.question }}</div><div style="font-size:13.5px">{{ t.skipped ? 'Skipped.' : t.answer }}</div></div>
                      }
                    </div>
                  }
                </div>
              }

              @if (r.duplicate && !dupDismissed()) {
                <div class="dup" style="margin-bottom:12px">
                  <sf-glyph type="dotted" [size]="14" color="var(--faint)" />
                  <span style="flex:1;font-size:12.5px;color:var(--muted)">Looks similar to <span class="mono" style="font-size:12px;color:var(--fg2)">{{ r.duplicate.ref }}</span> "{{ r.duplicate.title }}" — possible duplicate.</span>
                  <button class="btn ghost sm" (click)="openIssue(r.duplicate.id)">Compare</button>
                  <button class="btn ghost sm" style="color:var(--faint)" (click)="dupDismissed.set(true)">Dismiss</button>
                </div>
              }

              <!-- AI triage — propose, human confirms -->
              @if (!r.needs_human) {
                <div class="triage" style="margin-bottom:16px">
                  <div class="row" style="gap:8px;margin-bottom:8px">
                    <sf-mark [size]="14" color="var(--a600)" /><span style="font-size:12.5px;font-weight:600">Suggested triage</span>
                    <span style="font-size:11px;color:var(--faint)">review before approving</span>
                    <span class="row" style="margin-left:auto;gap:7px"><button class="btn sm">Accept all <kbd class="kbd">⌥A</kbd></button><button class="btn ghost sm">Edit</button></span>
                  </div>
                  @for (row of triage(r); track row[0]) {
                    <div class="triage__row">
                      <span class="triage__k">{{ row[0] }}</span><span class="triage__v">{{ row[1] }}</span><span class="triage__why">— {{ row[2] }}</span>
                      <span style="display:flex;gap:6px;color:var(--faint)"><sf-icon name="check" [size]="13" /><sf-icon name="x" [size]="13" /></span>
                    </div>
                  }
                </div>
              }

              <div class="section-eyebrow" style="margin-bottom:10px">Draft spec</div>
              @for (line of r.spec_lines; track $index) {
                <div class="specline">
                  <span style="color:var(--faint);font-size:12px;margin-top:4px">•</span>
                  <span class="specline__b">{{ line.text }} <span class="prov" [class.assume]="line.assume">{{ line.assume ? '(ASSUMPTION — not stated)' : '(from: ' + line.prov + ')' }}</span></span>
                </div>
              } @empty {
                <div style="font-size:13px;color:var(--faint)">No draft spec yet.</div>
              }
              @if (r.spec_open_note) {
                <div class="openq" style="margin-top:12px">
                  <div class="row" style="gap:8px;margin-bottom:6px"><sf-glyph type="dotted" [size]="14" color="var(--amber)" /><span style="font-size:13px;font-weight:600;color:var(--amber-tx)">Open questions · assumptions</span></div>
                  <div style="font-size:13.5px;color:#3a2d10;line-height:1.45">{{ r.spec_open_note }}</div>
                </div>
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
            <button class="btn primary" (click)="confirming.set(true)">{{ r.gate === 'approve_merge' ? 'Approve merge' : 'Approve spec' }} <kbd class="kbd">A</kbd></button>
            @if (r.gate === 'approve_spec') { <button class="btn" (click)="sendingBack.set(true)">Send back <kbd class="kbd">S</kbd></button> }
            <span class="actionbar__note">{{ r.gate === 'approve_merge' ? 'Approve merges to main · promotes to production' : 'Approve creates repo · writes SPEC.md PR · starts Architecture' }}</span>
            <span style="width:1px;height:22px;background:var(--border);margin:0 2px"></span>
            <button class="btn sm" style="border-style:dashed;color:var(--muted)" (click)="cancelling.set(true)">Cancel request <kbd class="kbd">C</kbd></button>
          </div>
        }
      }

      @if (cancelling() && detail(); as r) {
        <div class="palette-scrim" style="align-items:center;padding-top:0" (click)="cancelling.set(false)">
          <div class="palette" style="width:420px;padding:22px 24px;align-self:center" (click)="$event.stopPropagation()">
            <h3 style="font-size:19px;margin-bottom:8px">Cancel this request?</h3>
            <p style="font-size:14px;color:var(--muted);margin:0 0 16px"><b style="color:var(--fg1)">{{ r.title }}</b> will be closed as won't-do and {{ r.reporter }} will be notified.</p>
            <div class="row" style="gap:9px;justify-content:flex-end">
              <button class="btn" (click)="cancelling.set(false)">Keep it</button>
              <button class="btn danger" (click)="cancel(r)">Cancel request</button>
            </div>
          </div>
        </div>
      }

      @if (confirming() && detail(); as r) {
        <div class="palette-scrim" style="align-items:center;padding-top:0" (click)="confirming.set(false)">
          <div class="palette" style="width:460px;padding:22px 24px;align-self:center" (click)="$event.stopPropagation()">
            <h3 style="font-size:19px;margin-bottom:8px">{{ r.gate === 'approve_merge' ? 'Approve this merge?' : 'Approve this spec?' }}</h3>
            <p style="font-size:14px;color:var(--muted);margin:0 0 4px">Approving <b style="color:var(--fg1)">{{ r.title }}</b> is irreversible. It will:</p>
            <ul style="margin:12px 0 16px;padding:0;list-style:none;display:flex;flex-direction:column;gap:9px">
              @for (step of confirmSteps(r); track $index) {
                <li class="row" style="gap:10px;font-size:13.5px">
                  <span style="width:20px;height:20px;border-radius:50%;background:var(--a50);display:flex;align-items:center;justify-content:center;flex:0 0 auto"><sf-icon name="check" [size]="12" color="var(--a600)" /></span>
                  <span><b style="font-weight:600">{{ step[0] }}</b> <span class="mono" style="font-size:12px;color:var(--muted);margin-left:6px">{{ step[1] }}</span></span>
                </li>
              }
            </ul>
            <div class="row" style="gap:9px;justify-content:flex-end">
              <button class="btn" (click)="confirming.set(false)">Cancel</button>
              <button class="btn primary" (click)="approve(r)">{{ r.gate === 'approve_merge' ? 'Approve & deploy' : 'Approve & start build' }}</button>
            </div>
          </div>
        </div>
      }

      @if (sendingBack() && detail(); as r) {
        <div class="palette-scrim" style="align-items:center;padding-top:0" (click)="sendingBack.set(false)">
          <div class="palette" style="width:460px;padding:22px 24px;align-self:center" (click)="$event.stopPropagation()">
            <h3 style="font-size:19px;margin-bottom:8px">Send back to {{ r.reporter }}?</h3>
            <p style="font-size:14px;color:var(--muted);margin:0 0 10px">Ask the one question that's blocking the spec — they'll answer without touching GitHub.</p>
            <textarea class="input area" placeholder="e.g. Which systems should we import from?" [(ngModel)]="sendBackNote" style="margin-bottom:14px"></textarea>
            <div class="row" style="gap:9px;justify-content:flex-end">
              <button class="btn" (click)="sendingBack.set(false)">Cancel</button>
              <button class="btn primary" [disabled]="!sendBackNote.trim()" (click)="sendBack(r)">Send back</button>
            </div>
          </div>
        </div>
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
  queue = signal<FactoryRequest[]>([]);
  sel = signal(0);
  detail = signal<RequestDetail | null>(null);
  confirming = signal(false);
  sendingBack = signal(false);
  cancelling = signal(false);
  sendBackNote = '';
  dupDismissed = signal(false);
  showOrig = signal(false);
  showTurns = signal(false);
  private wantSel = Number(inject(ActivatedRoute).snapshot.queryParamMap.get('sel')) || null;

  constructor() {
    effect(() => {
      this.poll.version();
      this.api.inbox().subscribe((rs) => {
        this.queue.set(rs);
        if (this.wantSel != null) {
          const i = rs.findIndex((r) => r.id === this.wantSel);
          if (i >= 0) this.sel.set(i);
          this.wantSel = null;
        }
        if (this.sel() >= rs.length) this.sel.set(Math.max(0, rs.length - 1));
      });
    });
    effect(() => {
      const q = this.queue();
      const i = this.sel();
      this.dupDismissed.set(false);
      this.showOrig.set(false);
      this.showTurns.set(false);
      if (q[i]) this.api.request(q[i].id).subscribe((d) => this.detail.set(d));
      else this.detail.set(null);
    });
  }

  triage(r: RequestDetail): [string, string, string][] {
    return [
      ['App', r.app_name, r.app_id ? 'matches the app named in intake' : 'new app — repo created on approval'],
      ['Owner', r.assignee ?? 'Kim P.', 'owns the recent specs for this app'],
      ['Priority', r.priority, r.urgency === 'high' ? 'submitter flagged it urgent' : 'no urgency flag from the submitter'],
    ];
  }
  confirmSteps(r: RequestDetail): [string, string][] {
    if (r.gate === 'approve_merge') {
      return [['Merge the PR to main', r.repo ?? ''], ['Promote main → production', 'protected-branch approval'], ['Trigger the deploy', 'Stage 6']];
    }
    const repo = r.repo ?? `micron/${(r.new_app_name || r.title).toLowerCase().replaceAll(' ', '-').slice(0, 28)}`;
    return [['Create the GitHub repo', repo], ['Open the SPEC.md pull request', 'from the grounded draft'], ['Start the Architecture stage', 'hands off to Stage 2']];
  }

  approve(r: RequestDetail) {
    this.confirming.set(false);
    this.api.approve(r.id, this.session.user().name).subscribe(() => this.poll.nudge());
  }
  sendBack(r: RequestDetail) {
    this.sendingBack.set(false);
    this.api.sendBack(r.id, this.sendBackNote.trim(), this.session.user().name).subscribe(() => {
      this.sendBackNote = '';
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
  openIssue(id: number) { this.router.navigateByUrl(`/admin/issue/${id}`); }

  /** The single-key grammar the headers advertise: J/K move · ↵ open · A/S/C act. */
  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.metaKey || e.ctrlKey) return;
    if (this.confirming() || this.sendingBack() || this.cancelling()) {
      if (e.key === 'Escape') { this.confirming.set(false); this.sendingBack.set(false); this.cancelling.set(false); }
      return;
    }
    const k = e.key.toLowerCase();
    const r = this.detail();
    if (k === 'j' || e.key === 'ArrowDown') { e.preventDefault(); this.sel.update((s) => Math.min(this.queue().length - 1, s + 1)); }
    else if (k === 'k' || e.key === 'ArrowUp') { e.preventDefault(); this.sel.update((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter' && r) { e.preventDefault(); this.openIssue(r.id); }
    else if (k === 'a' && r && !r.needs_human) { e.preventDefault(); this.confirming.set(true); }
    else if (k === 's' && r && r.gate === 'approve_spec') { e.preventDefault(); this.sendingBack.set(true); }
    else if (k === 'c' && r && !['done', 'cancelled'].includes(r.status)) { e.preventDefault(); e.stopImmediatePropagation(); this.cancelling.set(true); }
  }
}
