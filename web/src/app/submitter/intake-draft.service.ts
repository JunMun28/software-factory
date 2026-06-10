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
  appId: number | null = null;
  extra = '';

  reset() {
    this.requestId = null;
    this.type = null;
    this.title = this.desc = this.newName = this.bugWhere = this.bugFreq = this.extra = '';
    this.urgency = 'normal';
    this.appId = null;
  }

  /** Persist-first: create the Request on first Continue, PATCH on later edits. */
  async save(): Promise<number> {
    const u = this.session.user();
    const where = [this.bugWhere, this.bugFreq && `happens ${this.bugFreq.toLowerCase()}`]
      .filter(Boolean).join(' · ');
    const body = {
      type: this.type, title: this.title || this.autoTitle(), description: this.desc,
      app_id: this.type === 'new' ? null : this.appId, new_app_name: this.type === 'new' ? this.newName || null : null,
      bug_where: where || null, urgency: this.urgency,
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
