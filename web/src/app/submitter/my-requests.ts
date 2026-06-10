import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { FactoryRequest } from '../core/models';
import { Poll } from '../core/poll.service';
import { Session } from '../core/session.service';
import { Store } from '../core/store.service';
import { plainStage, timeAgo } from '../core/util';
import { Icon, Pill, Sig, TypeChip } from '../kit/kit';
import { SubShell } from './sub-shell';

/** S4 — My Requests: scoped to self, plain-stage vocabulary, one amber hero band. */
@Component({
  selector: 'sf-my-requests',
  imports: [SubShell, Icon, Pill, Sig, TypeChip],
  template: `
    <sub-shell active="list">
      <div class="sub-col fade-in">
        <div class="row" style="justify-content:space-between;align-items:flex-end;margin-bottom:18px">
          <h1 style="font-size:28px">My requests</h1>
          <button class="btn primary" (click)="go('/submit/new')"><sf-icon name="plus" [size]="16" /> New request</button>
        </div>
        <div class="row" style="gap:16px;margin-bottom:18px">
          <div class="seg">
            <button [class.on]="show() === 'active'" (click)="show.set('active')">Active</button>
            <button [class.on]="show() === 'all'" (click)="show.set('all')">All</button>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:11px">
          @for (r of needsInput(); track r.id) {
            <div class="attn lift fade-in" style="display:flex;flex-direction:column;gap:10px">
              <div class="row" style="gap:9px"><sf-sig tone="amber" glyph="flag">Needs your input</sf-sig><span style="font-size:12px;color:var(--amber-tx)">{{ needsInput().length }} request{{ needsInput().length > 1 ? 's' : '' }}</span></div>
              <div style="font-size:15.5px;font-weight:600;color:#3a2d10">{{ r.title }}</div>
              <div style="font-size:13.5px;color:var(--amber-tx)">The reviewer has a question before this can move on.</div>
              <div><button class="btn primary sm" (click)="go('/requests/' + r.id)">Respond <sf-icon name="arrowRight" [size]="15" /></button></div>
            </div>
          }
          @for (r of rows(); track r.id) {
            <button class="reqrow focusable" style="width:100%;text-align:left;font-family:inherit" (click)="go('/requests/' + r.id)">
              <div class="reqrow__main">
                <div class="reqrow__title" [class.strike]="r.status === 'cancelled'">{{ r.title }}</div>
                <div class="reqrow__meta"><sf-type-chip [t]="r.type" /><span>{{ r.app_name }} · {{ age(r) }}</span></div>
              </div>
              <sf-pill [tone]="ps(r).tone" [glyph]="ps(r).glyph" [fill]="ps(r).fill ?? 0.45">{{ ps(r).label }}</sf-pill>
            </button>
          } @empty {
            <div style="text-align:center;padding:30px;color:var(--faint);font-size:14px">Nothing here yet — file your first request.</div>
          }
          @if (rows().length) {
            <div style="text-align:center;font-size:13px;color:var(--faint);margin-top:8px">— That's everything —</div>
          }
        </div>
      </div>
    </sub-shell>
  `,
})
export class MyRequests {
  private router = inject(Router);
  private session = inject(Session);
  private poll = inject(Poll);
  private store = inject(Store);

  show = signal<'active' | 'all'>('active');
  all = computed(() => this.store.requests().filter((r) => r.reporter === this.session.user().name));

  needsInput = computed(() => this.all().filter((r) => r.status === 'sent_back'));
  rows = computed(() => {
    const base = this.all().filter((r) => r.status !== 'sent_back');
    if (this.show() === 'all') return base;
    return base.filter((r) => r.status !== 'cancelled' && r.status !== 'done');
  });

  constructor() {
    this.poll.start();
  }

  ps = plainStage;
  age(r: FactoryRequest) { return timeAgo(r.created_at); }
  go(url: string) { this.router.navigateByUrl(url); }
}
