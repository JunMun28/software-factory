import { Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';

import { factoryColumns, MapCard, MapColumn, MapGate } from '../core/map-view';
import { Store } from '../core/store.service';
import { Glyph } from '../kit/kit';
import { AdminShell } from './admin-shell';

type Lane = { kind: 'stage'; col: MapColumn } | { kind: 'gate'; gate: MapGate };

/** Factory map (ADR 0016) — a spatial overview lens, NOT the worklist.
 *  Every live Work item across stage columns; click a card to drill into its
 *  delivery map on request-detail. Derived from store.requests + store.mission
 *  (stores nothing new). Mission control stays the default landing + worklist. */
@Component({
  selector: 'sf-map-page',
  imports: [AdminShell, Glyph],
  template: `
    <admin-shell active="map" title="Factory map">
      <span headerExtra class="row" style="gap:10px">
        <span style="font-size:12.5px;color:var(--muted)">{{ subtitle() }}</span>
      </span>

      <div class="scroll" style="position:absolute;inset:0;overflow:auto;padding:18px 20px 28px">
        <div class="fm-kpis">
          @for (k of kpis(); track k.lbl) {
            <div class="fm-kpi" [style.--kc]="k.color">
              <div class="fm-kpi__l"><span class="fm-kpi__dot"></span>{{ k.lbl }}</div>
              <div class="fm-kpi__n">{{ k.n }}</div>
            </div>
          }
        </div>

        <div class="fm-scroll">
          <div class="fm-lane">
            @for (it of lane(); track $index) {
              @if (it.kind === 'stage') {
                <div class="fm-stage">
                  <div class="fm-hd">
                    <div
                      class="fm-ring"
                      [style.--rp]="ringPct(it.col)"
                      [style.--rc]="hotColor(it.col)"
                    >
                      <span class="fm-ring__n">{{ count(it.col) }}</span>
                    </div>
                    <div class="fm-name">{{ it.col.label }}</div>
                    <div class="fm-sub">
                      {{ count(it.col) }} {{ count(it.col) === 1 ? 'item' : 'items' }}
                    </div>
                  </div>
                  <div class="fm-cards">
                    @for (c of it.col.cards; track c.id) {
                      <button class="fm-card" [attr.data-st]="c.state" (click)="open(c.id)">
                        <div class="fm-card__t">
                          @if (c.state === 'run') {
                            <span class="fm-pulse"></span>
                          }
                          <span class="fm-card__ti">{{ c.title }}</span>
                        </div>
                        <div class="fm-card__ref">{{ c.ref }} · {{ c.app }}</div>
                        <div class="fm-card__meta">
                          @if (pill(c); as p) {
                            <span class="fm-pill" [attr.data-st]="c.state">{{ p }}</span>
                          }
                          @if (c.state === 'run' && c.of) {
                            <span class="fm-step">step {{ c.step }}/{{ c.of }}</span>
                          }
                        </div>
                      </button>
                    } @empty {
                      <div class="fm-empty">stage idle</div>
                    }
                  </div>
                </div>
              } @else {
                <div class="fm-gate" [class.hot]="it.gate.waiting > 0">
                  <div class="fm-diamond"><sf-glyph type="flag" [size]="14" /></div>
                  <div class="fm-glabel">{{ it.gate.label }}</div>
                  <div class="fm-gcount">
                    {{ it.gate.waiting > 0 ? it.gate.waiting + ' waiting' : 'clear' }}
                  </div>
                </div>
              }
            }
          </div>
        </div>
      </div>
    </admin-shell>
  `,
  styles: `
    .fm-kpis {
      display: grid;
      grid-template-columns: repeat(4, minmax(150px, 1fr));
      gap: 12px;
      max-width: 760px;
      margin-bottom: 22px;
    }
    .fm-kpi {
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      background: var(--surface);
      padding: 12px 14px;
      position: relative;
      overflow: hidden;
    }
    .fm-kpi::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background: var(--kc, var(--a500));
    }
    .fm-kpi__l {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 11px;
      font-weight: 600;
      color: var(--muted);
    }
    .fm-kpi__dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--kc, var(--a500));
    }
    .fm-kpi__n {
      font-size: 25px;
      font-weight: 700;
      margin-top: 6px;
      font-variant-numeric: tabular-nums;
    }
    .fm-scroll {
      overflow-x: auto;
      padding-bottom: 6px;
    }
    .fm-lane {
      position: relative;
      display: flex;
      align-items: flex-start;
      min-width: max-content;
      padding: 6px 0;
    }
    .fm-lane::before {
      content: '';
      position: absolute;
      left: 80px;
      right: 40px;
      top: 38px;
      height: 2px;
      background: linear-gradient(90deg, var(--a700), var(--a200));
      opacity: 0.45;
    }
    .fm-stage {
      width: 184px;
      flex: none;
      padding: 0 9px;
      position: relative;
      z-index: 1;
    }
    .fm-hd {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      text-align: center;
      margin-bottom: 12px;
    }
    .fm-ring {
      position: relative;
      width: 58px;
      height: 58px;
      border-radius: 50%;
      background: conic-gradient(
        var(--rc, var(--a500)) calc(var(--rp, 0) * 1%),
        var(--surface-3) 0
      );
    }
    .fm-ring::before {
      content: '';
      position: absolute;
      inset: 5px;
      border-radius: 50%;
      background: var(--bg);
    }
    .fm-ring__n {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      font-weight: 700;
      font-size: 18px;
      font-variant-numeric: tabular-nums;
    }
    .fm-name {
      font-size: 12.5px;
      font-weight: 700;
    }
    .fm-sub {
      font-size: 10.5px;
      color: var(--muted);
    }
    .fm-cards {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .fm-card {
      text-align: left;
      width: 100%;
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      background: var(--surface);
      padding: 9px 10px;
      cursor: pointer;
      font-family: var(--body);
      transition:
        border-color var(--dur) var(--ease),
        transform var(--dur) var(--ease);
    }
    .fm-card:hover {
      border-color: var(--border-strong);
      transform: translateY(-1px);
    }
    .fm-card[data-st='gate'] {
      border-color: var(--amber-line);
    }
    .fm-card[data-st='stalled'] {
      border-color: var(--red-line);
    }
    .fm-card[data-st='run'] {
      border-color: var(--accent-tint-bd);
    }
    .fm-pulse {
      position: relative;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--a500);
      flex: none;
    }
    .fm-pulse::after {
      content: '';
      position: absolute;
      inset: -4px;
      border-radius: 50%;
      border: 1px solid var(--a500);
      opacity: 0.4;
      animation: fm-pulse 1.8s var(--ease) infinite;
    }
    @keyframes fm-pulse {
      from {
        transform: scale(0.6);
        opacity: 0.5;
      }
      to {
        transform: scale(1.6);
        opacity: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .fm-pulse::after {
        animation: none;
      }
    }
    .fm-card__t {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
      font-weight: 600;
    }
    .fm-card__ti {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .fm-card__ref {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--faint);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .fm-card__meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 7px;
    }
    .fm-pill {
      font-size: 8.5px;
      font-weight: 700;
      letter-spacing: 0.04em;
      padding: 1px 5px;
      border-radius: 4px;
      text-transform: uppercase;
    }
    .fm-pill[data-st='gate'] {
      color: var(--amber-tx);
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
    }
    .fm-pill[data-st='stalled'] {
      color: var(--red-tx);
      background: var(--red-bg);
      border: 1px solid var(--red-line);
    }
    .fm-pill[data-st='run'] {
      color: var(--accent-tx);
      background: var(--a50);
      border: 1px solid var(--a100);
    }
    .fm-pill[data-st='sent'] {
      color: var(--info);
      background: var(--info-bg);
      border: 1px solid var(--border);
    }
    .fm-step {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--muted);
      margin-left: auto;
    }
    .fm-empty {
      border: 1px dashed var(--border);
      border-radius: var(--r-lg);
      padding: 14px 10px;
      text-align: center;
      color: var(--faint);
      font-size: 11px;
    }
    .fm-gate {
      width: 92px;
      flex: none;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-top: 12px;
      position: relative;
      z-index: 2;
    }
    .fm-diamond {
      width: 44px;
      height: 44px;
      border-radius: 9px;
      transform: rotate(45deg);
      display: grid;
      place-items: center;
      background: var(--surface);
      border: 1.5px solid var(--border-strong);
      color: var(--muted);
    }
    .fm-diamond sf-glyph {
      transform: rotate(-45deg);
    }
    .fm-gate.hot .fm-diamond {
      background: var(--amber-bg);
      border-color: var(--amber-line);
      color: var(--amber-tx);
    }
    .fm-glabel {
      font-size: 10.5px;
      color: var(--muted);
      text-align: center;
      margin-top: 11px;
      font-weight: 600;
      line-height: 1.25;
    }
    .fm-gcount {
      margin-top: 5px;
      font-size: 9.5px;
      font-weight: 700;
      color: var(--faint);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 1px 8px;
    }
    .fm-gate.hot .fm-gcount {
      color: var(--amber-tx);
      background: var(--amber-bg);
      border-color: var(--amber-line);
    }
  `,
})
export class FactoryMap {
  private store = inject(Store);
  private router = inject(Router);

  v = computed(() => factoryColumns(this.store.requests(), this.store.mission()));

  lane = computed<Lane[]>(() => {
    const v = this.v();
    const out: Lane[] = [];
    for (const col of v.columns) {
      out.push({ kind: 'stage', col });
      const g = v.gates.find((x) => x.afterStage === col.key);
      if (g) out.push({ kind: 'gate', gate: g });
    }
    return out;
  });

  /** Live items in a column; the Done column shows its total (all are 'done'). */
  count(col: MapColumn): number {
    const live = col.cards.filter((c) => c.state !== 'done').length;
    return live || col.cards.length;
  }

  maxCount = computed(() => Math.max(1, ...this.v().columns.map((c) => this.count(c))));
  ringPct(col: MapColumn): number {
    return Math.round((this.count(col) / this.maxCount()) * 100);
  }

  hotColor(col: MapColumn): string {
    const cards = col.cards;
    if (cards.some((c) => c.state === 'stalled')) return 'var(--red)';
    if (cards.some((c) => c.state === 'gate')) return 'var(--amber)';
    if (cards.some((c) => c.state === 'run')) return 'var(--a500)';
    if (cards.length && cards.every((c) => c.state === 'done')) return 'var(--green)';
    return 'var(--faint)';
  }

  pill(c: MapCard): string | null {
    const m: Record<string, string | null> = {
      gate: 'GATE',
      stalled: 'NEEDS HUMAN',
      run: 'RUNNING',
      sent: 'SENT BACK',
      triage: null,
      done: null,
    };
    return m[c.state];
  }

  stats = computed(() => {
    const cards = this.v().columns.flatMap((c) => c.cards);
    const live = cards.filter((c) => c.state !== 'done');
    return {
      live: live.length,
      run: live.filter((c) => c.state === 'run').length,
      gate: live.filter((c) => c.state === 'gate').length,
      stalled: live.filter((c) => c.state === 'stalled').length,
    };
  });

  subtitle = computed(() => {
    const s = this.stats();
    return `${s.live} in flight · ${s.gate} waiting on you · ${s.stalled} stalled`;
  });

  kpis = computed(() => {
    const s = this.stats();
    return [
      { lbl: 'In flight', n: s.live, color: 'var(--a500)' },
      { lbl: 'Running', n: s.run, color: 'var(--a500)' },
      { lbl: 'Awaiting approval', n: s.gate, color: 'var(--amber)' },
      { lbl: 'Needs a human', n: s.stalled, color: 'var(--red)' },
    ];
  });

  open(id: number) {
    this.router.navigateByUrl('/admin/requests/' + id + '?view=map');
  }
}
