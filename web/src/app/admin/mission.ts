import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { Api } from '../core/api.service';
import { Evidence, FactoryRequest, MissionGate } from '../core/models';
import { Poll } from '../core/poll.service';
import { Session } from '../core/session.service';
import { Store } from '../core/store.service';
import { elapsedShort, healthLine } from '../core/util';
import { ApproveModal, Autofocus, Glyph, Icon, SendBackModal } from '../kit/kit';
import { AdminShell } from './admin-shell';

/** Mission control — the supervision home (spec §6): what needs me, what's
 *  running autonomously, what stalled, what just finished. One poll
 *  (Store.mission), bands render top-down by consequence. */
@Component({
  selector: 'sf-mission-page',
  imports: [AdminShell, Icon, Glyph, ApproveModal, SendBackModal, Autofocus],
  template: `
    <admin-shell active="mission" title="Mission control">
      <span headerExtra class="row" style="gap:10px">
        <span style="font-size:12.5px;color:var(--muted)">{{ subtitle() }}</span>
      </span>
      <div class="list scroll" style="padding:18px 0 40px">
        <div style="max-width:920px;margin:0 auto;padding:0 22px">
          @if (m(); as m) {
            <!-- NEEDS ME — gates -->
            <div class="msn-bandhead">
              <sf-icon name="flag" [size]="13" color="var(--amber)" />
              <span>Needs me — gates</span>
              <span class="msn-count">{{ m.gates.length }}</span>
              <span class="msn-hint">grounded · A approve · S send back</span>
            </div>
            @for (g of m.gates; track g.request.id) {
              <div class="msn-gate" [class.msn-gate--merge]="g.request.gate === 'approve_merge'">
                <div class="msn-gate__top">
                  <sf-glyph type="ring" [size]="15" [fill]="0.5" color="var(--a500)" />
                  <span class="msn-gate__title">{{ g.request.title }}</span>
                  <span class="amber-pill">{{ gatePill(g.request) }}</span>
                  <span class="msn-meta">{{ g.request.app_name }}</span>
                  <span class="mono msn-ref">{{ g.request.ref }}</span>
                  <span style="margin-left:auto"></span>
                  <button class="btn primary sm" (click)="confirming.set(g.request)">
                    Approve <kbd class="kbd">A</kbd>
                  </button>
                  <button class="btn sm" (click)="sendingBack.set(g.request)">
                    Send back <kbd class="kbd">S</kbd>
                  </button>
                  <button class="btn sm" (click)="openInQueue(g.request)">Open</button>
                </div>
                <div class="msn-evid">
                  @for (bit of evidenceBits(g.evidence); track bit.text) {
                    <span class="msn-evid__bit" [class.green]="bit.tone === 'green'">{{ bit.text }}</span>
                  }
                </div>
                @if (g.evidence?.assumptions?.length) {
                  <div class="msn-assume">
                    <sf-glyph type="dotted" [size]="13" color="var(--amber)" />
                    {{ g.evidence!.assumptions.length }} assumption{{
                      g.evidence!.assumptions.length === 1 ? '' : 's'
                    }}: {{ g.evidence!.assumptions[0] }}
                  </div>
                }
                <div class="msn-side">{{ sideEffects(g.request) }}</div>
              </div>
            } @empty {
              <div class="msn-clear">No gates waiting on you.</div>
            }

            <!-- IN FLIGHT — autonomous runs -->
            <div class="msn-bandhead">
              <sf-glyph type="dotted" [size]="13" color="var(--a500)" />
              <span>In flight — autonomous runs</span>
              <span class="msn-count">{{ m.runs.length }}</span>
              <span class="msn-hint">live run-state · steer to course-correct</span>
            </div>
            @for (it of m.runs; track it.request.id) {
              <div class="msn-run" [class.msn-run--slow]="it.run.health === 'slow'">
                <span class="msn-pulse" [class.amber]="it.run.health !== 'healthy'"></span>
                <div class="msn-run__id">
                  <span class="msn-run__title">{{ it.request.title }}</span>
                  <span class="msn-run__meta">
                    <span class="msn-stagepill">{{ it.request.stage }}</span>
                    {{ it.request.app_name }} <span class="mono msn-ref">{{ it.request.ref }}</span>
                  </span>
                </div>
                <div class="msn-progress">
                  <div class="msn-ptrack">
                    <div
                      class="msn-pfill"
                      [class.amber]="it.run.health === 'slow'"
                      [style.width.%]="it.run.of ? (100 * it.run.step) / it.run.of : 0"
                    ></div>
                  </div>
                  <span class="mono msn-pstep">step {{ it.run.step }} / {{ it.run.of }}</span>
                </div>
                <span class="msn-runstate" [class.amber-tx]="it.run.health === 'slow'">{{
                  healthLine(it.run)
                }}</span>
                @if (steered().has(it.request.id)) {
                  <span class="chip">note queued</span>
                }
                <button class="btn sm" (click)="openSteer(it.request)">Steer</button>
              </div>
              @if (steeringId() === it.request.id) {
                <div class="msn-steer">
                  <input
                    class="input"
                    placeholder="Add a constraint the next step must honor…"
                    [value]="steerText()"
                    (input)="steerText.set($any($event.target).value)"
                    (keydown.enter)="sendSteer(it.request)"
                    (keydown.escape)="steeringId.set(null)"
                    sfAutofocus
                  />
                  <button class="btn primary sm" (click)="sendSteer(it.request)">Send</button>
                  @if (steerErr()) {
                    <span class="msn-steer__err">{{ steerErr() }}</span>
                  }
                </div>
              }
            } @empty {
              <div class="msn-clear">Nothing running right now.</div>
            }
          } @else {
            <div class="msn-empty">Loading…</div>
          }
        </div>
      </div>

      @if (confirming(); as r) {
        <sf-approve-modal [r]="r" (cancelled)="confirming.set(null)" (approved)="approve(r)" />
      }
      @if (sendingBack(); as r) {
        <sf-send-back-modal
          [reporter]="r.reporter"
          hint="Ask the one question that's blocking the spec — they'll answer without touching GitHub."
          placeholder="e.g. Which systems should we import from?"
          (cancelled)="sendingBack.set(null)"
          (sent)="sendBack(r, $event)"
        />
      }
    </admin-shell>
  `,
  styles: `
    .msn-empty {
      display: flex;
      align-items: center;
      gap: 10px;
      justify-content: center;
      padding: 48px 0;
      color: var(--muted);
      font-size: 13px;
    }
    .msn-bandhead {
      display: flex;
      align-items: center;
      gap: 9px;
      margin: 22px 2px 10px;
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--fg2);
    }
    .msn-bandhead:first-child {
      margin-top: 0;
    }
    .msn-count {
      font-size: 11px;
      color: var(--faint);
      background: var(--surface-2);
      border-radius: 9px;
      padding: 0 7px;
      font-weight: 500;
    }
    .msn-hint {
      margin-left: auto;
      font-size: 11px;
      font-weight: 400;
      letter-spacing: 0;
      text-transform: none;
      color: var(--faint);
    }
    .msn-gate {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      padding: 13px 16px 11px;
      margin-bottom: 9px;
    }
    .msn-gate__top {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
    }
    .msn-gate__title {
      font-size: 13.5px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .amber-pill {
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.05em;
      color: var(--amber);
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
      border-radius: 4px;
      padding: 1.5px 6px;
      white-space: nowrap;
      flex: none;
    }
    .msn-meta {
      font-size: 11.5px;
      color: var(--muted);
      white-space: nowrap;
    }
    .msn-ref {
      font-size: 11px;
      color: var(--faint);
    }
    .msn-evid {
      display: flex;
      flex-wrap: wrap;
      gap: 5px 16px;
      margin: 9px 0 0 24px;
      font-size: 12px;
      color: var(--fg2);
    }
    .msn-evid__bit.green {
      color: var(--green-tx);
      font-weight: 500;
    }
    .msn-assume {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 5px 0 0 24px;
      font-size: 12px;
      color: var(--amber);
    }
    .msn-side {
      margin: 6px 0 0 24px;
      font-size: 11.5px;
      color: var(--faint);
    }
    .msn-clear {
      padding: 14px 16px;
      color: var(--muted);
      font-size: 12.5px;
    }
    .msn-run {
      display: flex;
      align-items: center;
      gap: 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      padding: 10px 16px;
      margin-bottom: 8px;
    }
    .msn-run--slow {
      border-color: var(--amber-line);
    }
    .msn-pulse {
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--a500);
      position: relative;
    }
    .msn-pulse::after {
      content: '';
      position: absolute;
      inset: -5px;
      border-radius: 50%;
      border: 1px solid var(--a500);
      opacity: 0.35;
      animation: msn-pulse 1.8s var(--ease) infinite;
    }
    .msn-pulse.amber {
      background: var(--amber);
    }
    .msn-pulse.amber::after {
      border-color: var(--amber);
    }
    @keyframes msn-pulse {
      from { transform: scale(0.6); opacity: 0.5; }
      to { transform: scale(1.5); opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .msn-pulse::after { animation: none; }
    }
    .msn-run__id { flex: 1; min-width: 0; }
    .msn-run__title { display: block; font-size: 13.5px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .msn-run__meta { display: flex; align-items: center; gap: 8px;
      font-size: 11.5px; color: var(--muted); }
    .msn-stagepill { font-family: var(--mono); font-size: 9.5px;
      letter-spacing: 0.05em; text-transform: uppercase; color: var(--a700);
      background: var(--a50); border-radius: 4px; padding: 1.5px 6px; }
    .msn-progress { flex: none; width: 130px; }
    .msn-ptrack { height: 5px; border-radius: 3px; background: var(--surface-3); overflow: hidden; }
    .msn-pfill { height: 100%; background: var(--a500); border-radius: 3px;
      transition: width var(--dur) var(--ease); }
    .msn-pfill.amber { background: var(--amber); }
    .msn-pstep { display: block; text-align: right; font-size: 10.5px;
      color: var(--muted); margin-top: 3px; }
    .msn-runstate { flex: none; min-width: 170px; font-size: 12px; color: var(--fg2); }
    .amber-tx { color: var(--amber); }
    .msn-steer { display: flex; align-items: center; gap: 8px;
      margin: -4px 0 8px 36px; }
    .msn-steer .input { flex: 1; }
    .msn-steer__err { font-size: 11.5px; color: var(--red); }
  `,
})
export class Mission {
  protected router = inject(Router);
  private store = inject(Store);
  private api = inject(Api);
  private poll = inject(Poll);
  protected session = inject(Session);

