import { Component, HostListener, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';

import { FactoryRequest } from '../core/models';
import { Store } from '../core/store.service';
import { TYPE_SHORT, timeAgo } from '../core/util';
import { Glyph, Sig } from '../kit/kit';
import { AdminShell } from './admin-shell';

/** C6 — Needs-me inbox: the clear-to-zero surface holding only items waiting on this Admin. */
@Component({
  selector: 'sf-inbox-page',
  imports: [AdminShell, Glyph, Sig],
  template: `
    <admin-shell active="needsme" title="Needs me">
      <span headerExtra style="font-size:11.5px;color:var(--faint)"
        >J/K move · ↵ open · A approve</span
      >
      @if (!items().length) {
        <div
          style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center"
        >
          <span
            style="width:64px;height:64px;border-radius:50%;background:var(--green-bg);display:flex;align-items:center;justify-content:center"
            ><sf-glyph type="check" [size]="36" color="var(--green)"
          /></span>
          <h2 style="font-size:23px">No specs waiting on you</h2>
          <p style="font-size:14.5px;color:var(--muted)">You're clear. New gates land here.</p>
        </div>
      } @else {
        <div class="list scroll" style="max-width:680px;margin:0 auto;padding:12px 0">
          @for (r of items(); track r.id; let i = $index) {
            <div
              class="lrow focusable"
              tabindex="0"
              role="button"
              [class.focus]="i === focusIdx()"
              style="padding:11px 16px"
              (click)="open(r)"
              (keydown.enter)="open(r)"
              (focus)="focusIdx.set(i)"
            >
              <sf-glyph
                [type]="r.needs_human ? 'flag' : 'ring'"
                [size]="15"
                [color]="r.needs_human ? 'var(--red)' : 'var(--a500)'"
                [fill]="0.4"
              />
              <span
                style="width:114px;flex:0 0 114px;font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
                >{{ r.app_name }}</span
              >
              <span class="chip">{{ typeShort[r.type] }}</span>
              <span
                style="flex:1;min-width:0;font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
                >{{ r.title }}{{ r.needs_human ? ' — escalated' : '' }}</span
              >
              @if (r.needs_human) {
                <sf-sig tone="red" glyph="flag">Needs human</sf-sig>
              } @else if (r.gate === 'approve_merge') {
                <sf-sig tone="amber" [kbd]="i === focusIdx() ? 'A' : null">Approve merge</sf-sig>
              } @else {
                <sf-sig tone="amber" [kbd]="i === focusIdx() ? 'A' : null">Approve</sf-sig>
              }
              <span
                style="width:30px;flex:0 0 30px;font-size:11px;color:var(--faint);text-align:right"
                >{{ age(r) }}</span
              >
              <span style="width:8px;flex:0 0 8px"
                ><span
                  style="width:7px;height:7px;border-radius:50%;background:var(--a500);display:inline-block"
                ></span
              ></span>
            </div>
          }
        </div>
      }
    </admin-shell>
  `,
})
export class NeedsMe {
  private router = inject(Router);
  private store = inject(Store);

  items = this.store.inbox;
  focusIdx = signal(0);
  typeShort = TYPE_SHORT;

  constructor() {
    effect(() => {
      const n = this.items().length;
      if (untracked(this.focusIdx) >= n) this.focusIdx.set(Math.max(0, n - 1));
    });
  }

  age(r: FactoryRequest) {
    return timeAgo(r.created_at);
  }
  /** Inbox rows hand off to the queue, selected on the same item — that's where the gate verbs live. */
  open(r: FactoryRequest) {
    this.router.navigate(['/admin/queue'], { queryParams: { sel: r.id } });
  }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    const cur = this.items()[this.focusIdx()];
    if (k === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.focusIdx.update((s) => Math.min(this.items().length - 1, s + 1));
    } else if (k === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.focusIdx.update((s) => Math.max(0, s - 1));
    } else if ((e.key === 'Enter' || k === 'a') && cur) {
      e.preventDefault();
      this.open(cur);
    }
  }
}
