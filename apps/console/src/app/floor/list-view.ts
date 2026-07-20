import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DISPLAY_STAGES, OverviewRow, stateClass } from './floor-view';

/* List view — every live request as one dense row, grouped under the five
   displayed stages. No boxes: a stage names itself over a hairline rule and its
   rows hang beneath it. State rides on each row as a dot plus the admin's own
   words, so the same status language reads identically here, on the Board, and
   on the Progress wall. Rows link to the Dossier, where every action lives. */

interface StageGroup {
  label: string;
  agent: string;
  rows: OverviewRow[];
}

@Component({
  selector: 'sf-list-view',
  imports: [RouterLink],
  template: `
    @for (group of groups(); track group.label) {
      <section class="group" [attr.aria-label]="group.label + ' stage'">
        <div class="group-head">
          <h2 class="s-name">{{ group.label }}</h2>
          <span class="s-count mono">{{ group.rows.length }}</span>
          <span class="agent mono">{{ group.agent }}</span>
        </div>
        @for (row of group.rows; track row.id) {
          <a class="srow" [routerLink]="['/requests', row.id]">
            <span class="ref mono">{{ row.ref }}</span>
            <span class="main">
              <span class="title">{{ row.title }}</span>
              <span class="app">{{ row.app }}</span>
            </span>
            <span class="state" [class]="stateClass(row)" [title]="row.state">
              <i aria-hidden="true"></i><span class="state-t">{{ row.state }}</span>
            </span>
            <span class="age mono">{{ row.age }}</span>
          </a>
        }
      </section>
    } @empty {
      <p class="empty">The line is resting — no requests in flight.</p>
    }

    @if (shipped().length > 0) {
      <section class="group" aria-label="Shipped recently">
        <div class="group-head">
          <h2 class="s-name">Shipped recently</h2>
          <span class="s-count mono">{{ shipped().length }}</span>
        </div>
        @for (row of shipped(); track row.id) {
          <a class="srow done" [routerLink]="['/requests', row.id]">
            <span class="ref mono">{{ row.ref }}</span>
            <span class="main">
              <span class="title">{{ row.title }}</span>
              <span class="app">{{ row.app }}</span>
            </span>
            <span class="state shipped">
              <i aria-hidden="true"></i><span class="state-t">{{ row.state }}</span>
            </span>
            <span class="age mono"></span>
          </a>
        }
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .group {
      margin-top: 26px;
    }
    .group-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding-bottom: 9px;
      border-bottom: 1px solid var(--hairline);
    }
    /* the stage names itself; "Shipped recently" is the same kind of label */
    .s-name {
      margin: 0;
      color: var(--fg1);
      font-family: var(--body);
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0;
    }
    .s-count {
      color: var(--muted);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .agent {
      margin-left: auto;
      color: var(--faint);
      font-size: 10.5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ── one request, one line ── */
    .srow {
      display: grid;
      grid-template-columns: 92px minmax(0, 1fr) minmax(0, 260px) 34px;
      align-items: center;
      gap: 16px;
      margin: 0 -10px;
      padding: 9px 10px;
      border-radius: 7px;
      text-decoration: none;
      transition: background var(--dur) var(--ease);
    }
    .srow + .srow {
      box-shadow: 0 -1px 0 var(--hairline);
    }
    .srow:hover {
      background: var(--surface-2);
      box-shadow: none;
    }
    .srow:focus-visible {
      outline: none;
      box-shadow: inset 0 0 0 2px var(--accent-tint-bd);
    }
    .ref {
      color: var(--faint);
      font-size: 11px;
    }
    .main {
      display: flex;
      align-items: baseline;
      gap: 10px;
      min-width: 0;
    }
    .title {
      color: var(--fg1);
      font-size: 13px;
      font-weight: 500;
      letter-spacing: -0.005em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .app {
      flex: none;
      color: var(--faint);
      font-size: 11.5px;
    }
    .age {
      color: var(--faint);
      font-size: 11px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    /* ── state: a dot plus the admin's words ──
       Default is a hollow ring: the request is held, but not by us. Solid means
       something is happening to it; colour means a human is the thing missing. */
    .state {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      min-width: 0;
      color: var(--muted);
      font-size: 11.5px;
    }
    /* the text owns the clipping — on a right-aligned flex row the ellipsis
       would otherwise eat the START of a long reason instead of its tail */
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
    /* square, so a stall stays distinct from a gate without relying on hue */
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
    /* an agent is working — graphite, never green; green is for shipped only */
    .state.run i {
      background: var(--fill-live);
      box-shadow: none;
      animation: sf-stack-pulse 2.4s ease-in-out infinite;
    }
    .state.shipped {
      color: var(--green-tx);
    }
    .state.shipped i {
      background: var(--green);
      box-shadow: none;
    }
    @keyframes sf-stack-pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.35;
      }
    }
    .srow.done .title {
      color: var(--muted);
    }

    .empty {
      padding: 40px 0;
      color: var(--muted);
      font-size: 13px;
      text-align: center;
    }

    @media (max-width: 860px) {
      .srow {
        grid-template-columns: 78px minmax(0, 1fr) 34px;
      }
      .state {
        grid-column: 1 / -1;
        justify-content: flex-start;
        padding-left: 94px;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .srow {
        transition: none;
      }
      .state.run i {
        animation: none;
      }
    }
  `,
})
export class ListView {
  rows = input.required<OverviewRow[]>();
  shipped = input.required<OverviewRow[]>();

  groups = computed<StageGroup[]>(() => {
    const buckets = DISPLAY_STAGES.map((s) => ({
      label: s.label,
      agent: s.agent,
      rows: [] as OverviewRow[],
    }));
    for (const row of this.rows()) {
      if (row.stageIndex < 5) buckets[Math.min(row.stageIndex, 4)].rows.push(row);
    }
    return buckets.filter((b) => b.rows.length > 0);
  });

  stateClass = stateClass;
}
