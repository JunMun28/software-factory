import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Api } from '../core/api.service';
import { Session } from '../core/session.service';

/** The submitter-flow store — survives step navigation (the design's subStore). */
@Injectable({ providedIn: 'root' })
export class IntakeDraft {
  private api = inject(Api);
  private session = inject(Session);

  requestId: number | null = null;
  type: 'bug' | 'enh' | 'new' | 'other' | null = null;
  title = '';
  desc = '';
  newName = '';
  bugWhere = '';
  bugFreq = '';
  urgency: 'low' | 'normal' | 'high' = 'normal';
  reach: 'me' | 'team' | 'dept' | 'wider' | 'site' | 'network' | null = null;
  reachText = '';
  impactMetric: 'hours' | 'cost' | 'other' | null = null;
  impactValue = '';
  appId: number | null = null;
  extra = '';

  reset() {
    this.requestId = null;
    this.type = null;
    this.title = this.desc = this.newName = this.bugWhere = this.bugFreq = this.extra = '';
    this.reachText = this.impactValue = '';
    this.urgency = 'normal';
    this.reach = this.impactMetric = null;
    this.appId = null;
  }

  /** Persist-first: create the Request on first Continue, PATCH on later edits. */
  async save(): Promise<number> {
    const u = this.session.user();
    const where = [this.bugWhere, this.bugFreq && `happens ${this.bugFreq.toLowerCase()}`]
      .filter(Boolean).join(' · ');
    const body = {
      type: this.type, title: this.title || this.autoTitle(), description: this.desc,
      app_id: this.type === 'bug' || this.type === 'enh' ? this.appId : null,
      new_app_name: this.type === 'new' ? this.newName || null : null,
      bug_where: where || null, urgency: this.urgency,
      reach: this.type === 'bug' ? null : this.reachText.trim() || this.reach,
      impact_metric: this.type !== 'bug' && this.impactMetric && this.impactValue.trim() ? this.impactMetric : null,
      impact_value: this.type !== 'bug' && this.impactMetric && this.impactValue.trim() ? this.impactValue.trim() : null,
      reporter: u.name, reporter_initials: u.initials,
    };
    if (this.requestId == null) {
      const r = await firstValueFrom(this.api.createRequest(body));
      this.requestId = r.id;
    } else {
      await firstValueFrom(this.api.updateRequest(this.requestId, body));
    }
    return this.requestId!;
  }

  private autoTitle(): string {
    const d = this.desc.trim();
    if (!d) return this.newName || '(untitled request)';
    const first = d.split(/[.!?\n]/)[0];
    return first.length > 64 ? first.slice(0, 61) + '…' : first;
  }
}
