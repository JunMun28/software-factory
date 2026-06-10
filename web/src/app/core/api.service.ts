import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { AppEntry, CommentItem, FactoryRequest, InterviewState, ProgressEvent, RequestDetail } from './models';

// same-origin in production (nginx proxies /api); the dev server proxies via proxy.conf.json
const BASE = '/api';

@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  health() { return this.http.get<{ status: string; brain: string; runner: string }>(`${BASE}/health`); }
  apps(): Observable<AppEntry[]> { return this.http.get<AppEntry[]>(`${BASE}/apps`); }
  createApp(body: Partial<AppEntry>) { return this.http.post<AppEntry>(`${BASE}/apps`, body); }
  updateApp(id: number, body: Partial<AppEntry>) { return this.http.patch<AppEntry>(`${BASE}/apps/${id}`, body); }

  requests(opts: { mine?: string; active?: boolean } = {}): Observable<FactoryRequest[]> {
    const params: Record<string, string> = {};
    if (opts.mine) params['mine'] = opts.mine;
    if (opts.active) params['active'] = 'true';
    return this.http.get<FactoryRequest[]>(`${BASE}/requests`, { params });
  }
  request(id: number) { return this.http.get<RequestDetail>(`${BASE}/requests/${id}`); }
  createRequest(body: object) { return this.http.post<RequestDetail>(`${BASE}/requests`, body); }
  updateRequest(id: number, body: object) { return this.http.patch<RequestDetail>(`${BASE}/requests/${id}`, body); }
  interview(id: number) { return this.http.get<InterviewState>(`${BASE}/requests/${id}/interview`); }
  answer(id: number, body: { answer?: string; skip?: boolean }) {
    return this.http.post<InterviewState>(`${BASE}/requests/${id}/interview`, body);
  }
  submit(id: number, note = '') { return this.http.post<RequestDetail>(`${BASE}/requests/${id}/submit`, { note }); }
  approve(id: number, actor: string) { return this.http.post<RequestDetail>(`${BASE}/requests/${id}/approve`, { actor }); }
  sendBack(id: number, note: string, actor: string) {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/send-back`, { note, actor });
  }
  respond(id: number, note: string, actor: string) {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/respond`, { note, actor });
  }
  cancel(id: number, actor: string) { return this.http.post<RequestDetail>(`${BASE}/requests/${id}/cancel`, { actor }); }
  retry(id: number, actor: string, note = '') { return this.http.post<RequestDetail>(`${BASE}/requests/${id}/retry`, { note, actor }); }
  comment(id: number, body: string, author: string, initials: string) {
    return this.http.post<CommentItem>(`${BASE}/requests/${id}/comments`, { body, author, initials });
  }
  comments(id: number) { return this.http.get<CommentItem[]>(`${BASE}/requests/${id}/comments`); }

  /** Where "now" is — new clients start polling from here, never replaying history. */
  eventsCursor() { return this.http.get<{ cursor: number }>(`${BASE}/events/cursor`); }

  events(opts: { after?: number; subject?: string; request_id?: number } = {}): Observable<ProgressEvent[]> {
    const params: Record<string, string> = {};
    if (opts.after) params['after'] = String(opts.after);
    if (opts.subject) params['subject'] = opts.subject;
    if (opts.request_id) params['request_id'] = String(opts.request_id);
    return this.http.get<ProgressEvent[]>(`${BASE}/events`, { params });
  }
  subjectFeed(key: string, after = 0, limit = 100) {
    return this.http.get<{ items: ProgressEvent[]; cursor: number }>(
      `${BASE}/subjects/${key}/feed`, { params: { after: String(after), limit: String(limit) } });
  }
  inbox() { return this.http.get<FactoryRequest[]>(`${BASE}/inbox`); }
  tick() { return this.http.post<{ moved: string[] }>(`${BASE}/simulator/tick`, {}); }
}
