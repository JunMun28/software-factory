import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import {
  AppDeploy,
  AppEntry,
  AppRollback,
  AppSubscription,
  Attachment,
  ClassifyResult,
  CommentItem,
  DraftRequest,
  FactoryRequest,
  Health,
  InterviewState,
  MissionOut,
  Operator,
  PreviewStatus,
  ProgressEvent,
  PrototypeAnnotation,
  PrototypeState,
  RequestDetail,
  ReviewSummary,
  RollbackEnqueue,
} from './models';

// same-origin in production (nginx proxies /api); the dev server proxies via proxy.conf.json
const BASE = '/api';

@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  health(): Observable<Health> {
    return this.http.get<Health>(`${BASE}/health`);
  }
  apps(): Observable<AppEntry[]> {
    return this.http.get<AppEntry[]>(`${BASE}/apps`);
  }
  appDeploys(appId: number) {
    return this.http.get<AppDeploy[]>(`${BASE}/apps/${appId}/deploys`);
  }
  appRollbacks(appId: number) {
    return this.http.get<AppRollback[]>(`${BASE}/apps/${appId}/rollbacks`);
  }
  /** Queue a previously-live digest for re-apply; poll appRollbacks for completion. */
  rollbackApp(appId: number, digest: string, operatorId: number) {
    return this.http.post<RollbackEnqueue>(`${BASE}/apps/${appId}/rollback`, {
      digest,
      operator_id: operatorId,
    });
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
  /** SEC-01: who the auth wall says I am. operator is null when auth is off
   *  or the token has no console role. */
  authMe(): Observable<{ mode: string; operator: Operator | null }> {
    return this.http.get<{ mode: string; operator: Operator | null }>(`${BASE}/auth/me`);
  }
  /** Structured human NO at the architecture/merge/deploy gate. For the
   *  architecture gate this IS the refine loop: the reason reaches the agent
   *  as feedback and a revised plan comes back to the gate (E2E-3). */
  rejectGate(id: number, operatorId: number, reasonCode: string, reason: string) {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/reject-gate`, {
      operator_id: operatorId,
      reason_code: reasonCode,
      reason,
    });
  }
  /** C1 preview loop (E2E-5 surfaces): live URL, round, feedback history. */
  previewStatus(id: number): Observable<PreviewStatus> {
    return this.http.get<PreviewStatus>(`${BASE}/requests/${id}/preview`);
  }
  /** Requester accepts the preview → merge gate. actor = display name when
   *  called from the intake app (no operator identity needed). */
  previewAccept(id: number, actor?: string) {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/preview/accept`, {
      actor: actor ?? null,
    });
  }
  /** Requester asks for changes → the pipeline rewinds to architecture with
   *  the feedback riding into the next round. */
  previewRequestChanges(id: number, feedback: string, actor?: string, pagePath?: string) {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/preview/request-changes`, {
      feedback,
      actor: actor ?? null,
      page_path: pagePath ?? null,
    });
  }
  createOperator(body: Pick<Operator, 'name' | 'initials' | 'hue' | 'email'>) {
    return this.http.post<Operator>(`${BASE}/operators`, body);
  }
  operatorSubscriptions(operatorId: number) {
    return this.http.get<AppSubscription[]>(`${BASE}/operators/${operatorId}/subscriptions`);
  }
  updateOperatorSubscription(operatorId: number, appId: number, subscribed: boolean) {
    return this.http.put<AppSubscription>(
      `${BASE}/operators/${operatorId}/subscriptions/${appId}`,
      { subscribed },
    );
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
  /** Intakes this person started and did not finish. `requests()` hides drafts on
   *  purpose; this is the only way back to one after the tab is gone. */
  draftRequests(mine?: string): Observable<DraftRequest[]> {
    const params: Record<string, string> = {};
    if (mine) params['mine'] = mine;
    return this.http.get<DraftRequest[]>(`${BASE}/requests/drafts`, { params });
  }
  createRequest(body: object) {
    return this.http.post<RequestDetail>(`${BASE}/requests`, body);
  }
  classify(description: string, requestId?: number): Observable<ClassifyResult> {
    return this.http.post<ClassifyResult>(`${BASE}/requests/classify`, {
      description,
      ...(requestId == null ? {} : { request_id: requestId }),
    });
  }
  classification(id: number): Observable<ClassifyResult> {
    return this.http.get<ClassifyResult>(`${BASE}/requests/${id}/classify`);
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
  /** Consent on a mid-interview type-change proposal (ADR 0023). Accept PATCHes the type
   *  (lossless — the draft's other facts persist); decline records and continues. */
  escalate(id: number, accept: boolean, toType: string) {
    return this.http.post<InterviewState>(`${BASE}/requests/${id}/interview/escalate`, {
      accept,
      to_type: toType,
    });
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
    return this.http.get<{ cursor: number; revision: number }>(`${BASE}/events/cursor`);
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
