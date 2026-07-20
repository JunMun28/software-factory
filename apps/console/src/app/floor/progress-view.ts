import { Component, computed, input, output, signal } from '@angular/core';

import { DISPLAY_STAGES, OverviewRow, RowAction, progressRows, progressSegs } from './floor-view';
import { RowActions } from './row-actions';

/* Progress view — a wall of per-request bars. One row per request: title, its
   app, then five segments. Completed segments are quiet (surface with a faint
   green bias); the current stage is the row's only saturated segment — working
   green, gate/requester-wait amber, stuck red; future stages are barely there.
   One flat list, furthest along first — the unit is the request, not the app,
   since few requests run against one app at once. A row opens the action popover. */

@Component({
  selector: 'sf-progress-view',
  imports: [RowActions],
  template: `
    <div class="legend">
      <span class="lg"><i class="sw done"></i>done</span>
      <span class="lg"><i class="sw work"></i>working</span>
      <span class="lg"><i class="sw gate"></i>at gate</span>
      <span class="lg"><i class="sw wait"></i>requester</span>
      <span class="lg"><i class="sw stuck"></i>stuck</span>
      <span class="lg"><i class="sw future"></i>ahead</span>
    </div>

    <div class="stage-key" aria-hidden="true">
      <span class="k-title"></span>
      <span class="k-bar">
        @for (stage of stages; track stage.key) {
          <span>{{ stage.label }}</span>
        }
      </span>
    </div>

    @for (row of ordered(); track row.id) {
      <div class="p-wrap">
        <button
          type="button"
          class="p-row"
          [class.open]="openId() === row.id"
          [attr.aria-expanded]="openId() === row.id"
          [attr.aria-label]="row.title + ', ' + row.state"
          (click)="toggle(row.id)"
        >
          <span class="p-title">
            <i class="app-dot"></i>
            <span class="t">{{ row.title }}</span>
            <span class="a">{{ row.app }}</span>
          </span>
          <span class="p-bar">
            @for (seg of segs(row); track $index) {
              <span class="seg" [class]="seg"></span>
            }
          </span>
        </button>
        @if (openId() === row.id) {
          <sf-row-actions [row]="row" (act)="act.emit($event)" />
        }
      </div>
    } @empty {
      <p class="empty">Nothing in flight to chart.</p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-bottom: 14px;
    }
    .lg {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--muted);
      font: 500 9.5px var(--mono);
      letter-spacing: 0.04em;
    }
    .sw {
      width: 11px;
      height: 11px;
      border-radius: 3px;
      flex: none;
    }
    /* legend + bar swatches share these fills */
    .sw.done,
    .seg.done {
      background: color-mix(in srgb, var(--green) 12%, var(--surface-2));
      border: 1px solid color-mix(in srgb, var(--green) 20%, var(--border));
    }
    .sw.work,
    .seg.work {
      background: var(--green-bg);
      border: 1px solid var(--green-line);
    }
    .sw.gate,
    .seg.gate {
      background: var(--amber);
    }
    .sw.wait,
    .seg.wait {
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
    }
    .sw.stuck,
    .seg.stuck {
      background: var(--red);
    }
    .sw.future,
    .seg.future {
      background: transparent;
      border: 1px solid var(--border);
    }
    .sw.owned,
    .seg.owned {
      background: var(--accent-tint);
      border: 1px solid var(--accent-tint-bd);
    }
    .stage-key {
      display: grid;
      grid-template-columns: minmax(0, 320px) minmax(0, 1fr);
      gap: 12px;
      margin-bottom: 6px;
    }
    .k-bar {
      display: flex;
      gap: 3px;
    }
    .k-bar span {
      flex: 1;
      color: var(--faint);
      font: 500 8px var(--mono);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      text-align: center;
    }
    .p-wrap {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .p-row {
      display: grid;
      grid-template-columns: minmax(0, 320px) minmax(0, 1fr);
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 5px 6px;
      background: transparent;
      border: 0;
      border-radius: var(--r);
      text-align: left;
      cursor: pointer;
    }
    .p-row:hover {
      background: var(--surface-2);
    }
    .p-row:focus-visible {
      outline: none;
      box-shadow: inset 0 0 0 2px var(--accent-tint-bd);
    }
    .p-row.open {
      background: var(--surface-2);
    }
    .p-title {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .app-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--border-strong);
      flex: none;
    }
    .p-title .t {
      color: var(--fg1);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* the app rides on the row now that rows are not grouped under it */
    .p-title .a {
      flex: none;
      color: var(--faint);
      font-size: 10.5px;
      white-space: nowrap;
    }
    .p-bar {
      display: flex;
      gap: 3px;
      height: 14px;
    }
    .seg {
      flex: 1;
      border-radius: 3px;
    }
    /* the current working segment is the one live element */
    .seg.work {
      position: relative;
      overflow: hidden;
    }
    .seg.work::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(
        90deg,
        transparent,
        color-mix(in srgb, var(--green) 30%, transparent),
        transparent
      );
      transform: translateX(-100%);
      animation: prog-shimmer 1.7s var(--ease) infinite;
    }
    @keyframes prog-shimmer {
      to {
        transform: translateX(100%);
      }
    }
    .empty {
      padding: 26px 8px;
      color: var(--muted);
      font-size: 13px;
      text-align: center;
    }
    @media (max-width: 720px) {
      .stage-key,
      .p-row {
        grid-template-columns: 140px minmax(0, 1fr);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .seg.work::after {
        animation: none;
        display: none;
      }
    }
  `,
})
export class ProgressView {
  rows = input.required<OverviewRow[]>();
  act = output<RowAction>();
  openId = signal<number | null>(null);
  stages = DISPLAY_STAGES;
  ordered = computed(() => progressRows(this.rows()));
  segs = progressSegs;

  toggle(id: number) {
    this.openId.update((open) => (open === id ? null : id));
  }
}
