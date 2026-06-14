import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { factoryColumns, MapCard, MapColumn, sortedExceptions } from '../core/map-view';
import { Store } from '../core/store.service';
import { AdminShell } from './admin-shell';

/** Factory map (ADR 0016) — a spatial overview lens, NOT the worklist.
 *  Every live Work item across stage columns; click a card to drill into its
 *  delivery map on request-detail. Derived from store.requests + store.mission
 *  (stores nothing new). Mission control stays the default landing + worklist. */
@Component({
  selector: 'sf-map-page',
  imports: [AdminShell],
  template: `
    <admin-shell active="map" title="Factory map">
      <span headerExtra class="row" style="gap:10px">
        <span style="font-size:12.5px;color:var(--muted)">{{ subtitle() }}</span>

        <!-- P2 toolbar: filter + search -->
        <span class="seg fm-toolbar" style="margin-left:12px">
          <button [class.on]="filter() === 'all'" (click)="filter.set('all')">All</button>
          <button [class.on]="filter() === 'attention'" (click)="filter.set('attention')">Needs attention</button>
        </span>
        <input
          class="fm-search"
          type="search"
          placeholder="Search…"
          [value]="search()"
          (input)="search.set($any($event.target).value)"
          aria-label="Search work items"
        />
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

        @if (!loaded()) {
          <!-- Loading skeleton -->
          <div class="fm-lane fm-skel-lane">
            @for (_ of [0,1,2,3,4,5]; track $index) {
              <div class="fm-stage">
                <div class="fm-hd">
                  <div class="fm-skel fm-skel--ring"></div>
                  <div class="fm-skel fm-skel--name"></div>
                  <div class="fm-skel fm-skel--sub"></div>
                </div>
                <div class="fm-cards">
                  <div class="fm-skel fm-skel--card"></div>
                  <div class="fm-skel fm-skel--card"></div>
                </div>
              </div>
            }
          </div>
        } @else {
          <div class="fm-scroll">
            <div class="fm-lane">
              @for (col of columns(); track col.key) {
                <div class="fm-stage">
                  <!-- Sticky per-column ring header (P1) -->
                  <div
                    class="fm-hd"
                    [attr.aria-label]="hdAriaLabel(col)"
                  >
                    <div
                      class="fm-ring"
                      [style.--rp]="ringPct(col)"
                      [style.--rc]="hotColor(col)"
                      [attr.aria-label]="ringAriaLabel(col)"
                    >
                      <span class="fm-ring__n">{{ count(col) }}</span>
                    </div>
                    <div class="fm-name">{{ col.label }}</div>
                    <!-- Re-homed waiting count as interactive amber chip (P0) -->
                    @if (waitingCount(col); as w) {
                      <button
                        class="fm-sub fm-sub--wait"
                        [attr.aria-label]="waitingAriaLabel(col, w)"
                        (click)="filterToWaiting(col)"
                      >
                        {{ count(col) }} {{ count(col) === 1 ? 'item' : 'items' }} · {{ w }} {{ waitingLabel(col) }} →
                      </button>
                    } @else {
                      <div class="fm-sub">
                        {{ count(col) }} {{ count(col) === 1 ? 'item' : 'items' }}
                      </div>
                    }
                  </div>

                  <!-- Aggregate-first card body (P0) -->
                  <div class="fm-cards">
                    @let peek = exceptionPeek(col);
                    @let extraRun = runningCount(col);
                    @let extraMore = moreCount(col);

                    @if (col.cards.length === 0) {
                      <div class="fm-empty">stage idle</div>
                    } @else {
                      <!-- Top-5 exceptions peek -->
                      @for (c of peek; track c.id) {
                        <button
                          class="fm-card"
                          [attr.data-st]="c.state"
                          [attr.aria-label]="cardAriaLabel(c)"
                          (click)="open(c.id)"
                        >
                          <div class="fm-card__t">
                            @if (c.state === 'run') {
                              <span class="fm-pulse" aria-hidden="true"></span>
                            }
                            <span class="fm-card__ti" [title]="c.title">{{ c.title }}</span>
                          </div>
                          <div class="fm-card__ref" [title]="c.ref + ' · ' + c.app">{{ c.ref }} · {{ c.app }}</div>
                          <div class="fm-card__meta">
                            @if (pill(c); as p) {
                              <span class="fm-pill" [attr.data-st]="c.state">{{ p }}</span>
                            }
                            @if (c.state === 'run' && c.of) {
                              <span class="fm-step">step {{ c.step }}/{{ c.of }}</span>
                            }
                          </div>
                        </button>
                      }

                      <!-- +N running collapse chip -->
                      @if (extraRun > 0) {
                        <div class="fm-chip fm-chip--run" [attr.aria-label]="extraRun + ' more running'">
                          <span class="fm-pulse fm-pulse--sm" aria-hidden="true"></span>
                          +{{ extraRun }} running
                        </div>
                      }

                      <!-- +N more → drill chip -->
                      @if (extraMore > 0) {
                        <button
                          class="fm-chip fm-chip--more"
                          [attr.aria-label]="'Show all ' + count(col) + ' items in ' + col.label"
                          (click)="drillToStage(col)"
                        >
                          +{{ extraMore }} more →
                        </button>
                      }
                    }
                  </div>
                </div>
              }
            </div>
          </div>
        }
      </div>
    </admin-shell>
  `,
  styles: `
    /* ── KPI tiles ── */
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

    /* ── Toolbar (P2) ── */
    .fm-toolbar {
      font-size: 12px;
    }
    .fm-search {
      border: 1px solid var(--border-strong);
      border-radius: var(--r);
      background: var(--surface);
      color: var(--fg1);
      font-family: var(--body);
      font-size: 12.5px;
      padding: 4px 10px;
      outline: none;
      width: 160px;
    }
    .fm-search:focus {
      border-color: var(--a500);
    }

    /* ── Lane + stage grid (P0 fit-to-width) ── */
    .fm-scroll {
      overflow-x: auto;
      padding-bottom: 6px;
    }
    .fm-lane {
      position: relative;
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 0;
      padding: 6px 0;
      min-width: 768px;   /* allow scroll below 768, fill above */
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
      /* P2: slow rail animation */
      background-size: 200% 100%;
      animation: fm-rail 8s linear infinite;
    }
    @keyframes fm-rail {
      from { background-position: 0% 0%; }
      to   { background-position: 200% 0%; }
    }
    @media (prefers-reduced-motion: reduce) {
      .fm-lane::before { animation: none; }
      .fm-ring { transition: none !important; }
    }
    .fm-stage {
      padding: 0 9px;
      position: relative;
      z-index: 1;
    }

    /* ── Sticky ring header (P1) ── */
    .fm-hd {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      text-align: center;
      margin-bottom: 12px;
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--bg);
      padding: 6px 0 8px;
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
      /* P2: animate ring fill on poll */
      transition: background 0.6s var(--ease);
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
    /* Sub-line: plain item count */
    .fm-sub {
      font-size: 11.5px;   /* raised from 10.5px (P0) */
      color: var(--muted);
    }
    /* Sub-line: interactive amber waiting chip */
    .fm-sub--wait {
      display: inline-flex;
      align-items: center;
      gap: 0;
      font-size: 11.5px;   /* raised from 10.5px (P0) */
      font-weight: 600;
      color: var(--amber-tx);
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
      border-radius: 999px;
      padding: 1px 9px;
      cursor: pointer;
      font-family: var(--body);
      transition: opacity var(--dur) var(--ease);
      white-space: nowrap;
    }
    .fm-sub--wait:hover { opacity: 0.8; }

    /* ── Card body ── */
    .fm-cards {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    /* ── Card — shape language (P1): reuses bcard spine idea ── */
    .fm-card {
      text-align: left;
      width: 100%;
      border: 1px solid var(--border);
      border-left-width: 3px;         /* spine (P1) */
      border-left-color: var(--border);
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
    /* State spine colors (P1) */
    .fm-card[data-st='gate'] {
      border-left-color: var(--amber-line);
      border-color: var(--amber-line);
    }
    .fm-card[data-st='stalled'] {
      border-left-color: var(--red-line);
      border-color: var(--red-line);
    }
    .fm-card[data-st='run'] {
      border-left-color: var(--accent-tint-bd);
      border-color: var(--accent-tint-bd);
    }
    .fm-card[data-st='sent'] {
      border-left-color: var(--info);
    }

    /* ── Pulse animation ── */
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
    .fm-pulse--sm {
      width: 6px;
      height: 6px;
    }
    .fm-pulse--sm::after {
      inset: -3px;
    }
    @keyframes fm-pulse {
      from { transform: scale(0.6); opacity: 0.5; }
      to   { transform: scale(1.6); opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .fm-pulse::after { animation: none; }
    }

    /* ── Card text rows ── */
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
      font-size: 11px;       /* raised from 10px (P0); --faint → --muted */
      color: var(--muted);   /* raised from --faint (P0) */
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
      font-size: 11.5px;    /* raised from 8.5px (P0) */
      font-weight: 700;
      /* removed text-transform:uppercase + letter-spacing (P0) */
      padding: 1px 6px;
      border-radius: 4px;
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
      font-size: 11px;    /* raised from 10px (P0) */
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

    /* ── Aggregate collapse chips (P0) ── */
    .fm-chip {
      font-size: 11.5px;
      font-weight: 600;
      border-radius: var(--r-lg);
      padding: 6px 10px;
      text-align: center;
      cursor: default;
    }
    .fm-chip--run {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      color: var(--accent-tx);
      background: var(--a50);
      border: 1px solid var(--a100);
    }
    .fm-chip--more {
      color: var(--muted);
      background: var(--surface-2);
      border: 1px solid var(--border);
      cursor: pointer;
      font-family: var(--body);
      width: 100%;
      transition: border-color var(--dur) var(--ease);
    }
    .fm-chip--more:hover {
      border-color: var(--border-strong);
      color: var(--fg1);
    }

    /* ── Loading skeleton (P2) ── */
    .fm-skel-lane {
      opacity: 0.5;
    }
    .fm-skel {
      border-radius: var(--r-lg);
      background: var(--surface-3);
      animation: fm-shimmer 1.4s ease infinite alternate;
    }
    @keyframes fm-shimmer {
      from { opacity: 0.4; }
      to   { opacity: 0.9; }
    }
    @media (prefers-reduced-motion: reduce) {
      .fm-skel { animation: none; opacity: 0.5; }
    }
    .fm-skel--ring  { width: 58px; height: 58px; border-radius: 50%; }
    .fm-skel--name  { width: 70%; height: 14px; }
    .fm-skel--sub   { width: 50%; height: 11px; }
    .fm-skel--card  { height: 72px; }
  `,
})
export class FactoryMap {
  private store = inject(Store);
  private router = inject(Router);

