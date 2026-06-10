import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { Api } from '../core/api.service';
import { AppEntry, CommentItem, FactoryRequest, ProgressEvent } from '../core/models';
import { Poll } from '../core/poll.service';
import { Session } from '../core/session.service';
import { clock, timeAgo, utc } from '../core/util';
import { Avatar, Glyph, Icon, Mark } from '../kit/kit';
import { AdminShell } from './admin-shell';

interface FeedMsg {
  bot: boolean;
  actor: string;
  initials: string;
  color: string;
  time: string;
  iso: string;
  cont: boolean;
  body: string;
  att?: { edge: string; glyph: string; fill: number; title: string; fields: [string, string][]; gate?: boolean; requestId?: number };
  folded?: number;
}

/** C5 — per-app progress feed: a Slack conversation where the Factory posts milestones. */
@Component({
  selector: 'sf-feed-page',
  imports: [AdminShell, Glyph, Icon, Mark, Avatar, FormsModule],
  template: `
    <admin-shell [active]="'feed:' + key" title="Apps">
      <div style="position:absolute;inset:0;display:flex;flex-direction:column">
        <!-- channel header -->
        <div class="row" style="gap:11px;padding:11px 22px;border-bottom:1px solid var(--border);background:var(--surface)">
          <span style="font:700 16px/1 var(--display)"># {{ app()?.name }}</span>
          @if (app()?.repo) { <span class="reflink">{{ app()?.repo }}</span> }
          <span class="row" style="margin-left:auto;gap:8px">
            <span class="row" style="margin-right:4px"><sf-avatar [sm]="true" color="#6E5A8A">KP</sf-avatar><sf-avatar [sm]="true" color="#7A6E9A">JD</sf-avatar><sf-avatar [sm]="true" color="#5A6E8A">RM</sf-avatar></span>
            <button class="btn ghost sm">Following: All <sf-icon name="chevDown" [size]="13" /></button>
          </span>
        </div>

        <div class="scroll" style="flex:1;overflow-y:auto;padding-bottom:6px">
          @for (group of grouped(); track group.day) {
            <div class="sday"><span class="sday__lbl">{{ group.day }}</span></div>
            @for (m of group.msgs; track m.iso + m.body) {
              <div class="smsg">
                <div class="smsg__actions">
                  <button class="smsg__act" title="React"><sf-icon name="spark" [size]="15" /></button>
                  <button class="smsg__act" title="Open"><sf-icon name="link" [size]="15" /></button>
                  <button class="smsg__act" title="More"><sf-icon name="more" [size]="15" /></button>
                </div>
                @if (m.cont) {
                  <div class="smsg__gutter">{{ m.time }}</div>
                } @else if (m.bot) {
                  <div class="smsg__av" style="background:#F2E6FA"><sf-mark [size]="18" /></div>
                } @else {
                  <div class="smsg__av" [style.background]="m.color">{{ m.initials }}</div>
                }
                <div style="flex:1;min-width:0">
                  @if (!m.cont) {
                    <div class="smsg__head">
                      <span class="smsg__name">{{ m.actor }}</span>
                      @if (m.bot) { <span class="smsg__bot">App</span> }
                      <span class="smsg__time">{{ m.time }}</span>
                    </div>
                  }
                  <div class="smsg__body">{{ m.body }}</div>
                  @if (m.att; as att) {
                    <div class="satt" [style.border-left-color]="att.edge">
                      <div class="satt__title"><sf-glyph [type]="att.glyph" [size]="14" [color]="att.edge" [fill]="att.fill" />{{ att.title }}</div>
                      @if (att.fields.length) {
                        <div class="satt__fields">
                          @for (f of att.fields; track f[0]) { <span class="satt__f"><span class="k">{{ f[0] }} </span>{{ f[1] }}</span> }
                        </div>
                      }
                      @if (att.gate && att.requestId) {
                        <div class="satt__foot">
                          <button class="btn primary sm" (click)="review(att.requestId)">Review &amp; approve</button>
                          <button class="btn sm" (click)="openIssue(att.requestId)">Open issue</button>
                        </div>
                      } @else if (att.requestId) {
                        <div class="satt__foot"><button class="btn ghost sm" (click)="openIssue(att.requestId)">Open issue</button></div>
                      }
                    </div>
                  }
                  @if (m.folded) {
                    <button class="row" style="gap:8px;margin-top:8px;padding:8px 12px;border:1px dashed var(--border-strong);border-radius:7px;background:none;cursor:pointer;font-family:inherit;font-size:12.5px;color:var(--muted);max-width:520px;width:100%">
                      <sf-icon name="chevRight" [size]="13" /> Retried {{ m.folded }}× <span style="color:var(--faint)">— folded, click to expand</span>
                    </button>
                  }
                </div>
              </div>
            }
          }
          <div style="text-align:center;font-size:11.5px;color:var(--faint);margin:14px 0 4px">You're all caught up</div>
        </div>

        <!-- composer -->
        <div class="scomposer">
          <div class="scomposer__bar">
            <button class="scomposer__ic" title="Bold"><span style="font-weight:700;font-size:13px">B</span></button>
            <button class="scomposer__ic" title="Italic"><span style="font-style:italic;font-size:13px">i</span></button>
            <button class="scomposer__ic" title="Link"><sf-icon name="link" [size]="15" /></button>
            <span style="width:1px;height:18px;background:var(--border);margin:0 4px"></span>
            <button class="scomposer__ic" title="Mention"><span style="font-size:14px;font-weight:600">&#64;</span></button>
            <button class="scomposer__ic" title="Attach"><sf-icon name="plus" [size]="16" /></button>
          </div>
          <div class="scomposer__row">
            <input class="scomposer__field" [placeholder]="'Message #' + (app()?.name ?? '')" [(ngModel)]="draft" (keydown.enter)="send()" />
            <button class="scomposer__ic" title="Send" (click)="send()"><sf-icon name="arrowRight" [size]="17" color="var(--accent)" /></button>
          </div>
        </div>
      </div>
    </admin-shell>
  `,
})
export class Feed {
  private api = inject(Api);
  private router = inject(Router);
  private session = inject(Session);
  private poll = inject(Poll);
  key = inject(ActivatedRoute).snapshot.paramMap.get('key')!;

