import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Api, Attachment } from '@sf/shared';
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
  appName = ''; // combobox text — a typed name with no appId becomes new_app_name
  extra = '';

  readonly MAX_FILES = 5;
  readonly MAX_BYTES = 10 * 1024 * 1024;
  private readonly ACCEPT = /\.(png|jpe?g|gif|webp|txt|log|md|csv|pdf|docx|xlsx)$/i;

  attachments = signal<Attachment[]>([]);
  pending = signal<File[]>([]);
  lastError = signal('');

  private validate(f: File): string | null {
    if (!this.ACCEPT.test(f.name)) return `${f.name}: unsupported type`;
    if (f.size > this.MAX_BYTES) return `${f.name}: file too large (max 10 MB)`;
    return null;
  }

  async addFiles(files: File[], source: 'describe' | 'interview'): Promise<void> {
    this.lastError.set('');
    for (const f of files) {
      if (this.attachments().length + this.pending().length >= this.MAX_FILES) {
        this.lastError.set(`At most ${this.MAX_FILES} attachments`);
        return;
      }
      const err = this.validate(f);
      if (err) {
        this.lastError.set(err);
        continue;
      }
      if (this.requestId == null) {
        this.pending.update((p) => [...p, f]);
      } else {
        await this.uploadOne(this.requestId, f, source);
      }
    }
  }

  private async uploadOne(rid: number, f: File, source: 'describe' | 'interview'): Promise<void> {
    try {
      const att = await firstValueFrom(this.api.uploadAttachment(rid, f, source));
      this.attachments.update((a) => [...a, att]);
    } catch {
      this.lastError.set(`${f.name}: upload failed`);
    }
  }

  async uploadPending(rid: number): Promise<void> {
    const staged = this.pending();
    this.pending.set([]);
    for (const f of staged) await this.uploadOne(rid, f, 'describe');
  }

  removePending(index: number): void {
    this.pending.update((p) => p.filter((_, i) => i !== index));
  }

  async removeAttachment(aid: number): Promise<void> {
    if (this.requestId == null) return;
    await firstValueFrom(this.api.deleteAttachment(this.requestId, aid));
    this.attachments.update((a) => a.filter((x) => x.id !== aid));
  }

  async loadAttachments(rid: number): Promise<void> {
    const d = await firstValueFrom(this.api.request(rid));
    this.attachments.set(d.attachments ?? []);
  }

  reset() {
    this.requestId = null;
    this.type = null;
    this.title = this.desc = this.newName = this.bugWhere = this.bugFreq = this.extra = '';
    this.reachText = this.impactValue = '';
    this.urgency = 'normal';
    this.reach = this.impactMetric = null;
    this.appId = null;
    this.appName = '';
    this.attachments.set([]);
    this.pending.set([]);
    this.lastError.set('');
  }

  /** Persist-first: create the Request on first Continue, PATCH on later edits. */
  async save(): Promise<number> {
    const u = this.session.user();
    const where = [this.bugWhere, this.bugFreq && `happens ${this.bugFreq.toLowerCase()}`]
      .filter(Boolean)
      .join(' · ');
    const isAppReq = this.type === 'bug' || this.type === 'enh';
    const body = {
      type: this.type,
      title: this.title || this.autoTitle(),
      description: this.desc,
      app_id: isAppReq ? this.appId : null,
      // a known app sends app_id; a typed-but-unlisted app rides as new_app_name
      new_app_name:
        this.type === 'new'
          ? this.newName || null
          : isAppReq && this.appId == null
            ? this.appName.trim() || null
            : null,
      bug_where: where || null,
      urgency: this.urgency,
      reach: this.type === 'bug' ? null : this.reachText.trim() || this.reach,
      impact_metric:
        this.type !== 'bug' && this.impactMetric && this.impactValue.trim()
          ? this.impactMetric
          : null,
      impact_value:
        this.type !== 'bug' && this.impactMetric && this.impactValue.trim()
          ? this.impactValue.trim()
          : null,
      reporter: u.name,
      reporter_initials: u.initials,
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
