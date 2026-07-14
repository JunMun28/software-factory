import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  FactoryRequest,
  Glyph,
  boardGlyph,
  elapsedShort,
  inFlight,
  plainStage,
  timeAgo,
  utc,
} from '@sf/shared';
import { Subscription } from 'rxjs';

import { Store } from '../core/store.service';
import { ConsoleShell } from '../shell/console-shell';

const STATES = [
  { value: 'all', label: 'All' },
  { value: 'needs-you', label: 'Needs you' },
  { value: 'in-flight', label: 'In flight' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'sent-back', label: 'Sent back' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'human-owned', label: 'Human-owned' },
] as const;

type LibraryState = (typeof STATES)[number]['value'];

interface StatePill {
  label: string;
  glyph: string;
  tone: 'neutral' | 'purple' | 'green' | 'amber' | 'red';
  fill: number;
}

function matchesState(request: FactoryRequest, state: LibraryState): boolean {
  if (state === 'all') return true;
  if (state === 'needs-you') return Boolean(request.gate || request.needs_human);
  if (state === 'in-flight') return inFlight(request);
  if (state === 'shipped') return request.stage === 'done' && request.status === 'done';
  if (state === 'sent-back') return request.status === 'sent_back';
  if (state === 'cancelled') return request.status === 'cancelled';
  return request.status === 'human_owned';
}

