import { Component, computed, input, output } from '@angular/core';
import { FactoryRequest, GlyphField, MissionOut, RunState } from '@sf/shared';

import { FloorActionOutcome } from '../shared/action-outcome';
import { DISPLAY_STAGES, OverviewRow, RowKind, deriveOverview, deriveTallies } from './floor-view';

/* The Overview — "A6 / Distribution" (mockups/overview-futuristic, wave 3).
   Three bands: a headline that states what needs a person, five figures each
   carrying how long its group has been sitting, then the five-stage rail under a
   named section heading. The ignition glyph field from the intake hero sits
   behind it so the two faces read as one product.

   The separation between the figures and the rail is deliberate and was chosen
   from five studies: a named heading plus a deep gap. Both halves are five-wide
   rows, so without the heading the eye reads them as one grid and lines
   "Awaiting your review" up under "Spec", which means nothing. */

/** Age buckets, newest → oldest, for the distribution under each figure. */
const BUCKETS = 6;

interface Figure {
  n: number;
  label: string;
  tone: string;
  fill: string;
  rows: OverviewRow[];
}

@Component({
  selector: 'sf-overview-content',
  imports: [GlyphField],
  template: `
    @if (mission(); as m) {
      <sf-glyph-field [intensity]="0.2" [origin]="1.4" />

      <div class="sr-only" role="status" aria-live="polite">
        {{ tallies().deciding }} requests need review. {{ tallies().attention }} have errors.
      </div>

      <div class="body">
        <header class="head">
          <p class="kick">Pipeline status</p>
          <h1>{{ headline() }}</h1>
          <p class="lede">
            Figures below show time in current stage, from newest through {{ oldestWeeks() }}
            {{ oldestWeeks() === 1 ? 'week' : 'weeks' }}.
          </p>
        </header>

        <div class="figures" role="group" aria-label="Factory health">
          @for (f of figures(); track f.label) {
            <div class="fig">
              <div class="n mono" [style.color]="f.tone">{{ f.n }}</div>
              <div class="l">{{ f.label }}</div>
              <div class="dist" [style.--fill]="f.fill" [style.--line]="f.tone">
                <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
                  <path class="ar" [attr.d]="area(f.rows)"></path>
                  <line class="base" x1="0" y1="30" x2="100" y2="30"></line>
                  <polyline class="ln" [attr.points]="points(f.rows)"></polyline>
                  @if (f.rows.length) {
                    <circle
                      class="pk"
                      [attr.cx]="peakX(f.rows)"
                      [attr.cy]="peakY(f.rows)"
                      r="1.6"
                    />
                  }
                </svg>
              </div>
              <div class="hl mono">Fresh → {{ oldestWeeks() }}w</div>
            </div>
          }
        </div>

        @for (outcome of outcomeList(); track outcome.id) {
          <p class="action-outcome" [class.conflict]="outcome.kind === 'conflict'" role="status">
            {{ outcome.message }}
          </p>
        }

        <h2 class="sechead">The line, stage by stage</h2>

        <div class="rail">
          @for (stage of stages; track stage.key; let i = $index) {
            <section class="st" [class.quiet]="lanes()[i].length === 0">
              <div class="mix" [title]="mixTitle(lanes()[i])">
                @for (seg of mix(lanes()[i]); track seg.kind) {
                  <i [style.flex]="seg.n" [style.background]="dot(seg.kind)"></i>
                }
                @if (lanes()[i].length === 0) {
                  <i style="flex:1" class="empty"></i>
                }
              </div>
              <div class="h">
                <b class="mono">{{ lanes()[i].length }}</b>
                <span>{{ stage.label }}</span>
              </div>
              @if (lanes()[i].length === 0) {
                <p class="standby mono">Standby</p>
              }
              <ul>
                @for (row of lanes()[i].slice(0, 6); track row.id) {
                  <li [style.--dot]="dot(row.kind)">
                    <button
                      type="button"
                      [attr.aria-label]="row.title + ', ' + word(row.kind) + '. Open request.'"
                      (click)="opened.emit(row)"
                    >
                      <span class="t">{{ row.title }}</span>
                      <span class="w mono">{{ word(row.kind) }}</span>
                    </button>
                  </li>
                }
              </ul>
              @if (lanes()[i].length > 6) {
                <p class="more mono">+{{ lanes()[i].length - 6 }} more</p>
              }
            </section>
          }
        </div>
      </div>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: block;
      padding-bottom: 90px;
    }
    /* The field belongs behind the headline and figures, not behind the stage
       rail — glyphs under a dense list fight the data. Confine it to the top
       band and fade it out before the rail starts. */
    sf-glyph-field {
      height: 470px;
      -webkit-mask-image: linear-gradient(#000 22%, transparent 92%);
      mask-image: linear-gradient(#000 22%, transparent 92%);
    }
    .body {
      position: relative;
      z-index: 1;
    }

    .head {
      padding: 44px 0 0;
    }
    .kick {
      margin: 0;
      color: var(--accent-tx);
      font: 500 11px var(--mono);
      letter-spacing: 0.24em;
      text-transform: uppercase;
    }
    h1 {
      margin: 10px 0 0;
      max-width: 20ch;
      font-size: clamp(30px, 3.6vw, 45px);
      font-weight: 800;
      line-height: 1.02;
      letter-spacing: -0.022em;
      text-wrap: balance;
    }
    .lede {
      max-width: 54ch;
      margin: 12px 0 0;
      color: var(--muted);
      font-size: 14px;
      font-weight: 300;
      line-height: 1.55;
    }

    /* Five figures, unboxed — they sit on the page and the gap separates them.
       A box here fought the glyph field behind it. */
    .figures {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 0 30px;
      margin-top: 34px;
    }
    .fig {
      min-width: 0;
    }
    .fig .n {
      font-size: 34px;
      font-weight: 700;
      line-height: 1;
      letter-spacing: -0.03em;
      font-variant-numeric: tabular-nums;
    }
    .fig .l {
      margin-top: 7px;
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    /* Area + line over the age buckets. Straight segments, not a spline: six
       discrete bins, and a curve would invent shape between them. */
    .dist {
      height: 38px;
      margin-top: 14px;
    }
    .dist svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    .dist .ar {
      fill: var(--fill);
      opacity: 0.2;
    }
    .dist .ln {
      fill: none;
      stroke: var(--line);
      stroke-width: 1.5;
      vector-effect: non-scaling-stroke;
      stroke-linejoin: round;
      stroke-linecap: round;
    }
    .dist .base {
      stroke: var(--hairline);
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
    }
    .dist .pk {
      fill: var(--line);
    }
    .hl {
      margin-top: 6px;
      color: var(--faint);
      font-size: 9.5px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    /* The named heading is what separates the two halves — a gap alone let the
       five figures and the five stages read as one grid. */
    .sechead {
      margin: 92px 0 0;
      font-size: 25px;
      font-weight: 700;
      letter-spacing: -0.015em;
    }

    .rail {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 14px;
      margin-top: 26px;
    }
    .st {
      min-width: 0;
    }
    /* the status-mix bar is the rule above each stage — one element dividing and
       encoding at once, rather than a rule plus a chart */
    .mix {
      display: flex;
      gap: 2px;
      height: 3px;
      margin-bottom: 12px;
    }
    .mix i {
      min-width: 3px;
    }
    .mix i.empty {
      background: var(--track);
    }
    .h {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .h b {
      font-size: 19px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .h span {
      color: var(--muted);
      font: 400 11px var(--mono);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .standby {
      margin: 9px 0 0;
      color: var(--faint);
      font-size: 9px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    ul {
      display: flex;
      flex-direction: column;
      gap: 7px;
      margin: 11px 0 0;
      padding: 0;
      list-style: none;
    }
    li button {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: baseline;
      width: 100%;
      margin: 0 -6px;
      padding: 3px 6px;
      width: calc(100% + 12px);
      background: transparent;
      border: 0;
      border-radius: var(--r-sm);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    li button:hover {
      background: var(--surface-2);
    }
    li button:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--accent-tint-bd);
    }
    li .t {
      position: relative;
      min-width: 0;
      padding-left: 11px;
      color: var(--fg2);
      font-size: 11px;
      line-height: 1.4;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    li .t::before {
      content: '';
      position: absolute;
      left: 0;
      top: 5px;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--dot);
    }
    /* the word, not just the dot — status must survive greyscale */
    li .w {
      color: var(--dot);
      font-size: 9px;
      font-weight: 500;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .more {
      margin: 8px 0 0;
      color: var(--faint);
      font-size: 9.5px;
      letter-spacing: 0.08em;
    }

    .action-outcome {
      margin: 26px 0 0;
      padding: 8px 12px;
      color: var(--muted);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--r);
      font-size: 12.5px;
    }
    .action-outcome.conflict {
      color: var(--amber-tx);
      background: var(--amber-bg);
      border-color: var(--amber-line);
    }

    @media (max-width: 1000px) {
      .figures {
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 26px 24px;
      }
      .rail {
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 26px 14px;
      }
      .sechead {
        margin-top: 60px;
      }
    }
    @media (max-width: 620px) {
      .figures,
      .rail {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  `,
})
export class OverviewContent {
  mission = input.required<MissionOut>();
  requests = input.required<FactoryRequest[]>();
  actionOutcomes = input<Record<number, FloorActionOutcome>>({});
  /** a request the operator clicked — the page opens the sheet */
  opened = output<OverviewRow>();

