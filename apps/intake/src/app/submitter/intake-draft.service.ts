import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Api, Attachment, RequestDetail } from '@sf/shared';
import { Session } from '../core/session.service';

/** The submitter-flow store — survives step navigation (the design's subStore). */
@Injectable({ providedIn: 'root' })
export class IntakeDraft {
  private api = inject(Api);
  private session = inject(Session);

  requestId: number | null = null;
  type: 'bug' | 'enh' | 'new' | 'other' | null = null;
  /** confidence in the inferred type (0–1); <0.5 opens the type cards. Session-only,
   *  not persisted — a reload defaults to confident (the stored type is authoritative). */
  typeConfidence = 1;
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
  readonly MAX_BYTES = 100 * 1024 * 1024; // any file type, capped by size only

  attachments = signal<Attachment[]>([]);
  pending = signal<File[]>([]);
  lastError = signal('');

  private validate(f: File): string | null {
    if (f.size > this.MAX_BYTES) return `${f.name}: file too large (max 100 MB)`;
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
    this.hydrateFrom(d);
    this.attachments.set(d.attachments ?? []);
  }

  /** Re-populate the describe fields from a persisted request so a later step
   *  (Clarify/Review) can step back to Describe after the in-memory draft was
   *  lost — e.g. a page reload wipes this root singleton. Always records the
   *  requestId; only refills the fields when the draft is empty, so it never
   *  clobbers edits made in the current session. */
  hydrateFrom(d: RequestDetail): void {
    this.requestId = d.id;
    if (this.type != null) return; // draft is live — keep the user's edits
    this.type = d.type;
    this.title = d.title;
    this.desc = d.description;
    this.urgency = (d.urgency as 'low' | 'normal' | 'high') || 'normal';
    this.appId = d.app_id;
    this.appName = d.app_name || d.new_app_name || '';
    this.newName = d.type === 'new' ? (d.new_app_name ?? '') : '';
    const CHIPS = ['me', 'team', 'dept', 'wider', 'site', 'network'];
    if (d.reach && CHIPS.includes(d.reach)) {
      this.reach = d.reach as typeof this.reach;
      this.reachText = '';
    } else {
      this.reach = null;
      this.reachText = d.reach ?? '';
    }
    this.impactMetric = d.impact_metric;
    this.impactValue = d.impact_value ?? '';
    if (d.bug_where) {
      // save() stores "<where> · happens <freq lowercased>" — split it back apart
      const [where, freq] = d.bug_where.split(' · happens ');
      this.bugWhere = where === 'Screenshot attached' ? '' : (where ?? '');
      const FREQS = ['Every time', 'Most of the time', 'Sometimes', 'Only once so far'];
      this.bugFreq = freq ? (FREQS.find((f) => f.toLowerCase() === freq) ?? '') : '';
    }
  }

  reset() {
    this.requestId = null;
    this.type = null;
    this.typeConfidence = 1;
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
    const bugEvidence =
      this.bugWhere.trim() ||
      (this.attachments().some((a) => a.kind === 'image') ? 'Screenshot attached' : '');
    const where = [bugEvidence, this.bugFreq && `happens ${this.bugFreq.toLowerCase()}`]
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
