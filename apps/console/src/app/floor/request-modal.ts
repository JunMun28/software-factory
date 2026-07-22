import { Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  OverviewRow,
  RowAction,
  RowActionVerb,
  actionLabel,
  rowActions,
  stateClass,
} from './floor-view';

/* The Overview's request sheet. Clicking a request on the Overview opens this
   rather than an inline popover: the rail is a quiet list and a popover growing
   inside it pushed the columns around. It states what the request is, where it
   has got to and how long it has been there, then offers exactly the actions its
   kind allows. Verbs bubble up as one RowAction so the page keeps sole ownership
   of the confirm modals and the api calls. */

@Component({
  selector: 'sf-request-modal',
  imports: [RouterLink],
  template: `
    <div class="scrim" (click)="dismissed.emit()"></div>
    <div
      class="sheet"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="row().title"
      (click)="$event.stopPropagation()"
    >
      <header>
        <span class="ref mono">{{ row().ref }}</span>
        <span class="state" [class]="cls()"><i aria-hidden="true"></i>{{ row().state }}</span>
        <button type="button" class="x" aria-label="Close" (click)="dismissed.emit()">✕</button>
      </header>

      <h2>{{ row().title }}</h2>

      <dl class="facts">
        <div>
          <dt>Application</dt>
          <dd>{{ row().app }}</dd>
        </div>
        <div>
          <dt>Stage</dt>
          <dd>{{ stageName() }}</dd>
        </div>
        <div>
          <dt>In this stage</dt>
          <dd class="mono">{{ row().age ?? '—' }}</dd>
        </div>
      </dl>

      @if (row().activity) {
        <p class="activity mono">{{ row().activity }}</p>
      }

      <div class="acts">
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
          <span class="none">An agent is running — nothing to act on yet.</span>
        }
        <a class="act link" [routerLink]="['/requests', row().id]">Open dossier</a>
      </div>
    </div>
  `,
  styles: `
    :host {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .scrim {
      position: absolute;
      inset: 0;
      /* matches the command palette's backdrop so overlays agree */
      background: rgba(15, 12, 20, 0.4);
    }
    .sheet {
      position: relative;
      width: min(560px, 100%);
      max-height: 100%;
      overflow-y: auto;
      padding: 22px 24px 20px;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--r-lg);
      box-shadow: var(--shadow-overlay);
    }
    header {
      display: flex;
      align-items: baseline;
      gap: 12px;
    }
    .ref {
      flex: none;
      color: var(--faint);
      font-size: 11px;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }
    .x {
      margin-left: auto;
      width: 26px;
      height: 26px;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-radius: var(--r);
      font-size: 13px;
      cursor: pointer;
    }
    .x:hover {
      color: var(--fg1);
      background: var(--surface-2);
    }
    h2 {
      margin: 12px 0 0;
      font-size: 19px;
      font-weight: 700;
      line-height: 1.3;
      letter-spacing: -0.01em;
      overflow-wrap: anywhere;
    }

    /* the same dot-plus-words language the Overview uses */
    /* the reason can be a full sentence — let it wrap rather than shoving the
       ref onto two lines beside it */
    .state {
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
      font-size: 11.5px;
      line-height: 1.4;
      color: var(--muted);
    }
    .state i {
      width: 6px;
      height: 6px;
      flex: none;
      transform: translateY(-1px);
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
      background: var(--cyan);
      box-shadow: none;
    }
    .state.shipped {
      color: var(--green-tx);
    }
    .state.shipped i {
      background: var(--green);
      box-shadow: none;
    }

    .facts {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
      margin: 18px 0 0;
      padding: 14px 0 0;
      border-top: 1px solid var(--hairline);
    }
    .facts div {
      min-width: 0;
    }
    dt {
      font-size: 10.5px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--faint);
    }
    dd {
      margin: 4px 0 0;
      font-size: 13px;
      color: var(--fg1);
      overflow-wrap: anywhere;
    }
    .activity {
      margin: 14px 0 0;
      padding: 9px 11px;
      font-size: 11.5px;
      color: var(--fg2);
      background: var(--surface-2);
      border-radius: var(--r);
      overflow-wrap: anywhere;
    }

    .acts {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-top: 20px;
    }
    .act {
      padding: 8px 14px;
      color: var(--fg1);
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--r);
      font: 600 13px var(--body);
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
      margin-left: auto;
      color: var(--accent-link);
      border-color: transparent;
    }
    .none {
      font-size: 12.5px;
      color: var(--faint);
    }
    @media (prefers-reduced-motion: reduce) {
      .act {
        transition: none;
      }
    }
  `,
})
export class RequestModal {
  row = input.required<OverviewRow>();
  act = output<RowAction>();
  dismissed = output<void>();

  verbs = computed(() => rowActions(this.row()));
  cls = computed(() => stateClass(this.row()));
  stageName = computed(() => STAGE_LABEL[this.row().stageIndex] ?? '—');
  label = (verb: RowActionVerb) => actionLabel(verb);
}

const STAGE_LABEL = ['Spec', 'Architecture', 'Build', 'Review', 'Deploy', 'Shipped'];