  stages = DISPLAY_STAGES;

  private overview = computed(() => {
    const runs = new Map<number, RunState>(
      this.mission().runs.map((run) => [run.request.id, run.run]),
    );
    return deriveOverview(this.requests(), runs);
  });
  tallies = computed(() => deriveTallies(this.mission(), this.requests()));
  outcomeList = computed(() =>
    Object.entries(this.actionOutcomes()).map(([id, outcome]) => ({ id: Number(id), ...outcome })),
  );

  /** Every live row plus the recently shipped, so the Deploy lane can hold both
   *  work in flight and what just left it — shipped is a status, not a stage. */
  private all = computed(() => [...this.overview().rows, ...this.overview().shipped]);

  lanes = computed(() => {
    const lanes = DISPLAY_STAGES.map(() => [] as OverviewRow[]);
    for (const row of this.all())
      lanes[Math.min(row.stageIndex, DISPLAY_STAGES.length - 1)].push(row);
    for (const lane of lanes) lane.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.weeks - a.weeks);
    return lanes;
  });

  private gates = computed(() => this.all().filter((r) => r.kind === 'gate'));
  private errors = computed(() => this.all().filter((r) => r.kind === 'stuck'));
  private working = computed(() => this.all().filter((r) => r.kind === 'active'));
  private open = computed(() => this.all().filter((r) => r.kind !== 'done'));
  private shipped = computed(() => this.all().filter((r) => r.kind === 'done'));

  /** Longest wait on the board, in whole weeks — the x-axis every distribution
   *  shares, so the five are directly comparable. */
  private maxWeeks = computed(() => Math.max(...this.all().map((r) => r.weeks), 1 / 7));
  oldestWeeks = computed(() => Math.max(Math.round(this.maxWeeks()), 1));

  /** Both counts a person has to act on, assembled clause by clause: each can be
   *  0, 1 or many, and a derived headline must never read "0 have errors". */
  headline = computed(() => {
    const g = this.gates().length;
    const e = this.errors().length;
    const gc = `${g} ${g === 1 ? 'request needs' : 'requests need'} review`;
    const ec = `${e} ${e === 1 ? 'has an error' : 'have errors'}`;
    const alone = `${e} ${e === 1 ? 'request has an error' : 'requests have errors'}`;
    if (g && e) return `${gc}, ${ec}.`;
    if (g) return `${gc}.`;
    if (e) return `${alone}.`;
    return 'Nothing is waiting on you.';
  });

  figures = computed<Figure[]>(() => [
    {
      n: this.gates().length,
      label: 'Awaiting your review',
      tone: 'var(--amber)',
      fill: 'var(--amber)',
      rows: this.gates(),
    },
    {
      n: this.errors().length,
      label: 'Error',
      tone: 'var(--red)',
      fill: 'var(--red)',
      rows: this.errors(),
    },
    {
      n: this.working().length,
      label: 'Being built',
      tone: 'var(--cyan)',
      fill: 'var(--cyan)',
      rows: this.working(),
    },
    {
      n: this.open().length,
      label: 'Open requests',
      tone: 'var(--fg1)',
      fill: 'var(--muted)',
      rows: this.open(),
    },
    {
      n: this.shipped().length,
      label: 'Shipped this week',
      tone: 'var(--fg1)',
      fill: 'var(--green)',
      rows: this.shipped(),
    },
  ]);

  mix(rows: OverviewRow[]) {
    const kinds = [...new Set(rows.map((r) => r.kind))].sort((a, b) => RANK[a] - RANK[b]);
    return kinds.map((kind) => ({ kind, n: rows.filter((r) => r.kind === kind).length }));
  }
  mixTitle(rows: OverviewRow[]) {
    return this.mix(rows)
      .map((m) => `${m.n} ${WORD[m.kind]}`)
      .join(' · ');
  }
  dot = (kind: RowKind) => DOT[kind];
  word = (kind: RowKind) => WORD[kind];

  /* ── the distribution ── real age buckets, never an invented trend ── */
  private bins(rows: OverviewRow[]): number[] {
    const b = new Array(BUCKETS).fill(0);
    const max = this.maxWeeks();
    for (const r of rows) b[Math.min(Math.floor((r.weeks / max) * BUCKETS), BUCKETS - 1)] += 1;
    return b;
  }
  private xy(rows: OverviewRow[]) {
    const b = this.bins(rows);
    const peak = Math.max(...b, 1);
    return b.map((v, i) => ({
      x: +((i / (BUCKETS - 1)) * 100).toFixed(2),
      y: +(30 - 2 - (v / peak) * (30 - 2)).toFixed(2),
      v,
    }));
  }
  points(rows: OverviewRow[]) {
    return this.xy(rows)
      .map((p) => `${p.x},${p.y}`)
      .join(' ');
  }
  area(rows: OverviewRow[]) {
    return `M0,30 L${this.xy(rows)
      .map((p) => `${p.x},${p.y}`)
      .join(' L')} L100,30 Z`;
  }
  peakX(rows: OverviewRow[]) {
    const pts = this.xy(rows);
    return pts[pts.indexOf(pts.reduce((a, b) => (b.v > a.v ? b : a)))].x;
  }
  peakY(rows: OverviewRow[]) {
    const pts = this.xy(rows);
    return pts[pts.indexOf(pts.reduce((a, b) => (b.v > a.v ? b : a)))].y;
  }
}

/* Urgency order, so a truncated lane still surfaces its rarest status rather
   than the first six of whatever dominates. */
const RANK: Record<RowKind, number> = {
  stuck: 0,
  gate: 1,
  owned: 2,
  wait: 3,
  active: 4,
  draft: 5,
  done: 6,
};
const WORD: Record<RowKind, string> = {
  stuck: 'error',
  gate: 'gate',
  owned: 'human',
  wait: 'submitter',
  active: 'working',
  draft: 'draft',
  done: 'shipped',
};
const DOT: Record<RowKind, string> = {
  stuck: 'var(--red)',
  gate: 'var(--amber)',
  owned: 'var(--accent)',
  wait: 'var(--fill-wait)',
  active: 'var(--cyan)',
  draft: 'var(--fill-wait)',
  done: 'var(--green)',
};
