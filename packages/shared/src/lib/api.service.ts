import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import {
  AppEntry,
  Attachment,
  CommentItem,
  FactoryRequest,
  InterviewState,
  MissionOut,
  Operator,
  ProgressEvent,
  PrototypeAnnotation,
  PrototypeState,
  RequestDetail,
  ReviewSummary,
} from './models';

// same-origin in production (nginx proxies /api); the dev server proxies via proxy.conf.json
const BASE = '/api';

@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  health() {
    return this.http.get<{
      status: string;
      brain: string;
      runner: 'agent' | 'sim';
      cli: 'codex' | 'claude';
    }>(`${BASE}/health`);
  }
  apps(): Observable<AppEntry[]> {
    return this.http.get<AppEntry[]>(`${BASE}/apps`);
  }
  createApp(body: Partial<AppEntry>) {
    return this.http.post<AppEntry>(`${BASE}/apps`, body);
  }
  updateApp(id: number, body: Partial<AppEntry>) {
    return this.http.patch<AppEntry>(`${BASE}/apps/${id}`, body);
  }
  operators(): Observable<Operator[]> {
    return this.http.get<Operator[]>(`${BASE}/operators`);
  }
  createOperator(body: Pick<Operator, 'name' | 'initials' | 'hue' | 'email'>) {
    return this.http.post<Operator>(`${BASE}/operators`, body);
  }

  requests(opts: { mine?: string; active?: boolean } = {}): Observable<FactoryRequest[]> {
    const params: Record<string, string> = {};
    if (opts.mine) params['mine'] = opts.mine;
    if (opts.active) params['active'] = 'true';
    return this.http.get<FactoryRequest[]>(`${BASE}/requests`, { params });
  }
  request(id: number) {
    return this.http.get<RequestDetail>(`${BASE}/requests/${id}`);
  }
  createRequest(body: object) {
    return this.http.post<RequestDetail>(`${BASE}/requests`, body);
  }
  updateRequest(id: number, body: object) {
    return this.http.patch<RequestDetail>(`${BASE}/requests/${id}`, body);
  }
  uploadAttachment(rid: number, file: File, source: 'describe' | 'interview') {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('source', source);
    return this.http.post<Attachment>(`${BASE}/requests/${rid}/attachments`, fd);
  }
  deleteAttachment(rid: number, aid: number) {
    return this.http.delete<void>(`${BASE}/requests/${rid}/attachments/${aid}`);
  }
  attachmentRawUrl(aid: number) {
    return `${BASE}/attachments/${aid}/raw`;
  }
  interview(id: number, gen = true) {
    // gen=false reads state without kicking background pre-generation (the streaming
    // client reads first, then opens the SSE stream to drive the question itself).
    return this.http.get<InterviewState>(`${BASE}/requests/${id}/interview`, { params: { gen } });
  }
  /** SSE endpoint URL — the next question (via the CLI brain) streams in as it generates. */
  interviewStreamUrl(id: number) {
    return `${BASE}/requests/${id}/interview/stream`;
  }
  answer(id: number, body: { answer?: string; skip?: boolean }) {
    return this.http.post<InterviewState>(`${BASE}/requests/${id}/interview`, body);
  }
  /** "Add more detail" from Review: record a note and reopen the interview for a follow-up. */
  reopenInterview(id: number, note: string) {
    return this.http.post<InterviewState>(`${BASE}/requests/${id}/interview/reopen`, { note });
  }
  /** The AI-written Review summary. Returns `thinking:true` while it generates — poll. */
  summary(id: number) {
    return this.http.get<ReviewSummary>(`${BASE}/requests/${id}/summary`);
  }

  // ── Prototype step (new-app only) ──
  /** gen=false reads state without kicking the first draft (the streaming client reads first). */
  prototype(id: number, gen = true) {
    return this.http.get<PrototypeState>(`${BASE}/requests/${id}/prototype`, { params: { gen } });
  }
  /** SSE endpoint URL — the pending revision's prose preamble streams in as it generates. */
  prototypeStreamUrl(id: number) {
    return `${BASE}/requests/${id}/prototype/stream`;
  }
  /** A chat turn: an edit instruction, optionally scoped to one or more annotated elements. */
  instructPrototype(
    id: number,
    instruction: string,
    annotation: PrototypeAnnotation | PrototypeAnnotation[] | null = null,
  ) {
    return this.http.post<PrototypeState>(`${BASE}/requests/${id}/prototype`, {
      instruction,
      annotation,
    });
  }
  /** Soft-gate skip: advance to Review with no prototype attached. */
  skipPrototype(id: number) {
    return this.http.post<PrototypeState>(`${BASE}/requests/${id}/prototype/skip`, {});
  }
  /** Undo/restore: re-apply the revision at `order` as a new latest revision. */
  restorePrototype(id: number, order: number) {
    return this.http.post<PrototypeState>(`${BASE}/requests/${id}/prototype/restore`, { order });
  }
  submit(id: number, note = '') {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/submit`, { note });
  }
  approve(id: number, actorOrOperatorId: string | number, operatorId?: number) {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/approve`, {
      operator_id: typeof actorOrOperatorId === 'number' ? actorOrOperatorId : operatorId,
    });
  }
  sendBack(id: number, note: string, actorOrOperatorId: string | number, operatorId?: number) {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/send-back`, {
      note,
      operator_id: typeof actorOrOperatorId === 'number' ? actorOrOperatorId : operatorId,
    });
  }
  respond(id: number, note: string, actor: string) {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/respond`, { note, actor });
  }
  cancel(id: number, actorOrOperatorId: string | number, operatorId?: number) {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/cancel`, {
      operator_id: typeof actorOrOperatorId === 'number' ? actorOrOperatorId : operatorId,
    });
  }
  retry(id: number, actorOrOperatorId: string | number, note = '', operatorId?: number) {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/retry`, {
      note,
      operator_id: typeof actorOrOperatorId === 'number' ? actorOrOperatorId : operatorId,
    });
  }
  takeOver(id: number, actorOrOperatorId: string | number, note = '', operatorId?: number) {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/take-over`, {
      note,
      operator_id: typeof actorOrOperatorId === 'number' ? actorOrOperatorId : operatorId,
    });
  }
  sendBackToStage(
    id: number,
    stage: 'architecture' | 'build' | 'review',
    reason: string,
    actorOrOperatorId: string | number,
    operatorId?: number,
  ) {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/send-back-to-stage`, {
      stage,
      reason,
      operator_id: typeof actorOrOperatorId === 'number' ? actorOrOperatorId : operatorId,
    });
  }
  comment(
    id: number,
    body: string,
    authorOrOperatorId: string | number,
    _initials?: string,
    operatorId?: number,
  ) {
    return this.http.post<CommentItem>(`${BASE}/requests/${id}/comments`, {
      body,
      operator_id: typeof authorOrOperatorId === 'number' ? authorOrOperatorId : operatorId,
    });
  }
  comments(id: number) {
    return this.http.get<CommentItem[]>(`${BASE}/requests/${id}/comments`);
  }

  /** Where "now" is — new clients start polling from here, never replaying history. */
  eventsCursor() {
    return this.http.get<{ cursor: number }>(`${BASE}/events/cursor`);
  }

  events(
    opts: { after?: number; subject?: string; request_id?: number } = {},
  ): Observable<ProgressEvent[]> {
    const params: Record<string, string> = {};
    if (opts.after) params['after'] = String(opts.after);
    if (opts.subject) params['subject'] = opts.subject;
    if (opts.request_id) params['request_id'] = String(opts.request_id);
    return this.http.get<ProgressEvent[]>(`${BASE}/events`, { params });
  }
  subjectFeed(key: string, after = 0, limit = 100) {
    return this.http.get<{ items: ProgressEvent[]; cursor: number }>(
      `${BASE}/subjects/${key}/feed`,
      { params: { after: String(after), limit: String(limit) } },
    );
  }
  inbox() {
    return this.http.get<FactoryRequest[]>(`${BASE}/inbox`);
  }
  mission() {
    return this.http.get<MissionOut>(`${BASE}/mission`);
  }
  steer(id: number, note: string, actorOrOperatorId: string | number, operatorId?: number) {
    return this.http.post<{ id: number; status: string }>(`${BASE}/requests/${id}/steer`, {
      note,
      operator_id: typeof actorOrOperatorId === 'number' ? actorOrOperatorId : operatorId,
    });
  }
  trace(id: number, after = 0, limit = 200) {
    return this.http.get<{ items: ProgressEvent[]; cursor: number }>(
      `${BASE}/requests/${id}/trace`,
      { params: { after: String(after), limit: String(limit) } },
    );
  }
  tick() {
    return this.http.post<{ moved: string[] }>(`${BASE}/simulator/tick`, {});
  }
}