  /** P2 filter/search signals */
  filter = signal<'all' | 'attention'>('all');
  search = signal('');

  private raw = computed(() => factoryColumns(this.store.requests(), this.store.mission()));

  /** True once the store has emitted at least one non-null value */
  loaded = computed(() => this.store.requests().length > 0 || this.store.mission() !== null);

  /** Columns after filter/search (P2) */
  columns = computed(() => {
    const cols = this.raw().columns;
    const q = this.search().trim().toLowerCase();
    const needsAttention = this.filter() === 'attention';

    return cols.map((col) => {
      let cards = col.cards;
      if (needsAttention) {
        cards = cards.filter((c) => c.state === 'gate' || c.state === 'stalled');
      }
      if (q) {
        cards = cards.filter(
          (c) =>
            c.title.toLowerCase().includes(q) ||
            c.ref.toLowerCase().includes(q) ||
            c.app.toLowerCase().includes(q),
        );
      }
      return { ...col, cards };
    });
  });

  /** Live items in a column; Done column shows its total */
  count(col: MapColumn): number {
    const live = col.cards.filter((c) => c.state !== 'done').length;
    return live || col.cards.length;
  }

  /** P2: ring fill = fraction of column needing a human (gate + stalled) */
  maxCount = computed(() => Math.max(1, ...this.columns().map((c) => this.count(c))));
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

