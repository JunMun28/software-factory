import { Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';

import { OverviewRow, RowAction, RowActionVerb, actionLabel, rowActions } from './floor-view';

/* The inline action popover shared by the Line and Progress views. It renders the
   actions a row's kind allows (from the pure rowActions/floor-view contract) plus
   an always-present Open dossier link. Actions bubble up as one RowAction event so
   the page keeps sole ownership of the confirm modals + api calls. */

@Component({
  selector: 'sf-row-actions',
  imports: [RouterLink],
  template: `
    <div class="rowpop">
      <p class="rowpop-t">{{ row().title }}</p>
      <p class="rowpop-m mono">{{ row().app }} · {{ row().state }}</p>
      <div class="rowpop-a">
        @for (verb of verbs(); track verb) {
          <button
            type="button"
            class="act"
            [class.primary]="verb === 'approve'"
            [class.danger]="verb === 'cancel'"
            (click)="act.emit({ verb, request: row().request })"
          >
            {{ label(verb) }}
          </button>
        } @empty {
          <span class="rowpop-none">Agent running — nothing to act on.</span>
        }
        <a class="act link" [routerLink]="['/requests', row().id]">Open dossier</a>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .rowpop {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
      padding: 10px 11px;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--r-lg);
      box-shadow: var(--shadow-pop);
    }
    .rowpop-t {
      margin: 0;
      color: var(--fg1);
      font-size: 12.5px;
      font-weight: 600;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .rowpop-m {
      margin: 0;
      color: var(--faint);
      font-size: 10.5px;
      overflow-wrap: anywhere;
    }
    .rowpop-none {
      color: var(--faint);
      font-size: 11.5px;
    }
    .rowpop-a {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 3px;
    }
    .act {
      flex: 0 1 auto;
      min-width: 0;
      padding: 5px 10px;
      white-space: nowrap;
      color: var(--fg1);
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--r);
      font: 600 11.5px var(--body);
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
  `,
})
export class RowActions {
  row = input.required<OverviewRow>();
  act = output<RowAction>();
  verbs = computed(() => rowActions(this.row()));
  label = (verb: RowActionVerb) => actionLabel(verb);
}