@Component({
  selector: 'sf-library-page',
  imports: [ConsoleShell, Glyph, RouterLink],
  template: `
    <sf-console-shell active="library">
      <section class="library" aria-labelledby="library-title">
        <header class="library-head">
          <div>
            <p class="eyebrow">Library · Every request</p>
            <h1 id="library-title">The factory record</h1>
            <p>Past and present work, kept dense enough to scan.</p>
          </div>
          <span class="count">{{ filtered().length }} / {{ requests().length }}</span>
        </header>

        <nav class="filters" aria-label="Filter the Library">
          <div class="filter-group">
            <span>App</span>
            <div class="chips">
              <button
                type="button"
                data-app="all"
                [class.active]="appFilter() === 'all'"
                [attr.aria-pressed]="appFilter() === 'all'"
                (click)="setFilter('app', 'all')"
              >
                All apps
              </button>
              @for (app of apps(); track app.id) {
                <button
                  type="button"
                  [attr.data-app]="app.key"
                  [class.active]="appFilter() === app.key"
                  [attr.aria-pressed]="appFilter() === app.key"
                  (click)="setFilter('app', app.key)"
                >
                  {{ app.name }}
                </button>
              }
            </div>
          </div>
          <div class="filter-group">
            <span>State</span>
            <div class="chips">
              @for (state of states; track state.value) {
                <button
                  type="button"
                  [attr.data-state]="state.value"
                  [class.active]="stateFilter() === state.value"
                  [attr.aria-pressed]="stateFilter() === state.value"
                  (click)="setFilter('state', state.value)"
                >
                  {{ state.label }}
                </button>
              }
            </div>
          </div>
        </nav>

        <div class="row-head" aria-hidden="true">
          <span>State</span><span>Request</span><span>App</span><span>Updated</span
          ><span>Cycle</span>
        </div>
        <div class="rows" role="list" aria-live="polite">
          @for (request of filtered(); track request.id) {
            <a class="library-row" role="listitem" [routerLink]="['/requests', request.id]">
              @let state = statePill(request);
              <span class="pill" [class]="'pill ' + state.tone">
                <sf-glyph
                  [type]="state.glyph"
                  [size]="13"
                  [color]="glyphColor(state.tone)"
                  [fill]="state.fill"
                />
                {{ state.label }}
              </span>
              <span class="request-title">
                <b [class.struck]="request.status === 'cancelled'">{{ request.title }}</b>
                <small>{{ request.ref }}</small>
              </span>
              <span class="app">{{ request.app_name || 'No app yet' }}</span>
              <span class="updated">
                <b>{{ timeAgo(request.updated_at) }}</b>
                <small>requested by {{ request.reporter }}</small>
              </span>
              <span class="cycle">{{ cycleTime(request) }}</span>
            </a>
          } @empty {
            <div class="empty">
              <b>No requests match this view.</b>
              <p>Clear a filter to widen the Library.</p>
            </div>
          }
        </div>
      </section>
    </sf-console-shell>
  `,
  styles: `
    .library {
      padding: 56px 0 88px;
    }
    .library-head {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 24px;
    }
    .eyebrow {
      margin: 0 0 8px;
      color: var(--accent-tx);
      font: 600 12px var(--mono);
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-size: clamp(34px, 5vw, 52px);
    }
    .library-head p:not(.eyebrow) {
      margin: 8px 0 0;
      color: var(--muted);
    }
    .count {
      padding: 5px 9px;
      color: var(--muted);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--r-pill);
      font: 600 11px var(--mono);
    }
    .filters {
      display: grid;
      gap: 13px;
      padding: 18px 0 22px;
      margin-top: 28px;
      border-top: 1px solid var(--hairline);
      border-bottom: 1px solid var(--hairline);
    }
    .filter-group {
      display: grid;
      grid-template-columns: 52px 1fr;
      align-items: start;
      gap: 12px;
    }
    .filter-group > span {
      padding-top: 6px;
      color: var(--muted);
      font: 600 10px var(--mono);
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .chips button {
      padding: 5px 10px;
      color: var(--muted);
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--r-pill);
      font: 600 12px var(--body);
      cursor: pointer;
    }
    .chips button:hover {
      color: var(--fg1);
      background: var(--surface-2);
    }
    .chips button.active {
      color: var(--accent-tx);
      background: var(--accent-tint);
      border-color: var(--accent-tint-bd);
    }
    .row-head,
    .library-row {
      display: grid;
      grid-template-columns: 135px minmax(220px, 1.8fr) minmax(120px, 0.8fr) minmax(150px, 1fr) 76px;
      gap: 16px;
      align-items: center;
    }
    .row-head {
      padding: 18px 14px 8px;
      color: var(--faint);
      font: 600 10px var(--mono);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .library-row {
      min-height: 68px;
      padding: 11px 14px;
      color: var(--fg2);
      border-top: 1px solid var(--hairline);
      text-decoration: none;
    }
    .library-row:last-child {
      border-bottom: 1px solid var(--hairline);
    }
    .library-row:hover {
      background: var(--surface-2);
    }
    .library-row:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .pill {
      justify-self: start;
      font-size: 11.5px;
    }
    .request-title,
    .updated {
      min-width: 0;
    }
    .request-title b,
    .request-title small,
    .updated small {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .request-title b {
      color: var(--fg1);
      font-size: 13.5px;
    }
    .request-title small,
    .updated small {
      margin-top: 3px;
      color: var(--muted);
      font: 500 10.5px var(--mono);
    }
    .struck {
      text-decoration: line-through;
    }
    .app {
      overflow: hidden;
      color: var(--muted);
      font-size: 12.5px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .updated b,
    .cycle {
      font: 600 11.5px var(--mono);
    }
    .cycle {
      color: var(--muted);
      text-align: right;
    }
    .empty {
      padding: 44px 16px;
      color: var(--fg2);
      text-align: center;
      border-bottom: 1px solid var(--hairline);
    }
    .empty p {
      margin: 5px 0 0;
      color: var(--muted);
    }
    @media (max-width: 700px) {
      .library {
        padding-top: 34px;
      }
      .library-head {
        align-items: start;
      }
      .row-head {
        display: none;
      }
      .rows {
        margin-top: 18px;
      }
      .library-row {
        grid-template-columns: 1fr auto;
        gap: 8px 14px;
        padding: 14px 2px;
      }
      .pill {
        grid-column: 1;
      }
      .request-title {
        grid-column: 1 / -1;
        grid-row: 1;
        padding-right: 92px;
      }
      .app {
        grid-column: 1;
      }
      .updated {
        grid-column: 1;
      }
      .cycle {
        grid-column: 2;
        grid-row: 3 / 5;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      * {
        transition: none !important;
      }
    }
  `,
})
export class LibraryPage implements OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private store = inject(Store);
  private querySubscription: Subscription;

  requests = this.store.requests;
  apps = this.store.apps;
  states = STATES;
  appFilter = signal('all');
  stateFilter = signal<LibraryState>('all');
  filtered = computed(() =>
    this.requests().filter(
      (request) =>
        (this.appFilter() === 'all' || request.app_key === this.appFilter()) &&
        matchesState(request, this.stateFilter()),
    ),
  );

  constructor() {
    this.querySubscription = this.route.queryParamMap.subscribe((params) => {
      this.appFilter.set(params.get('app') || 'all');
      const state = params.get('state') || 'all';
      this.stateFilter.set(
        STATES.some((choice) => choice.value === state) ? (state as LibraryState) : 'all',
      );
    });
  }

  setFilter(kind: 'app' | 'state', value: string) {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { [kind]: value === 'all' ? null : value },
      queryParamsHandling: 'merge',
    });
  }

  statePill(request: FactoryRequest): StatePill {
    if (request.needs_human) return { label: 'Needs you', glyph: 'flag', tone: 'red', fill: 0.5 };
    if (request.gate) return { label: 'Needs you', glyph: 'flag', tone: 'amber', fill: 0.5 };
    if (request.status === 'human_owned')
      return { label: 'Human-owned', glyph: 'flag', tone: 'purple', fill: 1 };
    if (request.status === 'sent_back')
      return { label: 'Sent back', glyph: 'flag', tone: 'amber', fill: 0.5 };
    const plain = plainStage(request);
    const glyph = boardGlyph(request);
    const label = request.status === 'done' ? 'Shipped' : plain.label;
    return {
      label,
      glyph: glyph.glyph,
      tone: plain.tone as StatePill['tone'],
      fill: glyph.fill,
    };
  }

  glyphColor(tone: StatePill['tone']) {
    return {
      neutral: 'var(--muted)',
      purple: 'var(--accent)',
      green: 'var(--green)',
      amber: 'var(--amber)',
      red: 'var(--red)',
    }[tone];
  }

  cycleTime(request: FactoryRequest) {
    if (request.status !== 'done') return '—';
    return elapsedShort(
      (utc(request.updated_at).getTime() - utc(request.created_at).getTime()) / 1000,
    );
  }

  timeAgo = timeAgo;

  ngOnDestroy() {
    this.querySubscription.unsubscribe();
  }
}
