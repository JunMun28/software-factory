import { Component, computed, input, output, signal } from '@angular/core';

import { DISPLAY_STAGES, OverviewRow, RowAction, progressRows, progressSegs } from './floor-view';
import { RowActions } from './row-actions';

/* Progress view — one thin track per request across the five stages. Shape does
   the reading: a reached stage is a full bar, a stage still ahead is a hairline,
   and a stage held by the requester is hollow, so where a request has got to
   survives greyscale and colour blindness. Colour is then layered on for the one
   thing that matters — amber where a gate waits on us, red where it has stalled,
   accent where a human took it over. An agent simply working stays neutral and
   lets its motion say "live". One flat list, furthest along first: the unit is
   the request, not the app. A row opens the same action popover as the Board. */

@Component({
  selector: 'sf-progress-view',
  imports: [RowActions],
  template: `
    <!-- The legend is a key, so it says who is holding things up in plain words.
         The two waiting states share one phrasing on purpose: the whole point of
         the colour is telling apart "you" from "someone else". -->
    <div class="legend">
      <span><i class="sw done"></i>done</span>
      <span><i class="sw work"></i>working</span>
      <span><i class="sw gate"></i>waiting for you</span>
      <span><i class="sw wait"></i>waiting for the submitter</span>
      <span><i class="sw stuck"></i>stuck</span>
      <span><i class="sw future"></i>not started</span>
    </div>

    <div class="stage-key" aria-hidden="true">
      <span></span>
      <span class="k-bar">
        @for (stage of stages; track stage.key) {
          <span>{{ stage.label }}</span>
        }
      </span>
      <span></span>
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
            <span class="t">{{ row.title }}</span>
            <span class="a">{{ row.app }}</span>
          </span>
          <span class="p-bar">
            @for (seg of segs(row); track $index) {
              <span class="seg" [class]="seg"></span>
            }
          </span>
          <span class="p-age mono">{{ row.age }}</span>
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
      align-items: center;
      gap: 8px 18px;
      padding: 20px 0 2px;
      color: var(--muted);
      font-size: 11.5px;
    }
    .legend span {
      display: inline-flex;
      align-items: center;
      gap: 7px;
    }

    /* ── the segment vocabulary, shared by the legend and the tracks ──
       full bar = reached · hollow = held elsewhere · hairline = not yet. */
    .sw {
      width: 14px;
      height: 6px;
      flex: none;
      border-radius: var(--r-pill);
    }
    .sw.done,
    .seg.done {
      background: var(--fill-done);
    }
    .sw.work,
    .seg.work {
      background: var(--fill-live);
    }
    .sw.gate,
    .seg.gate {
      background: var(--amber);
    }
    .sw.wait,
    .seg.wait {
      background: transparent;
      box-shadow: inset 0 0 0 1.5px var(--fill-wait);
    }
    /* square caps, so a stall stays distinct from a gate without relying on hue */
    .sw.stuck,
    .seg.stuck {
      background: var(--red);
      border-radius: 1px;
    }
    .sw.owned,
    .seg.owned {
      background: var(--accent);
    }
    /* not yet reached: a hairline, not a block — height is the cue, so the
       distinction survives greyscale and low vision where a tint would not */
    .sw.future,
    .seg.future {
      height: 2px;
      background: var(--track);
    }

    .stage-key {
      display: grid;
      grid-template-columns: minmax(0, 340px) minmax(0, 1fr) 34px;
      gap: 16px;
      padding: 14px 0 6px;
    }
    .k-bar {
      display: flex;
      gap: 4px;
    }
    .k-bar span {
      flex: 1;
      color: var(--faint);
      font-size: 11px;
      text-align: center;
    }

    .p-wrap {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .p-row {
      display: grid;
      grid-template-columns: minmax(0, 340px) minmax(0, 1fr) 34px;
      align-items: center;
      gap: 16px;
      width: calc(100% + 20px);
      margin: 0 -10px;
      padding: 8px 10px;
      background: transparent;
      border: 0;
      border-radius: 7px;
      text-align: left;
      cursor: pointer;
      transition: background var(--dur) var(--ease);
    }
    .p-row:hover,
    .p-row.open {
      background: var(--surface-2);
    }
    .p-row:focus-visible {
      outline: none;
      box-shadow: inset 0 0 0 2px var(--accent-tint-bd);
    }
    .p-title {
      display: flex;
      align-items: baseline;
      gap: 10px;
      min-width: 0;
    }
    .p-title .t {
      color: var(--fg1);
      font-size: 13px;
      font-weight: 500;
      letter-spacing: -0.005em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* the app rides on the row now that rows are not grouped under it */
    .p-title .a {
      flex: none;
      color: var(--faint);
      font-size: 11.5px;
      white-space: nowrap;
    }
    .p-age {
      color: var(--faint);
      font-size: 11px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .p-bar {
      display: flex;
      align-items: center;
      gap: 4px;
      height: 6px;
    }
    .seg {
      flex: 1;
      height: 6px;
      border-radius: var(--r-pill);
    }
    /* the working segment is the one live element on the wall */
    .seg.work {
      position: relative;
      overflow: hidden;
    }
    .seg.work::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.35), transparent);
      transform: translateX(-100%);
      animation: sf-prog-shimmer 1.8s var(--ease) infinite;
    }
    @keyframes sf-prog-shimmer {
      to {
        transform: translateX(100%);
      }
    }

    .empty {
      padding: 40px 0;
      color: var(--muted);
      font-size: 13px;
      text-align: center;
    }

    @media (max-width: 860px) {
      .stage-key,
      .p-row {
        grid-template-columns: 150px minmax(0, 1fr) 34px;
      }
      .p-title {
        flex-direction: column;
        /* stretch, NOT flex-start: on the cross axis flex-start sizes each child
           to its own content, so a long title grew past this column and painted
           over the bars instead of ellipsizing. */
        align-items: stretch;
        gap: 1px;
      }
      .p-title .a {
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .p-row {
        transition: none;
      }
      .seg.work::after {
        display: none;
        animation: none;
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
