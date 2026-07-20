import { Component, computed, input, output } from '@angular/core';
import { FactoryRequest, MissionOut, RunState } from '@sf/shared';

import { FloorActionOutcome } from '../shared/action-outcome';
import { OverviewView, RowAction, deriveOverview, deriveTallies } from './floor-view';
import { BoardView } from './board-view';
import { ProgressView } from './progress-view';
import { ListView } from './list-view';

/* The Overview shell: the title with its four context gauges, the one loud row
   of counts a human must act on, a List | Board | Progress switcher, and
   whichever view is active. The three view bodies are separate standalone
   components; this container derives the shared model once and routes inline
   actions up to the page (which owns the confirm modals + api calls). */

@Component({
  selector: 'sf-floor-content',
  imports: [ListView, BoardView, ProgressView],
  template: `
    @if (mission(); as m) {
      <div class="sr-only" role="status" aria-live="polite">
        {{ tallies().deciding }} decisions waiting. {{ tallies().open }} requests on the line.
      </div>

      <!-- Title, then the four context gauges as one quiet line. These are
           background numbers: nobody acts on them, so they get no cards. -->
      <header class="head">
        <h1>Overview</h1>
        <div class="ctx" role="group" aria-label="Factory health">
          <span>
            <b>{{ tallies().open }}</b> on the line
          </span>
          <span class="sep" aria-hidden="true">·</span>
          <span>
            <b>{{ tallies().shipped }}</b> shipped this week
          </span>
          <span class="sep" aria-hidden="true">·</span>
          <span>
            <b>{{ tallies().cycle ?? '—' }}</b> median cycle
          </span>
          <span class="sep" aria-hidden="true">·</span>
          <span>
            <b>{{ tallies().gateWait ? '~' + tallies().gateWait : '—' }}</b> gate response
          </span>
        </div>
      </header>

      <!-- The only loud row on the page: the two counts a human can act on.
           Each jumps to List, which already sorts stuck and gates to the top. -->
      <div class="needs">
        @if (tallies().deciding > 0) {
          <button type="button" class="need hot" (click)="viewChange.emit('list')">
            <i aria-hidden="true"></i>
            <b>{{ tallies().deciding }}</b> waiting on your decision
            <span class="go" aria-hidden="true">→</span>
          </button>
        }
        @if (tallies().attention > 0) {
          <button type="button" class="need bad" (click)="viewChange.emit('list')">
            <i aria-hidden="true"></i>
            <b>{{ tallies().attention }}</b> stuck, needs a human
            <span class="go" aria-hidden="true">→</span>
          </button>
        }
        @if (tallies().deciding === 0 && tallies().attention === 0) {
          <p class="need-none">Nothing waiting on you. The line is running itself.</p>
        }
      </div>

      <!-- view switcher -->
      <div class="switcher">
        <div class="seg" role="tablist" aria-label="Overview views">
          @for (option of views; track option.id) {
            <button
              type="button"
              role="tab"
              [class.on]="view() === option.id"
              [attr.aria-selected]="view() === option.id"
              (click)="viewChange.emit(option.id)"
            >
              {{ option.label }}
            </button>
          }
        </div>
        <span class="vhint mono" aria-hidden="true">← / → to switch view</span>
      </div>

      @for (outcome of outcomeList(); track outcome.id) {
        <p class="action-outcome" [class.conflict]="outcome.kind === 'conflict'" role="status">
          {{ outcome.message }}
        </p>
      }

      <div class="stage">
        <!-- @default is Progress because Progress is the default view: an
             unrecognised ?view= lands where a bare /floor would. -->
        @switch (view()) {
          @case ('list') {
            <sf-list-view [rows]="overview().rows" [shipped]="overview().shipped" />
          }
          @case ('board') {
            <sf-board-view [rows]="overview().rows" (act)="act.emit($event)" />
          }
          @default {
            <sf-progress-view [rows]="overview().rows" (act)="act.emit($event)" />
          }
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      padding-bottom: 72px;
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 16px 24px;
      padding: 30px 0 0;
    }
    h1 {
      font-size: 20px;
      letter-spacing: -0.015em;
    }

    /* ── context gauges: one quiet line, no cards ── */
    .ctx {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 4px 20px;
      margin-left: auto;
      color: var(--muted);
      font-size: 12.5px;
      font-variant-numeric: tabular-nums;
    }
    .ctx b {
      margin-right: 1px;
      color: var(--fg2);
      font-weight: 600;
    }
    .ctx .sep {
      color: var(--border-strong);
    }

    /* ── the only loud row: what a human must act on ── */
    .needs {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding: 16px 0 0;
    }
    .need {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      padding: 9px 16px 9px 13px;
      color: var(--fg2);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      font: 400 13px var(--body);
      cursor: pointer;
      transition:
        border-color var(--dur) var(--ease),
        background var(--dur) var(--ease);
    }
    .need:hover {
      background: var(--surface-2);
      border-color: var(--border-strong);
    }
    .need i {
      width: 7px;
      height: 7px;
      flex: none;
      border-radius: 50%;
    }
    .need b {
      font-size: 15px;
      font-weight: 650;
      letter-spacing: -0.02em;
      font-variant-numeric: tabular-nums;
    }
    .need .go {
      margin-left: 2px;
      color: var(--faint);
      font-size: 12px;
    }
    .need.hot i {
      background: var(--amber);
    }
    .need.hot b {
      color: var(--amber-tx);
    }
    .need.bad i {
      background: var(--red);
    }
    .need.bad b {
      color: var(--red-tx);
    }
    .need-none {
      margin: 0;
      padding: 9px 0;
      color: var(--muted);
      font-size: 13px;
    }

    /* ── view switcher: underlined tabs, not a boxed control ── */
    .switcher {
      display: flex;
      align-items: center;
      gap: 14px;
      margin: 26px 0 0;
      border-bottom: 1px solid var(--hairline);
    }
    .seg {
      display: inline-flex;
      gap: 26px;
    }
    .seg button {
      margin-bottom: -1px;
      padding: 0 1px 11px;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-bottom: 2px solid transparent;
      font: 500 13px var(--body);
      cursor: pointer;
      transition: color var(--dur) var(--ease);
    }
    .seg button:hover {
      color: var(--fg1);
    }
    /* active tab = an ink underline (never the purple tint) */
    .seg button.on {
      color: var(--fg1);
      font-weight: 600;
      border-bottom-color: var(--fg1);
    }
    .seg button:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--accent-tint-bd);
    }
    .vhint {
      margin-left: auto;
      padding-bottom: 9px;
      color: var(--faint);
      font-size: 11px;
      letter-spacing: 0.02em;
    }

    .action-outcome {
      margin: 16px 0 0;
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

    .stage {
      min-height: 320px;
      padding-top: 4px;
    }

    /* the context line is the first thing to give up room — it is background
       detail, and the title plus the needs-you row must never wrap for it */
    @media (max-width: 820px) {
      .ctx {
        margin-left: 0;
      }
    }
    @media (max-width: 640px) {
      .vhint {
        display: none;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      * {
        transition: none !important;
      }
    }
  `,
})
export class FloorContent {
  mission = input.required<MissionOut>();
  requests = input.required<FactoryRequest[]>();
  view = input<OverviewView>('progress');
  intakeUrl = input('http://localhost:4201/submit/new');
  actionOutcomes = input<Record<number, FloorActionOutcome>>({});
  viewChange = output<OverviewView>();
  act = output<RowAction>();

  views: { id: OverviewView; label: string }[] = [
    { id: 'progress', label: 'Progress' },
    { id: 'list', label: 'List' },
    { id: 'board', label: 'Board' },
  ];

  overview = computed(() => {
    const runs = new Map<number, RunState>(
      this.mission().runs.map((run) => [run.request.id, run.run]),
    );
    return deriveOverview(this.requests(), runs);
  });
  tallies = computed(() => deriveTallies(this.mission(), this.requests()));
  outcomeList = computed(() =>
    Object.entries(this.actionOutcomes()).map(([id, outcome]) => ({ id: Number(id), ...outcome })),
  );
}
