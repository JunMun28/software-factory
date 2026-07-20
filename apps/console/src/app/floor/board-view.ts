import { Component, computed, input, output, signal } from '@angular/core';

import { DISPLAY_STAGES, OverviewRow, RowAction, laneRows, stateClass } from './floor-view';
import { RowActions } from './row-actions';

/* Board view — the assembly line as columns. Five lanes left→right, each headed
   by its stage name, count, and the agent that owns it. Lanes are divided by a
   hairline, not boxed: the columns are structure, not objects. Requests are
   cards in their lane, carrying the same dot-plus-words state language the List
   and Progress views use. A card opens an inline popover with the row's actions
   plus Open dossier. Activity text is real run/last_event data, never simulated. */

@Component({
  selector: 'sf-board-view',
  imports: [RowActions],
  template: `
    <div class="conveyor scroll-x">
      <div class="lanes">
        @for (stage of stages; track stage.key; let i = $index) {
          <section class="lane" [attr.aria-label]="stage.label + ' lane'">
            <div class="lane-head">
              <h2 class="lane-name">{{ stage.label }}</h2>
              <span class="lane-count mono">{{ lanes()[i].length }}</span>
              <span class="lane-agent mono">{{ stage.agent }}</span>
            </div>

            <div class="lane-cards">
              @for (row of lanes()[i]; track row.id) {
                <div class="lchip-wrap">
                  <button
                    type="button"
                    class="lchip"
                    [class.stuck]="row.kind === 'stuck'"
                    [class.open]="openId() === row.id"
                    [attr.aria-expanded]="openId() === row.id"
                    [attr.aria-label]="row.title + ', ' + row.state"
                    (click)="toggle(row.id)"
                  >
                    <span class="c-top mono">
                      <span class="c-ref">{{ row.ref }}</span>
                      <span class="c-age">{{ row.age }}</span>
                    </span>
                    <span class="c-title">{{ row.title }}</span>
                    <span class="c-app">{{ row.app }}</span>
                    <span class="state" [class]="stateClass(row)">
                      <i aria-hidden="true"></i>
                      <span class="state-t">{{
                        row.needsHuman || !row.activity ? row.state : row.activity
                      }}</span>
                    </span>
                  </button>
                  @if (openId() === row.id) {
                    <sf-row-actions [row]="row" (act)="act.emit($event)" />
                  }
                </div>
              } @empty {
                <p class="lane-empty">Nothing here yet</p>
              }
            </div>
          </section>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .conveyor {
      overflow-x: auto;
      padding-bottom: 8px;
    }
    .lanes {
      display: flex;
      align-items: stretch;
      min-width: 900px;
    }
    /* lanes are divided, not boxed — the hairline is the whole structure */
    .lane {
      display: flex;
      flex: 1 1 0;
      min-width: 172px;
      flex-direction: column;
      padding: 20px 18px 0;
    }
    .lane + .lane {
      border-left: 1px solid var(--hairline);
    }
    .lane:first-child {
      padding-left: 0;
    }
    .lane:last-child {
      padding-right: 0;
    }
    .lane-head {
      display: flex;
      flex: none;
      align-items: baseline;
      gap: 8px;
    }
    .lane-name {
      margin: 0;
      color: var(--fg1);
      font-family: var(--body);
      font-size: 13px;
      font-weight: 600;
    }
    .lane-count {
      color: var(--muted);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .lane-agent {
      margin-left: auto;
      color: var(--faint);
      font-size: 10.5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .lane-empty {
      margin: 0;
      padding: 26px 0 0;
      color: var(--faint);
      font-size: 12px;
    }
    .lane-cards {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-top: 12px;
    }
    /* lanes stretch to the tallest column, so nothing inside may flex-shrink —
       an expanded popover has to grow its lane, not squash itself to nothing */
    .lchip-wrap {
      display: flex;
      flex: none;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }
    .lchip-wrap sf-row-actions {
      flex: none;
      width: 100%;
      min-width: 0;
    }
    .lchip {
      display: flex;
      flex: none;
      flex-direction: column;
      gap: 3px;
      width: 100%;
      min-width: 0;
      padding: 11px 13px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      text-align: left;
      cursor: pointer;
      transition:
        border-color var(--dur) var(--ease),
        background var(--dur) var(--ease);
    }
    .lchip:hover {
      border-color: var(--border-strong);
    }
    .lchip:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--accent-tint-bd);
    }
    .lchip.open {
      border-color: var(--border-strong);
      background: var(--surface-2);
    }
    /* a stall is the one card allowed to raise its voice */
    .lchip.stuck {
      border-color: var(--red-line);
      background: var(--red-bg);
    }
    .c-top {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      color: var(--faint);
      font-size: 11px;
    }
    .c-title {
      color: var(--fg1);
      font-size: 13px;
      font-weight: 500;
      line-height: 1.35;
      letter-spacing: -0.005em;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .c-app {
      color: var(--muted);
      font-size: 11.5px;
    }

    /* ── state: the same dot-plus-words language as List and Progress ── */
    .state {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      margin-top: 5px;
      color: var(--muted);
      font-size: 11.5px;
    }
    /* the text owns the clipping — an anonymous flex child does not ellipsize */
    .state-t {
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .state i {
      width: 6px;
      height: 6px;
      flex: none;
      border-radius: 50%;
      background: transparent;
      box-shadow: inset 0 0 0 1.5px var(--fill-wait);
    }
    .state.gate {
      color: var(--amber-tx);
      font-weight: 500;
    }
    .state.gate i {
      background: var(--amber);
      box-shadow: none;
    }
    .state.stuck {
      color: var(--red-tx);
      font-weight: 500;
    }
    .state.stuck i {
      background: var(--red);
      border-radius: 1px;
      box-shadow: none;
    }
    .state.owned {
      color: var(--accent-tx);
      font-weight: 500;
    }
    .state.owned i {
      background: var(--accent);
      box-shadow: none;
    }
    .state.run i {
      background: var(--fill-live);
      box-shadow: none;
      animation: sf-line-pulse 2.4s ease-in-out infinite;
    }
    .state.shipped {
      color: var(--green-tx);
    }
    .state.shipped i {
      background: var(--green);
      box-shadow: none;
    }
    @keyframes sf-line-pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.35;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .lchip {
        transition: none;
      }
      .state.run i {
        animation: none;
      }
    }
  `,
})
export class BoardView {
  rows = input.required<OverviewRow[]>();
  act = output<RowAction>();
  openId = signal<number | null>(null);
  stages = DISPLAY_STAGES;
  lanes = computed(() => laneRows(this.rows()));
  stateClass = stateClass;

  toggle(id: number) {
    this.openId.update((open) => (open === id ? null : id));
  }
}
