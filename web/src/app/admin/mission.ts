import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { Api } from '../core/api.service';
import { Evidence, FactoryRequest } from '../core/models';
import { Poll } from '../core/poll.service';
import { Session } from '../core/session.service';
import { Store } from '../core/store.service';
import { healthLine, timeAgo } from '../core/util';
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
            @if (allClear()) {
              <div class="msn-hero">
                <sf-glyph type="check" [size]="22" color="var(--green)" [fill]="1" />
                <div>
                  <div class="msn-hero__title">Nothing needs you</div>
                  <div class="msn-hero__sub">
                    Gates clear · no escalations. Runs continue below.
                  </div>
                </div>
              </div>
            }
            @if (!allClear()) {
              <!-- NEEDS ME — gates -->
              <div class="msn-bandhead">
                <sf-glyph type="ring" [size]="13" [fill]="0.5" color="var(--amber)" />
                <span>Needs me — gates</span>
                <span class="msn-count">{{ m.gates.length }}</span>
                <span class="msn-hint">J/K move · ↵ open · A approve · S send back</span>
              </div>
              @for (g of m.gates; track g.request.id) {
                <div
                  class="msn-gate"
                  [class.msn-focus]="flatIdx(g.request) === focusAt()"
                  tabindex="0"
                  (focus)="focusIdx.set(flatIdx(g.request))"
                >
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
                      <span
                        class="msn-evid__bit"
                        [class.green]="bit.tone === 'green'"
                        [class.purple]="bit.tone === 'purple'"
                        >{{ bit.text }}</span
                      >
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
            }

            <!-- IN FLIGHT — autonomous runs -->
            <div class="msn-bandhead">
              <sf-glyph type="dotted" [size]="13" color="var(--a500)" />
              <span>In flight — autonomous runs</span>
              <span class="msn-count">{{ m.runs.length }}</span>
              <span class="msn-hint">J/K move · T steer</span>
            </div>
            @for (it of m.runs; track it.request.id) {
              <div
                class="msn-run"
                [class.msn-run--slow]="it.run.health === 'slow'"
                [class.msn-focus]="flatIdx(it.request) === focusAt()"
                tabindex="0"
                (focus)="focusIdx.set(flatIdx(it.request))"
              >
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
                <span
                  class="msn-runstate"
                  [style.color]="it.run.health === 'slow' ? 'var(--amber)' : null"
                  >{{ healthLine(it.run) }}</span
                >
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

            <!-- STALLED — needs a human -->
            @if (m.stalled.length) {
              <div class="msn-bandhead">
                <sf-icon name="flag" [size]="13" color="var(--red)" />
                <span>Needs a human — stalled</span>
                <span class="msn-count">{{ m.stalled.length }}</span>
              </div>
              @for (r of m.stalled; track r.id) {
                <div
                  class="msn-gate msn-gate--red"
                  [class.msn-focus]="flatIdx(r) === focusAt()"
                  tabindex="0"
                  (focus)="focusIdx.set(flatIdx(r))"
                >
                  <div class="msn-gate__top">
                    <sf-glyph type="flag" [size]="15" color="var(--red)" />
                    <span class="msn-gate__title">{{ r.title }}</span>
                    <span class="red-pill">NEEDS HUMAN</span>
                    <span class="msn-meta">{{ r.app_name }}</span>
                    <span class="mono msn-ref">{{ r.ref }}</span>
                    <span style="margin-left:auto"></span>
                    <button class="btn sm" (click)="retry(r)">Retry stage</button>
                    <button class="btn sm" (click)="openIssue(r)">Open issue</button>
                  </div>
                  @if (r.needs_human_reason) {
                    <div class="msn-escal">{{ r.needs_human_reason }}</div>
                  }
                </div>
              }
            }

            <!-- RECENTLY DONE & WITH SUBMITTER -->
            @if (m.recent.length) {
              <div class="msn-bandhead">
                <sf-glyph type="check" [size]="13" color="var(--green)" />
                <span>Recently done &amp; with submitter</span>
              </div>
              @for (r of m.recent; track r.id) {
                <div class="msn-done" (click)="openIssue(r)">
                  <sf-glyph
                    [type]="
                      r.status === 'done' ? 'check' : r.status === 'cancelled' ? 'strike' : 'flag'
                    "
                    [size]="13"
                    [color]="
                      r.status === 'done'
                        ? 'var(--green)'
                        : r.status === 'cancelled'
                          ? 'var(--faint)'
                          : 'var(--muted)'
                    "
                  />
                  <span
                    class="msn-done__title"
                    [style.text-decoration]="r.status === 'cancelled' ? 'line-through' : ''"
                    >{{ r.title }}</span
                  >
                  <span class="msn-meta">{{ recentLine(r) }}</span>
                  <span class="mono msn-ref" style="margin-left:auto">{{
                    timeAgo(r.updated_at)
                  }}</span>
                </div>
              }
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
    .msn-gate,
    .msn-run {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
    }
    .msn-gate {
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
    .amber-pill,
    .red-pill {
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.05em;
      border-radius: 4px;
      padding: 1.5px 6px;
      white-space: nowrap;
      flex: none;
    }
    .amber-pill {
      color: var(--amber-tx);
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
    }
    .red-pill {
      color: var(--red-tx);
      background: var(--red-bg);
      border: 1px solid var(--red-line);
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
    .msn-evid__bit.purple {
      color: var(--a700);
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
      padding: 10px 16px;
      margin-bottom: 8px;
    }
    .msn-run--slow {
      border-color: var(--amber-line);
    }
    .msn-gate--red {
      border-color: var(--red-line);
    }
    .msn-focus {
      box-shadow: inset 0 0 0 2px var(--a500);
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
    .msn-pulse.amber,
    .msn-pfill.amber {
      background: var(--amber);
    }
    .msn-pulse.amber::after {
      border-color: var(--amber);
    }
    @keyframes msn-pulse {
      from {
        transform: scale(0.6);
        opacity: 0.5;
      }
      to {
        transform: scale(1.5);
        opacity: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .msn-pulse::after {
        animation: none;
      }
    }
    .msn-run__id {
      flex: 1;
      min-width: 0;
    }
    .msn-run__title {
      display: block;
      font-size: 13.5px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .msn-run__meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11.5px;
      color: var(--muted);
    }
    .msn-stagepill {
      font-family: var(--mono);
      font-size: 9.5px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--a700);
      background: var(--a50);
      border-radius: 4px;
      padding: 1.5px 6px;
    }
    .msn-progress {
      flex: none;
      width: 130px;
    }
    .msn-ptrack {
      height: 5px;
      border-radius: 3px;
      background: var(--surface-3);
      overflow: hidden;
    }
    .msn-pfill {
      height: 100%;
      background: var(--a500);
      border-radius: 3px;
      transition: width var(--dur) var(--ease);
    }
    .msn-pstep {
      display: block;
      text-align: right;
      font-size: 10.5px;
      color: var(--muted);
      margin-top: 3px;
    }
    .msn-runstate {
      flex: none;
      min-width: 170px;
      font-size: 12px;
      color: var(--fg2);
    }
    .msn-steer {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: -4px 0 8px 36px;
    }
    .msn-steer .input {
      flex: 1;
    }
    .msn-steer__err {
      font-size: 11.5px;
      color: var(--red);
    }
    .msn-escal {
      margin: 8px 0 0 24px;
      font-size: 12.5px;
      color: var(--red);
    }
    .msn-done {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      border-bottom: 1px solid var(--hairline);
      font-size: 12.5px;
      color: var(--muted);
      cursor: pointer;
    }
    .msn-done:hover {
      background: var(--surface-2);
    }
    .msn-done__title {
      color: var(--fg1);
      font-weight: 500;
    }
    .msn-hero {
      display: flex;
      align-items: center;
      gap: 14px;
      justify-content: center;
      padding: 30px 0 8px;
    }
    .msn-hero__title {
      font-size: 15px;
      font-weight: 600;
    }
    .msn-hero__sub {
      font-size: 12px;
      color: var(--muted);
    }
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

  steeringId = signal<number | null>(null);
  steerText = signal('');
  steerErr = signal('');
  /** ids steered this session — renders the optimistic "note queued" chip until acked. */
  steered = signal<Set<number>>(new Set());

  /** Expose display helpers for template. */
  healthLine = healthLine;
  timeAgo = timeAgo;

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
  evidenceBits(ev: Evidence | null): { text: string; tone: '' | 'green' | 'purple' }[] {
    if (!ev) return [{ text: 'no evidence recorded', tone: '' }];
    if (ev.kind === 'spec') {
      const bits: { text: string; tone: '' | 'green' | 'purple' }[] = [
        {
          text: `${ev.grounded_lines ?? 0} of ${ev.total_lines ?? 0} lines grounded in answers`,
          tone: 'green',
        },
      ];
      if (ev.interview_count)
        bits.push({
          text: `spec drafted from interview (${ev.interview_count} Q)`,
          tone: '',
        });
      return bits;
    }
    const bits: { text: string; tone: '' | 'green' | 'purple' }[] = [];
    if (ev.tests_total != null)
      bits.push({
        text: `${ev.tests_passed}/${ev.tests_total} tests pass`,
        tone: 'green',
      });
    if (ev.diff_added != null)
      bits.push({
        text: `diff +${ev.diff_added} −${ev.diff_removed} · ${ev.files_changed} files`,
        tone: '',
      });
    if (ev.reviewer_verdict)
      bits.push({ text: `reviewer: ${ev.reviewer_verdict}`, tone: 'purple' });
    return bits.length ? bits : [{ text: 'no evidence recorded', tone: '' }];
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

  retry(r: FactoryRequest) {
    this.api.retry(r.id, this.session.user().name).subscribe(() => this.poll.nudge());
  }
  openIssue(r: FactoryRequest) {
    this.router.navigateByUrl(`/admin/issue/${r.id}`);
  }
  allClear = computed(() => {
    const m = this.m();
    return !!m && m.gates.length === 0 && m.stalled.length === 0;
  });
  recentLine(r: FactoryRequest): string {
    if (r.status === 'done') return 'deployed to production';
    if (r.status === 'cancelled') return 'cancelled';
    return 'sent back · waiting on the submitter';
  }

  focusIdx = signal(0);

  /** focusIdx clamped to the live list — gates leave the band on approve, so the raw index can go stale. */
  focusAt = computed(() => Math.max(0, Math.min(this.focusIdx(), this.focusables().length - 1)));

  /** J/K traversal list: every actionable row in render order. */
  focusables = computed<{ kind: 'gate' | 'run' | 'stalled'; r: FactoryRequest }[]>(() => {
    const m = this.m();
    if (!m) return [];
    return [
      ...m.gates.map((g) => ({ kind: 'gate' as const, r: g.request })),
      ...m.runs.map((x) => ({ kind: 'run' as const, r: x.request })),
      ...m.stalled.map((r) => ({ kind: 'stalled' as const, r })),
    ];
  });

  flatIdx(r: FactoryRequest) {
    return this.focusables().findIndex((x) => x.r.id === r.id);
  }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.metaKey || e.ctrlKey) return;
    if (this.confirming() || this.sendingBack() || this.steeringId() !== null) return;
    const k = e.key.toLowerCase();
    const cur = this.focusables()[this.focusAt()];
    if (k === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.focusIdx.set(Math.min(this.focusables().length - 1, this.focusAt() + 1));
    } else if (k === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.focusIdx.set(Math.max(0, this.focusAt() - 1));
    } else if (e.key === 'Enter' && cur) {
      e.preventDefault();
      this.openIssue(cur.r);
    } else if (k === 'a' && cur?.kind === 'gate') {
      e.preventDefault();
      this.confirming.set(cur.r);
    } else if (k === 's' && cur?.kind === 'gate') {
      e.preventDefault();
      this.sendingBack.set(cur.r);
    } else if (k === 't' && cur?.kind === 'run') {
      e.preventDefault();
      this.openSteer(cur.r);
    }
  }
}
