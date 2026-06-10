import { Component, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { Api } from '../core/api.service';
import { FactoryRequest } from '../core/models';
import { Poll } from '../core/poll.service';
import { STAGE_LABEL, TYPE_SHORT, boardGlyph, gateLabel, timeAgo } from '../core/util';
import { Avatar, Glyph, Icon, Sig } from '../kit/kit';
import { AdminShell, ViewSeg } from './admin-shell';

interface Band { key: string; label: string; glyph: string; items: FactoryRequest[] }

/** C2b — List view: grouped by stage band; rows open the full-screen issue. */
@Component({
  selector: 'sf-list-page',
  imports: [AdminShell, Glyph, Icon, Avatar, Sig, ViewSeg],
  template: `
    <admin-shell active="list" title="Waiting on me">
      <span headerExtra class="row" style="gap:9px">
        <span style="font-size:12.5px;color:var(--muted)">Group: stage</span>
      </span>
      <sf-view-seg headerRight active="list" />
      <div class="list scroll">
        @for (band of bands(); track band.key) {
          <div class="lband">
            <sf-icon name="chevDown" [size]="14" color="var(--muted)" />
            <sf-glyph [type]="band.glyph" [size]="13" color="var(--muted)" />
            <span class="lband__name">{{ band.label }}</span>
            <span class="lband__count">{{ band.items.length }}</span>
          </div>
          @for (r of band.items; track r.id) {
            <div class="lrow" (click)="open(r)">
              <sf-glyph [type]="g(r).glyph" [size]="15" [color]="g(r).color" [fill]="g(r).fill" />
              <span class="lrow__title" [style.text-decoration]="r.status === 'cancelled' ? 'line-through' : ''">{{ r.title }}</span>
              <span class="chip">{{ typeShort[r.type] }}</span>
              <span class="lrow__app">{{ r.app_name }}</span>
              <span class="lrow__badge">
                @if (r.needs_human) { <sf-sig tone="red" glyph="flag">Needs human</sf-sig> }
                @else if (gateLbl(r)) { <sf-sig tone="amber">{{ gateLbl(r) === 'Approve spec' ? 'Approve' : gateLbl(r) }}</sf-sig> }
              </span>
              @if (r.assignee_initials) { <sf-avatar [sm]="true" [color]="r.assignee_color ?? '#7A6E9A'">{{ r.assignee_initials }}</sf-avatar> }
              @else { <span style="width:20px"></span> }
              <span class="lrow__stage">{{ stageLabel[r.stage] }}</span>
              <span class="lrow__age">{{ age(r) }}</span>
            </div>
          }
        }
      </div>
    </admin-shell>
  `,
})
export class ListView {
  private api = inject(Api);
  private router = inject(Router);
  private poll = inject(Poll);

  all = signal<FactoryRequest[]>([]);
  stageLabel = STAGE_LABEL;
  typeShort = TYPE_SHORT;

  constructor() {
    effect(() => {
      this.poll.version();
      this.api.requests().subscribe((rs) => this.all.set(rs));
    });
  }

  bands = computed<Band[]>(() => {
    const rs = this.all();
    const defs: Band[] = [
      { key: 'gates', label: 'Waiting on me · Gates', glyph: 'ring', items: rs.filter((r) => r.gate || r.needs_human) },
      { key: 'intake', label: 'Intake · Triage', glyph: 'dotted', items: rs.filter((r) => !r.gate && !r.needs_human && r.stage === 'intake' && r.status !== 'cancelled') },
      { key: 'flight', label: 'In flight · Building', glyph: 'ring', items: rs.filter((r) => !r.gate && !r.needs_human && ['architecture', 'build', 'review'].includes(r.stage)) },
      { key: 'back', label: 'Sent back · With the submitter', glyph: 'flag', items: rs.filter((r) => r.status === 'sent_back') },
      { key: 'done', label: 'Done · Deployed', glyph: 'check', items: rs.filter((r) => r.stage === 'done' && r.status === 'done') },
      { key: 'cancelled', label: 'Cancelled', glyph: 'strike', items: rs.filter((r) => r.status === 'cancelled') },
    ];
    // sent-back items also match no other band; gates band excludes sent_back already (gate is null there)
    return defs.filter((b) => b.items.length > 0);
  });

  g = boardGlyph;
  gateLbl = gateLabel;
  age(r: FactoryRequest) { return timeAgo(r.created_at); }
  open(r: FactoryRequest) { this.router.navigateByUrl(`/admin/issue/${r.id}`); }
}
