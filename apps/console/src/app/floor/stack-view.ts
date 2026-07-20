import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DISPLAY_STAGES, OverviewRow } from './floor-view';

/* Stack view — the previous track-row line, regrouped under the five displayed
   stages. Rows link to the Dossier, where every action lives; the Line and
   Progress views carry the inline action popovers. */

interface StackGroup {
  label: string;
  rows: OverviewRow[];
}

@Component({
  selector: 'sf-stack-view',
  imports: [RouterLink],
  template: `
    <div class="stages">
      @for (group of groups(); track group.label) {
        <section class="stage-group" [attr.aria-label]="group.label + ' stage'">
          <div class="stage-head">
            <span class="s-name">{{ group.label }}</span>
            <span class="mono s-count">{{ group.rows.length }}</span>
          </div>
          <div class="card">
            @for (row of group.rows; track row.id) {
              <a class="srow" [class]="'k-' + row.kind" [routerLink]="['/requests', row.id]">
                <span class="ref mono">{{ row.ref }}</span>
                <span class="main">
                  <span class="title">{{ row.title }}</span>
                  <span class="app">{{ row.app }}</span>
                </span>
                <span class="right">
                  <span class="state" [title]="row.state">{{ row.state }}</span>
                  <span class="pill" [class]="row.kind">
                    <i class="dot"></i>{{ pillLabel(row) }}
                  </span>
                  @if (row.age) {
                    <span class="age mono">{{ row.age }}</span>
                  }
                </span>
              </a>
            }
          </div>
        </section>
      } @empty {
        <div class="card">
          <p class="empty">The line is resting — no requests in flight.</p>
        </div>
      }
    </div>

    @if (shipped().length > 0) {
      <section class="stage-group shipped" aria-label="Shipped recently">
        <div class="stage-head">
          <span class="s-name">Shipped recently</span>
          <span class="mono s-count">{{ shipped().length }}</span>
        </div>
        <div class="card">
          @for (row of shipped(); track row.id) {
            <a class="srow k-done" [routerLink]="['/requests', row.id]">
              <span class="ref mono">{{ row.ref }}</span>
              <span class="main">
                <span class="title">{{ row.title }}</span>
                <span class="app">{{ row.app }}</span>
              </span>
              <span class="right">
                <span class="state">{{ row.state }}</span>
              </span>
            </a>
          }
        </div>
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    /* one box per stage, and the stage names itself from outside the box */
    .stages {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .card {
      padding: 4px 8px 6px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
    }
    .stage-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 2px 8px;
    }
    /* stage names and "shipped recently" are the same kind of label — one style */
    .s-name {
      color: var(--faint);
      font: 600 11px var(--body);
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .s-count {
      color: var(--faint);
      font-size: 11px;
    }
    .srow {
      display: grid;
      grid-template-columns: 72px minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      padding: 8px 8px;
      border-radius: var(--r);
      text-decoration: none;
    }
    .srow:hover {
      background: var(--surface-2);
    }
    .srow:focus-visible {
      outline: none;
      box-shadow: inset 0 0 0 2px var(--accent-tint-bd);
    }
    .ref {
      color: var(--faint);
      font-size: 10.5px;
    }
    .main {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .title {
      color: var(--fg1);
      font-size: 12.5px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .app {
      color: var(--faint);
      font-size: 11px;
    }
    .right {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
    }
    .state {
      max-width: 30ch;
      color: var(--muted);
      font-size: 11.5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .age {
      min-width: 30px;
      color: var(--faint);
      font-size: 10.5px;
      text-align: right;
    }
    /* status pill — colour by kind, neutral by default */
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      color: var(--muted);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--r-pill);
      font: 600 9.5px var(--mono);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .pill .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--faint);
    }
    .pill.active .dot {
      background: var(--green);
    }
    .pill.gate,
    .pill.wait {
      color: var(--amber-tx);
      background: var(--amber-bg);
      border-color: var(--amber-line);
    }
    .pill.gate .dot,
    .pill.wait .dot {
      background: var(--amber);
    }
    .pill.stuck {
      color: var(--red-tx);
      background: var(--red-bg);
      border-color: var(--red-line);
    }
    .pill.stuck .dot {
      background: var(--red);
    }
    .pill.owned {
      color: var(--accent-tx);
      background: var(--accent-tint);
      border-color: var(--accent-tint-bd);
    }
    .pill.owned .dot {
      background: var(--accent);
    }
    .empty {
      padding: 26px 8px;
      color: var(--muted);
      font-size: 13px;
      text-align: center;
    }
    .shipped {
      margin-top: 20px;
    }
    .k-done .title {
      color: var(--muted);
    }
    .k-done .state {
      color: var(--green-tx);
    }
    @media (max-width: 720px) {
      .srow {
        grid-template-columns: 60px minmax(0, 1fr);
      }
      .right {
        grid-column: 1 / -1;
        justify-content: flex-start;
        padding-left: 72px;
      }
    }
  `,
})
export class StackView {
  rows = input.required<OverviewRow[]>();
  shipped = input.required<OverviewRow[]>();

  groups = computed<StackGroup[]>(() => {
    const buckets = DISPLAY_STAGES.map((s) => ({ label: s.label, rows: [] as OverviewRow[] }));
    for (const row of this.rows()) {
      if (row.stageIndex < 5) buckets[Math.min(row.stageIndex, 4)].rows.push(row);
    }
    return buckets.filter((b) => b.rows.length > 0);
  });

  pillLabel(row: OverviewRow): string {
    switch (row.kind) {
      case 'gate':
        return 'Your gate';
      case 'wait':
        return 'Waiting';
      case 'stuck':
        return 'Stuck';
      case 'owned':
        return 'Human';
      case 'draft':
        return 'Draft';
      default:
        return 'In progress';
    }
  }
}
