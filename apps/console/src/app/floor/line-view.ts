import { Component, computed, input, output, signal } from '@angular/core';

import { DISPLAY_STAGES, OverviewRow, RowAction, laneRows } from './floor-view';
import { RowActions } from './row-actions';

/* Line view — the assembly line. Five lanes left→right, each headed by its stage
   name, count, and the agent that owns it. Requests are chips in their lane:
   active chips carry a live activity line (real run/last_event data, never
   simulated); gate chips glow amber and settle at the lane's edge; stuck chips
   glow red. A chip opens a light inline popover with the same actions the row
   offers plus Open dossier. */

@Component({
  selector: 'sf-line-view',
  imports: [RowActions],
  template: `
    <!-- the whole line as mass, before the detail: one dot per request, binned
         by the lane it sits in — the shape of the backlog in a single glance -->
    <div class="units" role="group" aria-label="Requests per stage">
      @for (stage of stages; track stage.key; let i = $index) {
        <div class="unit-g">
          <p class="unit-h">
            <span class="l mono">{{ stage.label }}</span>
            <span class="n mono">{{ lanes()[i].length }}</span>
          </p>
          <div class="unit-d">
            @for (row of lanes()[i]; track row.id) {
              <button
                type="button"
                class="udot"
                [class]="'k-' + row.kind"
                [class.on]="openId() === row.id"
                [title]="row.title + ' · ' + row.state"
                [attr.aria-label]="row.title + ', ' + row.state"
                (click)="toggle(row.id)"
              ></button>
            } @empty {
              <span class="unit-none">—</span>
            }
          </div>
        </div>
      }
    </div>

    <div class="conveyor scroll-x">
      <div class="lanes">
        @for (stage of stages; track stage.key; let i = $index) {
          <section class="lane" [attr.aria-label]="stage.label + ' lane'">
            <header class="lane-head">
              <span class="lane-name">{{ stage.label }}</span>
              <span class="lane-count mono">{{ lanes()[i].length }}</span>
            </header>
            <span class="lane-agent mono">{{ stage.agent }}</span>

            @for (row of lanes()[i]; track row.id) {
              <div class="lchip-wrap">
                <button
                  type="button"
                  class="lchip"
                  [class]="'k-' + row.kind"
                  [class.open]="openId() === row.id"
                  [attr.aria-expanded]="openId() === row.id"
                  (click)="toggle(row.id)"
                >
                  <span class="c-top">
                    <span class="c-ref mono">{{ row.ref }}</span>
                    <span class="c-age mono">{{ row.age }}</span>
                  </span>
                  <span class="c-title">{{ row.title }}</span>
                  <span class="c-app">{{ row.app }}</span>
                  @if (row.needsHuman) {
                    <span class="c-wait">{{ row.state }}</span>
                  } @else if (row.activity) {
                    <span class="c-live mono">{{ row.activity }}</span>
                  } @else {
                    <span class="c-quiet">{{ row.state }}</span>
                  }
                </button>
                @if (openId() === row.id) {
                  <sf-row-actions [row]="row" (act)="act.emit($event)" />
                }
              </div>
            } @empty {
              <p class="lane-empty mono">empty</p>
            }
          </section>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    /* ── unit dots: the backlog as mass, above the conveyor ── */
    .units {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--hairline);
    }
    .unit-g {
      min-width: 0;
    }
    .unit-h {
      display: flex;
      align-items: baseline;
      gap: 7px;
      margin: 0 0 7px;
    }
    .unit-h .l {
      color: var(--faint);
      font-size: 8.5px;
      font-weight: 600;
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }
    .unit-h .n {
      color: var(--fg2);
      font-size: 12px;
      font-weight: 600;
    }
    .unit-d {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .udot {
      width: 10px;
      height: 10px;
      padding: 0;
      background: var(--surface-3);
      border: 1px solid var(--border);
      border-radius: 50%;
      cursor: pointer;
      transition: transform var(--dur) var(--ease);
    }
    .udot:hover {
      transform: scale(1.35);
    }
    .udot:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--accent-tint-bd);
    }
    .udot.on {
      box-shadow: 0 0 0 2px var(--border-strong);
    }
    .udot.k-gate,
    .udot.k-wait {
      background: var(--amber);
      border-color: var(--amber);
    }
    .udot.k-stuck {
      background: var(--red);
      border-color: var(--red);
    }
    .udot.k-run {
      background: var(--green);
      border-color: var(--green);
    }
    .udot.k-owned {
      background: var(--accent-tint-bd);
      border-color: var(--accent-tint-bd);
    }
    .unit-none {
      color: var(--faint);
      font-size: 11px;
    }
    .conveyor {
      overflow-x: auto;
      padding-bottom: 8px;
    }
    .lanes {
      display: flex;
      gap: 12px;
      align-items: stretch;
      min-width: 900px;
    }
    .lane {
      display: flex;
      flex: 1 1 0;
      min-width: 172px;
      flex-direction: column;
      gap: 7px;
      padding: 11px 9px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
    }
    .lane-head {
      display: flex;
      flex: none;
      align-items: baseline;
      justify-content: space-between;
      padding: 0 2px;
    }
    .lane-name {
      color: var(--fg2);
      font: 600 10px var(--mono);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .lane-count {
      color: var(--fg1);
      font-size: 14px;
      font-weight: 600;
    }
    .lane-agent {
      flex: none;
      padding: 0 2px 4px;
      color: var(--faint);
      font-size: 8.5px;
      letter-spacing: 0.06em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .lane-empty {
      padding: 6px 4px;
      color: var(--faint);
      font-size: 10px;
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
      gap: 2px;
      width: 100%;
      min-width: 0;
      padding: 8px 9px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r);
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
    .c-top {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 6px;
    }
    .c-ref {
      color: var(--faint);
      font-size: 9px;
      letter-spacing: 0.04em;
    }
    .c-age {
      color: var(--faint);
      font-size: 9.5px;
    }
    .c-title {
      color: var(--fg1);
      font-size: 11px;
      line-height: 1.3;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .c-app {
      color: var(--faint);
      font-size: 9.5px;
    }
    .c-live {
      margin-top: 2px;
      color: var(--green-tx);
      font-size: 8.5px;
      letter-spacing: 0.02em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .c-quiet {
      margin-top: 2px;
      color: var(--faint);
      font-size: 9px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .c-wait {
      margin-top: 2px;
      font-size: 9px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* gate chips glow amber and read their wait; stuck chips glow red */
    .lchip.k-gate {
      border-color: var(--amber-line);
    }
    .lchip.k-gate .c-age,
    .lchip.k-gate .c-wait {
      color: var(--amber-tx);
    }
    .lchip.k-wait {
      border-color: var(--amber-line);
    }
    .lchip.k-wait .c-wait,
    .lchip.k-wait .c-age {
      color: var(--amber-tx);
    }
    .lchip.k-stuck {
      border-color: var(--red-line);
      background: var(--red-bg);
    }
    .lchip.k-stuck .c-age,
    .lchip.k-stuck .c-wait {
      color: var(--red-tx);
    }
    .lchip.k-owned {
      border-color: var(--accent-tint-bd);
    }
    .lchip.k-owned .c-wait {
      color: var(--accent-tx);
    }
    @media (prefers-reduced-motion: reduce) {
      .lchip {
        transition: none;
      }
    }
  `,
})
export class LineView {
  rows = input.required<OverviewRow[]>();
  act = output<RowAction>();
  openId = signal<number | null>(null);
  stages = DISPLAY_STAGES;
  lanes = computed(() => laneRows(this.rows()));

  toggle(id: number) {
    this.openId.update((open) => (open === id ? null : id));
  }
}