  m = this.store.mission;

  confirming = signal<FactoryRequest | null>(null);
  sendingBack = signal<FactoryRequest | null>(null);

  gates = computed<MissionGate[]>(() => this.m()?.gates ?? []);

  steeringId = signal<number | null>(null);
  steerText = signal('');
  steerErr = signal('');
  /** ids steered this session — renders the optimistic "note queued" chip until acked. */
  steered = signal<Set<number>>(new Set());

  /** Expose display helpers for template. */
  healthLine = healthLine;
  elapsedShort = elapsedShort;

  openSteer(r: FactoryRequest) {
    this.steerErr.set('');
    this.steerText.set('');
    this.steeringId.set(this.steeringId() === r.id ? null : r.id);
  }

  sendSteer(r: FactoryRequest) {
    const note = this.steerText().trim();
    if (!note) return;
    this.api.steer(r.id, note, this.session.user().name).subscribe({
      next: () => {
        this.steeringId.set(null);
        this.steered.update((s) => new Set(s).add(r.id));
        this.poll.nudge();
      },
      error: (e: { status?: number }) => {
        // 409 = no longer in flight (reached a gate mid-typing) — keep the text, say why
        this.steerErr.set(
          e?.status === 409
            ? 'Run is no longer in flight — it reached a gate.'
            : 'Could not send — try again.',
        );
      },
    });
  }

