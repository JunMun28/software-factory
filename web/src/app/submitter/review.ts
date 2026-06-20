import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { Api } from '../core/api.service';
import { RequestDetail } from '@sf/shared';
import { Session } from '../core/session.service';
import { Icon, TypeChip } from '../kit/kit';
import { IntakeDraft } from './intake-draft.service';
import { SubShell } from './sub-shell';

/** Review — the summary before submit, with Edit links back to each step. */
@Component({
  selector: 'sf-review',
  imports: [SubShell, Icon, TypeChip],
  template: `
    <sub-shell active="new" [step]="2" [reqId]="id">
      <div class="sub-col fade-in">
        <h1 style="font-size:28px">Review your request</h1>
        <p style="color:var(--muted);margin:6px 0 22px;font-size:16px">
          Here's what we'll send to the reviewer. Go back to any step to change it.
        </p>
        @if (req(); as r) {
          <div class="card" style="overflow:hidden">
            <div class="summ-row">
              <span class="summ-k">Type</span>
              <div class="summ-v"><sf-type-chip [t]="r.type" /></div>
              <button
                class="btn ghost sm"
                style="color:var(--accent-link)"
                (click)="go('/submit/new')"
              >
                Edit
              </button>
            </div>
            <div class="summ-row">
              <span class="summ-k">{{ r.type === 'new' ? 'App name' : 'App' }}</span>
              <div class="summ-v">{{ r.app_name }}</div>
              <span></span>
            </div>
            <div class="summ-row">
              <span class="summ-k">{{ descLabel(r) }}</span>
              <div class="summ-v">{{ r.description }}</div>
              <button
                class="btn ghost sm"
                style="color:var(--accent-link)"
                (click)="go('/submit/new')"
              >
                Edit
              </button>
            </div>
            @if (r.type !== 'bug') {
              <div class="summ-row">
                <span class="summ-k">Who's affected</span>
                <div class="summ-v">
                  @if (reachLabel(r.reach); as label) {
                    {{ label }}
                  } @else {
                    <span style="color:var(--muted)"
                      >Not specified — the reviewer will assume it's just you.</span
                    >
                  }
                </div>
                <button
                  class="btn ghost sm"
                  style="color:var(--accent-link)"
                  (click)="go('/submit/new')"
                >
                  Edit
                </button>
              </div>
              @if (impactLabel(r); as impact) {
                <div class="summ-row">
                  <span class="summ-k">Estimated impact</span>
                  <div class="summ-v">{{ impact }}</div>
                  <button
                    class="btn ghost sm"
                    style="color:var(--accent-link)"
                    (click)="go('/submit/new')"
                  >
                    Edit
                  </button>
                </div>
              }
            }
            @for (t of answered(r); track t.order) {
              <div class="summ-row">
                <span class="summ-k">{{ t.question }}</span>
                <div class="summ-v">{{ t.answer }}</div>
                <button
                  class="btn ghost sm"
                  style="color:var(--accent-link)"
                  (click)="go('/submit/' + id + '/interview')"
                >
                  Edit
                </button>
              </div>
            }
            @if (extra) {
              <div class="summ-row">
                <span class="summ-k">Extra details</span>
                <div class="summ-v">{{ extra }}</div>
                <span></span>
              </div>
            }
            <div class="summ-row" style="border-bottom:none">
              <span class="summ-k">Submitted by</span>
              <div class="summ-v">
                {{ session.user().name }}
                <span style="color:var(--muted)">· {{ session.user().email }}</span>
              </div>
              <span></span>
            </div>
          </div>
        }
        <div class="row" style="justify-content:space-between;margin-top:22px">
          <button class="btn ghost" (click)="go('/submit/' + id + '/interview')">
            <sf-icon name="back" [size]="16" /> Back
          </button>
          <button class="btn primary lg" [disabled]="submitting()" (click)="submit()">
            {{ submitting() ? 'Submitting…' : 'Submit request' }}
            <sf-icon name="arrowRight" [size]="16" />
          </button>
        </div>
      </div>
    </sub-shell>
  `,
  styles: `
    .summ-row {
      display: flex;
      gap: 16px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--hairline);
      align-items: flex-start;
    }
    .summ-k {
      width: 160px;
      flex: 0 0 160px;
      font-size: 13px;
      color: var(--muted);
      padding-top: 2px;
    }
    .summ-v {
      flex: 1;
      min-width: 0;
      font-size: 14.5px;
      color: var(--fg1);
      line-height: 1.5;
    }
  `,
})
export class Review {
  private api = inject(Api);
  private router = inject(Router);
  private draft = inject(IntakeDraft);
  session = inject(Session);
  id = Number(inject(ActivatedRoute).snapshot.paramMap.get('id'));
  extra = (history.state?.['extra'] as string) || '';

  req = signal<RequestDetail | null>(null);
  submitting = signal(false);

  constructor() {
    this.api.request(this.id).subscribe((r) => this.req.set(r));
  }

  descLabel(r: RequestDetail) {
    return {
      bug: "What's going wrong",
      new: 'What it should do',
      other: 'What you need',
      enh: 'What should change',
    }[r.type];
  }
  reachLabel(reach: RequestDetail['reach']) {
    if (!reach) return null;
    const canned: Record<string, string> = {
      me: 'Just me (1 person)',
      team: 'My team (under 10 people)',
      dept: 'My department (tens of people)',
      wider: 'Multiple departments (100+ people)',
      site: 'Whole site (hundreds of people)',
      network: 'Multiple sites across the network (1000+ people)',
    };
    return canned[reach] ?? reach;
  }
  impactLabel(r: RequestDetail) {
    if (!r.impact_metric || !r.impact_value) return null;
    return {
      hours: `${r.impact_value} man-hours saved / year`,
      cost: `${r.impact_value}k saved / year`,
      other: r.impact_value,
    }[r.impact_metric];
  }
  answered(r: RequestDetail) {
    return r.turns.filter((t) => t.answer);
  }
  go(url: string) {
    this.router.navigateByUrl(url);
  }

  submit() {
    this.submitting.set(true);
    this.api.submit(this.id, this.extra).subscribe({
      next: () => {
        this.draft.reset();
        this.router.navigateByUrl(`/submit/${this.id}/done`);
      },
      error: () => this.submitting.set(false),
    });
  }
}