  /** Waiting count from column.cards (fixes mismatch vs separate gate query) */
  waitingCount(col: MapColumn): number {
    if (col.key === 'spec') return col.cards.filter((c) => c.state === 'gate').length;
    if (col.key === 'review') return col.cards.filter((c) => c.state === 'gate').length;
    return 0;
  }

  waitingLabel(col: MapColumn): string {
    return col.key === 'review' ? 'at merge gate →' : 'awaiting approval →';
  }

  waitingAriaLabel(col: MapColumn, w: number): string {
    const label = col.key === 'review' ? 'at merge gate' : 'awaiting approval';
    return `Filter ${col.label} to ${w} ${w === 1 ? 'item' : 'items'} ${label}`;
  }

  filterToWaiting(col: MapColumn) {
    this.router.navigateByUrl(`/admin/list?stage=${col.key}&state=gate`);
  }

  drillToStage(col: MapColumn) {
    this.router.navigateByUrl(`/admin/list?stage=${col.key}`);
  }

  /** Top-5 exceptions peek sorted by severity (P0) */
  exceptionPeek(col: MapColumn): MapCard[] {
    return sortedExceptions(col.cards, 5);
  }

  /** Count of running items NOT in the peek (shown in collapse chip) */
  runningCount(col: MapColumn): number {
    const peek = this.exceptionPeek(col);
    const peekIds = new Set(peek.map((c) => c.id));
    return col.cards.filter((c) => c.state === 'run' && !peekIds.has(c.id)).length;
  }

  /** Count of non-running items beyond the peek (for "+N more" chip). */
  moreCount(col: MapColumn): number {
    const peek = this.exceptionPeek(col);
    const peekIds = new Set(peek.map((c) => c.id));
    return col.cards.filter((c) => !peekIds.has(c.id) && c.state !== 'run').length;
  }

  pill(c: MapCard): string | null {
    const m: Record<string, string | null> = {
      gate: 'Gate',
      stalled: 'Needs human',
      run: 'Running',
      sent: 'Sent back',
      triage: null,
      done: null,
    };
    return m[c.state];
  }

  /** a11y labels (P1) */
  cardAriaLabel(c: MapCard): string {
    const state = this.pill(c) ?? c.state;
    return `${c.title} · ${c.ref} · ${c.app} · ${state}`;
  }

  ringAriaLabel(col: MapColumn): string {
    const color = this.hotColor(col);
    const worstState = color === 'var(--red)'
      ? 'has stalled items'
      : color === 'var(--amber)'
      ? 'has items awaiting approval'
      : color === 'var(--a500)'
      ? 'has running items'
      : color === 'var(--green)'
      ? 'all done'
      : 'idle';
    return `${col.label}: ${this.count(col)} items, ${worstState}`;
  }

  hdAriaLabel(col: MapColumn): string {
    return `${col.label} stage header`;
  }

  stats = computed(() => {
    const cards = this.raw().columns.flatMap((c) => c.cards);
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