  app = signal<AppEntry | null>(null);
  events = signal<ProgressEvent[]>([]);
  comments = signal<(CommentItem & { request_id: number })[]>([]);
  requests = signal<FactoryRequest[]>([]);
  draft = '';

  constructor() {
    effect(() => {
      this.poll.version();
      this.api.apps().subscribe((apps) => {
        const a = apps.find((x) => x.key === this.key) ?? null;
        this.app.set(a);
      });
      this.api.events({ subject: this.key }).subscribe((evs) => this.events.set(evs));
      this.api.requests().subscribe((rs) => {
        const mine = rs.filter((r) => r.app_key === this.key);
        this.requests.set(mine);
        for (const r of mine) {
          this.api.comments(r.id).subscribe((cs) =>
            this.comments.update((prev) => {
              const others = prev.filter((c) => c.request_id !== r.id);
              return [...others, ...cs.map((c) => ({ ...c, request_id: r.id }))];
            }),
          );
        }
      });
    });
  }

  grouped = computed(() => {
    const evs = this.events();
    const msgs: FeedMsg[] = evs.map((e) => this.toMsg(e));
    for (const c of this.comments()) {
      msgs.push({
        bot: false, actor: c.author, initials: c.initials, color: c.color,
        time: clock(c.created_at), iso: c.created_at, cont: false, body: c.body,
      });
    }
    msgs.sort((a, b) => a.iso.localeCompare(b.iso));
    // group consecutive bot messages (Slack continuation)
    for (let i = 1; i < msgs.length; i++) {
      if (msgs[i].bot && msgs[i - 1].bot && msgs[i].iso.slice(0, 10) === msgs[i - 1].iso.slice(0, 10)) msgs[i].cont = true;
    }
    const days = new Map<string, FeedMsg[]>();
    const today = new Date().toDateString();
    const yest = new Date(Date.now() - 864e5).toDateString();
    for (const m of msgs) {
      const d = utc(m.iso).toDateString();
      const label = d === today ? 'Today' : d === yest ? 'Yesterday' : utc(m.iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
      if (!days.has(label)) days.set(label, []);
      days.get(label)!.push(m);
    }
    return [...days.entries()].map(([day, list]) => ({ day, msgs: list }));
  });

  private toMsg(e: ProgressEvent): FeedMsg {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const rawFields = (p['fields'] ?? {}) as Record<string, string>;
    const fields: [string, string][] = Object.entries(rawFields);
    if (e.request_ref) fields.push(['Ref', e.request_ref]);
    const edge = e.kind === 'escalation' ? 'var(--red)'
      : e.kind === 'gate_event' ? 'var(--amber)'
      : e.stage === 'done' ? 'var(--green)'
      : e.stage === 'intake' ? '#9A9AA6' : 'var(--a500)';
    const glyph = e.kind === 'escalation' ? 'flag' : e.stage === 'done' ? 'check' : e.stage === 'intake' ? 'dotted' : 'ring';
    return {
      bot: e.bot, actor: e.bot ? 'Factory' : e.actor,
      initials: e.actor.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase(),
      color: '#6E5A8A', time: clock(e.created_at), iso: e.created_at, cont: false,
      body: e.title,
      att: e.request_title ? {
        edge, glyph, fill: 0.4, title: e.request_title, fields,
        gate: e.kind === 'gate_event' && (p['gate'] === 'approve_spec' || p['gate'] === 'approve_merge'),
        requestId: e.request_id ?? undefined,
      } : undefined,
      folded: typeof p['folded'] === 'number' ? (p['folded'] as number) : undefined,
    };
  }

  send() {
    const text = this.draft.trim();
    if (!text) return;
    // comment lands on the app's most recent active request (the thread root)
    const target = this.requests().find((r) => !['done', 'cancelled'].includes(r.status)) ?? this.requests()[0];
    if (!target) return;
    const u = this.session.user();
    this.api.comment(target.id, text, u.name, u.initials).subscribe(() => {
      this.draft = '';
      this.poll.nudge();
    });
  }
  review(id: number) { this.router.navigateByUrl('/admin/queue'); }
  openIssue(id: number) { this.router.navigateByUrl(`/admin/issue/${id}`); }
}
