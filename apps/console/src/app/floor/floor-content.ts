import { Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FactoryRequest, Glyph, MissionGate, MissionOut, RunState } from '@sf/shared';

import { FloorActionOutcome } from '../shared/action-outcome';
import { QueueItem, deriveBoard, deriveTallies } from './floor-view';

@Component({
  selector: 'sf-floor-content',
  imports: [RouterLink, Glyph],
  template: `
    @if (mission(); as m) {
      <div class="sr-only" role="status" aria-live="polite">
        {{ queue().length }} decisions waiting. {{ tallies().open }} requests on the line.
      </div>

      <header class="head">
        <h1>Overview</h1>
        <p class="pulse">
          <b class="mono">{{ tallies().open }}</b> on the line
          <span class="sep" aria-hidden="true"></span>
          <b class="mono" [class.hot]="tallies().deciding > 0">{{ tallies().deciding }}</b>
          waiting on your decision
          <span class="sep" aria-hidden="true"></span>
          <b class="mono" [class.bad]="tallies().attention > 0">{{ tallies().attention }}</b>
          need attention
          <span class="sep" aria-hidden="true"></span>
          <b class="mono">{{ tallies().shipped }}</b> shipped this week
          @if (tallies().cycle; as cycle) {
            <span class="sep" aria-hidden="true"></span>
            <span class="quiet-stat"
              >median cycle <b class="mono">{{ cycle }}</b></span
            >
          }
          @if (tallies().gateWait; as wait) {
            <span class="sep" aria-hidden="true"></span>
            <span class="quiet-stat"
              >gates answered in <b class="mono">~{{ wait }}</b></span
            >
          }
        </p>
      </header>

      <section aria-labelledby="queue-title">
        <div class="zone-head">
          <h2 id="queue-title">Waiting on you</h2>
          @if (queue().length > 0) {
            <span class="zcount mono">{{ queue().length }}</span>
          }
        </div>
        @if (queue().length === 0 && activeFilter() === 'all') {
          <p class="all-clear">
            Nothing is waiting on you — the line runs itself until the next gate.
          </p>
        }
        @if (appOptions().length > 0) {
          <nav class="q-filters" aria-label="Filter the queue by app">
            <button
              type="button"
              [class.on]="activeFilter() === 'all'"
              [attr.aria-pressed]="activeFilter() === 'all'"
              (click)="filterChanged.emit('all')"
            >
              All
            </button>
            @for (option of appOptions(); track option.key) {
              <button
                type="button"
                [class.on]="activeFilter() === option.key"
                [attr.aria-pressed]="activeFilter() === option.key"
                (click)="filterChanged.emit(option.key)"
              >
                {{ option.label }} <span class="mono">{{ option.count }}</span>
              </button>
            }
          </nav>
        }
        @for (item of queue(); track item.request.id) {
          <article
            class="q-row"
            [class.is-gate]="item.kind === 'gate'"
            [class.is-stalled]="item.kind === 'stalled'"
            [class.is-owned]="item.kind === 'owned'"
            tabindex="0"
            [attr.aria-label]="item.request.title + ', ' + chipText(item.kind, item.headline)"
          >
            <span class="q-chip">{{ chipText(item.kind, item.headline) }}</span>
            <div class="q-main">
              <div class="q-title">
                <a [routerLink]="['/requests', item.request.id]">{{ item.request.title }}</a>
                <span class="q-meta mono"
                  >{{ item.request.ref }} · {{ item.request.app_name }}</span
                >
                @if (item.age) {
                  <span
                    class="q-age mono"
                    [class.aged]="item.aged"
                    [title]="'waiting since ' + (item.request.stage_entered_at ?? '')"
                    >waiting {{ item.age }}</span
                  >
                }
              </div>
              @if (item.kind === 'gate') {
                <p class="q-facts mono">
                  @for (fact of item.facts; track fact.text) {
                    <span [class]="fact.tone">{{ fact.text }}</span>
                  }
                </p>
              } @else if (item.kind === 'stalled') {
                <p class="q-why">
                  {{
                    item.request.needs_human_reason ||
                      item.request.last_event ||
                      'No signal recorded'
                  }}
                </p>
              } @else {
                <p class="q-why">{{ item.owner }} is finishing this by hand in the PR.</p>
              }
              @if (actionOutcomes()[item.request.id]; as outcome) {
                <p
                  class="action-outcome"
                  [class.conflict]="outcome.kind === 'conflict'"
                  role="status"
                >
                  {{ outcome.message }}
                </p>
              }
            </div>
            <div class="q-actions">
              @if (item.kind === 'gate') {
                <button class="act primary" type="button" (click)="approved.emit(asGate(item))">
                  Approve <kbd>A</kbd>
                </button>
                <button class="act" type="button" (click)="sentBack.emit(asGate(item))">
                  Send back <kbd>S</kbd>
                </button>
                @if (item.request.repo) {
                  <a
                    class="act link"
                    [href]="'https://github.com/' + item.request.repo"
                    target="_blank"
                    rel="noopener"
                    >Repo ↗</a
                  >
                }
              } @else if (item.kind === 'stalled') {
                <button
                  class="act primary"
                  type="button"
                  (click)="retryRequested.emit(item.request)"
                >
                  Retry stage
                </button>
                <button
                  class="act"
                  type="button"
                  (click)="sendBackToStageRequested.emit(item.request)"
                >
                  Send back to…
                </button>
                <button class="act" type="button" (click)="takeOverRequested.emit(item.request)">
                  Take over
                </button>
                <button class="act danger" type="button" (click)="cancelled.emit(item.request)">
                  Cancel
                </button>
              } @else {
                <a class="act link" [routerLink]="['/requests', item.request.id]">Open dossier</a>
                <button class="act danger" type="button" (click)="cancelled.emit(item.request)">
                  Cancel
                </button>
              }
            </div>
          </article>
        }
      </section>

      <section aria-labelledby="board-title">
        <div class="zone-head">
          <h2 id="board-title">The line</h2>
          <p class="zone-note">Every request, intake to deploy. Marked stages open by approval.</p>
        </div>
        <div class="board scroll-x">
          @for (col of board(); track col.key) {
            <section
              class="col"
              [class.gated]="col.gate !== null"
              [attr.aria-label]="col.label + ', ' + col.count + ' requests'"
            >
              <header class="col-head">
                <div class="col-name">
                  <h3>{{ col.label }}</h3>
                  <span class="ccount mono">{{ col.count }}</span>
                </div>
                @if (col.gate) {
                  <p class="gatecap"><i aria-hidden="true">◆</i> opens by {{ col.gate }}</p>
                } @else {
                  <p class="col-sub">{{ col.sub }}</p>
                }
              </header>
              @for (card of col.cards; track card.id) {
                <a
                  class="bcard"
                  [class]="'tone-' + card.tone"
                  [routerLink]="['/requests', card.id]"
                >
                  <div class="b-top mono">
                    <span>{{ card.ref }}</span>
                    @if (card.age) {
                      <span class="b-age" [title]="'time in stage'">{{ card.age }}</span>
                    }
                  </div>
                  <h4>{{ card.title }}</h4>
                  <p class="b-app">{{ card.app }}</p>
                  <p class="b-state">
                    @if (card.tone === 'gate') {
                      <i class="b-diamond" aria-hidden="true">◆</i>
                    } @else if (card.glyph) {
                      <sf-glyph [type]="card.glyph" [size]="13" [fill]="card.progress ?? 0.4" />
                    }
                    <span>{{ card.state }}</span>
                  </p>
                  @if (card.progress !== null) {
                    <span class="b-rail" aria-hidden="true"
                      ><span class="b-fill" [style.width.%]="card.progress * 100"></span
                    ></span>
                  }
                </a>
              } @empty {
                <p class="b-none">None right now</p>
              }
            </section>
          }
        </div>
        @if (tallies().open === 0) {
          <p class="line-empty">
            The line is resting.
            <a [href]="intakeUrl()">Invite the next request through Intake →</a>
          </p>
        }
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
      padding-bottom: 72px;
    }

    /* ── header: one quiet pulse line, no stat tiles ── */
    .head {
      padding: 34px 0 0;
    }
    h1 {
      font-size: 23px;
      letter-spacing: -0.015em;
    }
    .pulse {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 6px 10px;
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 13.5px;
    }
    .pulse b {
      color: var(--fg1);
      font-size: 14px;
      font-weight: 600;
    }
    .pulse b.hot {
      color: var(--amber-tx);
    }
    .pulse b.bad {
      color: var(--red-tx);
    }
    .sep {
      width: 3px;
      height: 3px;
      border-radius: 50%;
      background: var(--border-strong);
      align-self: center;
    }

    /* ── zone headers ── */
    .zone-head {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin: 36px 0 12px;
      padding-bottom: 9px;
      border-bottom: 1px solid var(--hairline);
    }
    h2 {
      font-size: 15px;
      font-weight: 600;
    }
    .zcount {
      min-width: 20px;
      padding: 1px 7px;
      color: var(--amber-tx);
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
      border-radius: var(--r-pill);
      font-size: 11.5px;
      font-weight: 600;
      text-align: center;
    }
    .zone-note {
      margin: 0 0 0 auto;
      color: var(--faint);
      font-size: 12px;
    }
    .quiet-stat {
      color: var(--faint);
    }
    .quiet-stat b {
      color: var(--fg2);
      font-weight: 600;
    }
    .q-filters {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0 0 10px;
    }
    .q-filters button {
      padding: 4px 11px;
      color: var(--muted);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-pill);
      font: 600 12px var(--body);
      cursor: pointer;
    }
    .q-filters button:hover {
      color: var(--fg1);
      border-color: var(--border-strong);
    }
    .q-filters button.on {
      color: var(--fg1);
      background: var(--surface-2);
      border-color: var(--border-strong);
    }
    .q-filters .mono {
      color: var(--faint);
      font-size: 10.5px;
    }
    .q-age {
      color: var(--faint);
      font-size: 11px;
    }
    .q-age.aged {
      color: var(--amber-tx);
      font-weight: 600;
    }
    .all-clear {
      margin: 0;
      padding: 11px 14px;
      color: var(--green-tx);
      background: var(--green-bg);
      border: 1px solid var(--green-line);
      border-radius: var(--r);
      font-size: 13px;
    }

    /* ── the decision queue: dense rows, loud only at the chip ── */
    .q-row {
      display: grid;
      grid-template-columns: 132px minmax(0, 1fr) auto;
      gap: 6px 16px;
      align-items: start;
      padding: 13px 16px;
      margin-bottom: 8px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      outline: none;
    }
    .q-row.is-gate {
      border-color: var(--amber-line);
    }
    .q-row.is-stalled {
      border-color: var(--red-line);
    }
    .q-row:focus-visible {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-tint-bd);
    }
    .q-chip {
      justify-self: start;
      margin-top: 1px;
      padding: 3px 10px;
      border-radius: var(--r);
      font-size: 11.5px;
      font-weight: 700;
      white-space: nowrap;
    }
    .is-gate .q-chip {
      color: var(--amber-tx);
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
    }
    .is-stalled .q-chip {
      color: var(--red-tx);
      background: var(--red-bg);
      border: 1px solid var(--red-line);
    }
    .is-owned .q-chip {
      color: var(--accent-tx);
      background: var(--accent-tint);
      border: 1px solid var(--accent-tint-bd);
    }
    .q-title {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 4px 10px;
    }
    .q-title a {
      color: var(--fg1);
      font-size: 14.5px;
      font-weight: 600;
      text-decoration: none;
    }
    .q-title a:hover {
      color: var(--accent-link);
    }
    .q-meta {
      color: var(--faint);
      font-size: 11.5px;
    }
    .q-facts {
      display: flex;
      flex-wrap: wrap;
      gap: 3px 14px;
      margin: 5px 0 0;
      color: var(--muted);
      font-size: 11.5px;
    }
    .q-facts .green {
      color: var(--green-tx);
    }
    .q-facts .red {
      color: var(--red-tx);
    }
    .q-facts .purple {
      color: var(--accent-tx);
    }
    .q-why {
      margin: 4px 0 0;
      color: var(--fg2);
      font-size: 12.5px;
    }
    .q-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }
    .act {
      padding: 6px 12px;
      color: var(--fg1);
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--r);
      font: 600 12.5px var(--body);
      text-decoration: none;
      cursor: pointer;
      transition: background var(--dur) var(--ease);
    }
    .act:hover {
      background: var(--surface-2);
    }
    .act.primary {
      color: #fff;
      background: var(--accent);
      border-color: var(--accent);
    }
    .act.primary:hover {
      background: var(--accent-hover);
    }
    .act.danger {
      color: var(--red-tx);
      border-color: var(--red-line);
    }
    .act.link {
      border-color: transparent;
      color: var(--accent-link);
    }
    .act kbd {
      margin-left: 4px;
      padding: 0 4px;
      border: 1px solid currentColor;
      border-radius: var(--r-sm);
      font: 500 9.5px var(--mono);
      opacity: 0.75;
    }
    .action-outcome {
      margin: 8px 0 0;
      padding: 7px 11px;
      color: var(--muted);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--r);
      font-size: 12px;
    }
    .action-outcome.conflict {
      color: var(--amber-tx);
      background: var(--amber-bg);
      border-color: var(--amber-line);
    }

    /* ── the board: five columns, approval boundaries drawn on ── */
    .board {
      display: grid;
      grid-template-columns: repeat(5, minmax(206px, 1fr));
      gap: 0 18px;
      overflow-x: auto;
      padding-bottom: 8px;
    }
    .col {
      min-width: 0;
      padding-top: 2px;
    }
    .col.gated {
      padding-left: 17px;
      border-left: 1px dashed var(--amber-line);
    }
    .col-head {
      margin-bottom: 10px;
    }
    .col-name {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .col-name h3 {
      font-size: 13px;
      font-weight: 600;
    }
    .ccount {
      color: var(--muted);
      font-size: 11px;
    }
    .col-sub,
    .gatecap {
      margin: 3px 0 0;
      font-size: 11px;
      color: var(--faint);
    }
    .gatecap {
      color: var(--amber-tx);
      font-weight: 600;
    }
    .gatecap i {
      font-size: 9px;
      font-style: normal;
      margin-right: 2px;
    }

    .bcard {
      display: block;
      padding: 10px 12px 11px;
      margin-bottom: 8px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      text-decoration: none;
      transition:
        border-color var(--dur) var(--ease),
        box-shadow var(--dur) var(--ease);
    }
    .bcard:hover {
      border-color: var(--border-strong);
      box-shadow: var(--shadow-pop);
    }
    .bcard:focus-visible {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-tint-bd);
    }
    .b-top {
      display: flex;
      justify-content: space-between;
      color: var(--faint);
      font-size: 10.5px;
    }
    .bcard h4 {
      margin: 3px 0 0;
      color: var(--fg1);
      font-size: 13px;
      font-weight: 600;
      line-height: 1.32;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .b-app {
      margin: 3px 0 0;
      color: var(--muted);
      font-size: 11.5px;
    }
    .b-state {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 11.5px;
      line-height: 1.35;
    }
    .b-state span {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .b-diamond {
      font-size: 10px;
      font-style: normal;
    }
    .tone-run .b-state {
      color: var(--fg2);
    }
    .tone-run .b-state sf-glyph {
      color: var(--accent);
    }
    .tone-gate .b-state {
      color: var(--amber-tx);
      font-weight: 600;
    }
    .tone-human .b-state {
      color: var(--red-tx);
      font-weight: 600;
    }
    .tone-human {
      border-color: var(--red-line);
    }
    .tone-owned .b-state {
      color: var(--accent-tx);
    }
    .tone-done .b-state {
      color: var(--green-tx);
    }
    .tone-done,
    .tone-draft {
      background: transparent;
    }
    .tone-draft .b-state {
      color: var(--faint);
    }
    .b-rail {
      display: block;
      height: 3px;
      margin-top: 8px;
      background: var(--surface-3);
      border-radius: var(--r-pill);
      overflow: hidden;
    }
    .b-fill {
      display: block;
      height: 100%;
      background: var(--accent);
      border-radius: var(--r-pill);
    }
    .b-none {
      margin: 4px 0 0;
      padding: 14px 0;
      color: var(--faint);
      border: 1px dashed var(--border);
      border-radius: var(--r-lg);
      font-size: 12px;
      text-align: center;
    }
    .line-empty {
      margin: 14px 0 0;
      color: var(--muted);
      font-size: 13.5px;
    }
    .line-empty a {
      color: var(--accent-link);
    }

    @media (max-width: 1080px) {
      .board {
        grid-template-columns: repeat(5, 224px);
      }
    }
    @media (max-width: 720px) {
      .q-row {
        grid-template-columns: 1fr;
      }
      .q-actions {
        justify-content: flex-start;
      }
      .head {
        padding-top: 26px;
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
  intakeUrl = input('http://localhost:4201/submit/new');
  actionOutcomes = input<Record<number, FloorActionOutcome>>({});
  approved = output<MissionGate>();
  sentBack = output<MissionGate>();
  retryRequested = output<FactoryRequest>();
  sendBackToStageRequested = output<FactoryRequest>();
  takeOverRequested = output<FactoryRequest>();
  cancelled = output<FactoryRequest>();

  /** The visible queue — derived and filtered by the page so keyboard order matches. */
  queue = input.required<QueueItem[]>();
  appOptions = input<{ key: string; label: string; count: number }[]>([]);
  activeFilter = input('all');
  filterChanged = output<string>();
  board = computed(() => {
    const runs = new Map<number, RunState>(
      this.mission().runs.map((run) => [run.request.id, run.run]),
    );
    return deriveBoard(this.requests(), runs);
  });
  tallies = computed(() => deriveTallies(this.mission(), this.requests()));

  chipText(kind: 'gate' | 'stalled' | 'owned', headline: string | null) {
    if (kind === 'gate') return headline ?? 'Approve';
    return kind === 'stalled' ? 'Needs human' : 'Human-owned';
  }
  /** The modals still speak MissionGate; rebuild it from the queue item. */
  asGate(item: { request: FactoryRequest; evidence: MissionGate['evidence'] }): MissionGate {
    return { request: item.request, evidence: item.evidence };
  }
}
