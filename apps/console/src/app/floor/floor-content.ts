import { Component, computed, input, output } from '@angular/core';
import { FactoryRequest, MissionOut, RunState } from '@sf/shared';

import { FloorActionOutcome } from '../shared/action-outcome';
import { OverviewView, RowAction, deriveOverview, deriveTallies } from './floor-view';
import { LineView } from './line-view';
import { ProgressView } from './progress-view';
import { StackView } from './stack-view';

/* The Overview shell: a persistent factory-health band, a Stack | Line | Progress
   switcher, and whichever view is active. The three view bodies are separate
   standalone components; this container derives the shared model once and routes
   inline actions up to the page (which owns the confirm modals + api calls). */

@Component({
  selector: 'sf-floor-content',
  imports: [StackView, LineView, ProgressView],
  template: `
    @if (mission(); as m) {
      <div class="sr-only" role="status" aria-live="polite">
        {{ tallies().deciding }} decisions waiting. {{ tallies().open }} requests on the line.
      </div>

      <header class="head">
        <h1>Overview</h1>
      </header>

      <!-- persistent factory-health band, visible in all three views. The two
           gauges a human can act on run wide; the other four are context. -->
      <div class="band" role="group" aria-label="Factory health">
        <div class="card big" [class.hot]="tallies().deciding > 0">
          <span class="k">Your decision</span>
          <span class="v mono">{{ tallies().deciding }}</span>
          <span class="s">gates waiting on you</span>
        </div>
        <div class="card big" [class.bad]="tallies().attention > 0">
          <span class="k">Need attention</span>
          <span class="v mono">{{ tallies().attention }}</span>
          <span class="s">stuck / needs a human</span>
        </div>
        <div class="card">
          <span class="k">On the line</span>
          <span class="v mono">{{ tallies().open }}</span>
        </div>
        <div class="card">
          <span class="k">Shipped / wk</span>
          <span class="v mono">{{ tallies().shipped }}</span>
        </div>
        <div class="card">
          <span class="k">Median cycle</span>
          <span class="v mono">{{ tallies().cycle ?? '—' }}</span>
        </div>
        <div class="card">
          <span class="k">Gate response</span>
          <span class="v mono">{{ tallies().gateWait ? '~' + tallies().gateWait : '—' }}</span>
        </div>
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
        @switch (view()) {
          @case ('line') {
            <sf-line-view [rows]="overview().rows" (act)="act.emit($event)" />
          }
          @case ('progress') {
            <sf-progress-view [rows]="overview().rows" (act)="act.emit($event)" />
          }
          @default {
            <sf-stack-view [rows]="overview().rows" [shipped]="overview().shipped" />
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
      padding: 30px 0 16px;
    }
    h1 {
      font-size: 23px;
      letter-spacing: -0.015em;
    }

    /* ── persistent health band ── */
    .band {
      display: grid;
      grid-template-columns: 1.6fr 1.6fr repeat(4, minmax(0, 1fr));
      gap: 8px;
      padding: 2px 0 4px;
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
      padding: 10px 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r);
    }
    .card .k {
      color: var(--faint);
      font: 600 8.5px var(--mono);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .card .v {
      color: var(--fg1);
      font-size: 20px;
      font-weight: 640;
      line-height: 1.05;
      letter-spacing: -0.03em;
    }
    .card .s {
      overflow: hidden;
      color: var(--muted);
      font-size: 10px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* the two a human can act on */
    .card.big {
      gap: 4px;
      padding: 12px 14px;
    }
    .card.big .v {
      font-size: 30px;
      font-weight: 650;
      letter-spacing: -0.04em;
    }
    .card.big.hot .v {
      color: var(--amber-tx);
    }
    .card.big.bad .v {
      color: var(--red-tx);
    }
    /* context: label up, number down, nothing shouting */
    .card:not(.big) {
      justify-content: space-between;
    }
    .card:not(.big) .v {
      color: var(--fg2);
      font-size: 16px;
    }

    /* ── view switcher ── */
    .switcher {
      display: flex;
      align-items: center;
      gap: 14px;
      margin: 18px 0 20px;
    }
    .seg {
      display: inline-flex;
      gap: 3px;
      padding: 3px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
    }
    .seg button {
      padding: 6px 18px;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-radius: var(--r);
      font: 600 12.5px var(--body);
      cursor: pointer;
      transition:
        color var(--dur) var(--ease),
        background var(--dur) var(--ease);
    }
    .seg button:hover {
      color: var(--fg1);
    }
    /* active segment = neutral surface (never the purple tint) */
    .seg button.on {
      color: var(--fg1);
      background: var(--surface-2);
      box-shadow: inset 0 0 0 1px var(--border-strong);
    }
    .seg button:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--accent-tint-bd);
    }
    .vhint {
      color: var(--faint);
      font-size: 9px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .action-outcome {
      margin: 0 0 12px;
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
    }

    /* one row is the point — hold six across until the cards genuinely break */
    @media (max-width: 820px) {
      .band {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
    }
    @media (max-width: 640px) {
      .vhint {
        display: none;
      }
    }
    @media (max-width: 560px) {
      .band {
        grid-template-columns: repeat(2, minmax(0, 1fr));
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
  view = input<OverviewView>('stack');
  intakeUrl = input('http://localhost:4201/submit/new');
  actionOutcomes = input<Record<number, FloorActionOutcome>>({});
  viewChange = output<OverviewView>();
  act = output<RowAction>();

  views: { id: OverviewView; label: string }[] = [
    { id: 'stack', label: 'Stack' },
    { id: 'line', label: 'Line' },
    { id: 'progress', label: 'Progress' },
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
