import { Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';

import { Store } from '../core/store.service';
import { Icon } from '../kit/kit';
import { AdminShell } from './admin-shell';

/** Mission control — the supervision home (spec §6): what needs me, what's
 *  running autonomously, what stalled, what just finished. One poll
 *  (Store.mission), bands render top-down by consequence. */
@Component({
  selector: 'sf-mission-page',
  imports: [AdminShell, Icon],
  template: `
    <admin-shell active="mission" title="Mission control">
      <span headerExtra class="row" style="gap:10px">
        <span style="font-size:12.5px;color:var(--muted)">{{ subtitle() }}</span>
      </span>
      <div class="list scroll" style="padding:18px 0 40px">
        <div style="max-width:920px;margin:0 auto;padding:0 22px">
          @if (m(); as m) {
            <div class="msn-empty">
              <sf-icon name="check" [size]="20" color="var(--green)" />
              Mission control is live — bands land in the next tasks.
            </div>
          } @else {
            <div class="msn-empty">Loading…</div>
          }
        </div>
      </div>
    </admin-shell>
  `,
  styles: `
    .msn-empty {
      display: flex;
      align-items: center;
      gap: 10px;
      justify-content: center;
      padding: 48px 0;
      color: var(--muted);
      font-size: 13px;
    }
  `,
})
export class Mission {
  protected router = inject(Router);
  private store = inject(Store);

  m = this.store.mission;

  subtitle = computed(() => {
    const m = this.m();
    if (!m) return '';
    const g = m.gates.length;
    const r = m.runs.length;
    return `${g} gate${g === 1 ? '' : 's'} waiting on you · ${r} build${r === 1 ? '' : 's'} running`;
  });
}