  subtitle = computed(() => {
    const m = this.m();
    if (!m) return '';
    const g = m.gates.length;
    const r = m.runs.length;
    return `${g} gate${g === 1 ? '' : 's'} waiting on you · ${r} build${r === 1 ? '' : 's'} running`;
  });

  gatePill(r: FactoryRequest) {
    return r.gate === 'approve_merge' ? 'MERGE GATE' : 'SPEC GATE';
  }

  /** spec gate: "3 of 4 lines grounded in answers"; merge gate: tests/diff/reviewer. */
  evidenceBits(ev: Evidence | null): { icon: string; text: string; tone: '' | 'green' | 'purple' }[] {
    if (!ev) return [{ icon: 'check', text: 'no evidence recorded', tone: '' }];
    if (ev.kind === 'spec') {
      const bits: { icon: string; text: string; tone: '' | 'green' | 'purple' }[] = [
        {
          icon: 'check',
          text: `${ev.grounded_lines ?? 0} of ${ev.total_lines ?? 0} lines grounded in answers`,
          tone: 'green',
        },
      ];
      if (ev.interview_count)
        bits.push({ icon: 'check', text: `spec drafted from interview (${ev.interview_count} Q)`, tone: '' });
      return bits;
    }
    const bits: { icon: string; text: string; tone: '' | 'green' | 'purple' }[] = [];
    if (ev.tests_total != null)
      bits.push({ icon: 'check', text: `${ev.tests_passed}/${ev.tests_total} tests pass`, tone: 'green' });
    if (ev.diff_added != null)
      bits.push({
        icon: 'check',
        text: `diff +${ev.diff_added} −${ev.diff_removed} · ${ev.files_changed} files`,
        tone: '',
      });
    if (ev.reviewer_verdict)
      bits.push({ icon: 'check', text: `reviewer: ${ev.reviewer_verdict}`, tone: 'purple' });
    return bits.length ? bits : [{ icon: 'check', text: 'no evidence recorded', tone: '' }];
  }

  sideEffects(r: FactoryRequest): string {
    return r.gate === 'approve_merge'
      ? 'Approve merges to main · promotes to production'
      : 'Approve creates repo · writes SPEC.md PR · starts Architecture';
  }

  approve(r: FactoryRequest) {
    this.confirming.set(null);
    this.api.approve(r.id, this.session.user().name).subscribe(() => this.poll.nudge());
  }

  sendBack(r: FactoryRequest, note: string) {
    this.sendingBack.set(null);
    this.api.sendBack(r.id, note, this.session.user().name).subscribe(() => this.poll.nudge());
  }

  openInQueue(r: FactoryRequest) {
    this.router.navigate(['/admin/queue'], { queryParams: { sel: r.id } });
  }
}
