import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';

import {
  Api,
  Avatar,
  Glyph,
  Icon,
  Mark,
  Poll,
  PopMenu,
  ProgressEvent,
  clock,
  timeAgo,
  utc,
} from '@sf/shared';
import { Session } from '../core/session.service';
import { Store } from '../core/store.service';
import { AdminShell } from './admin-shell';

interface FeedMsg {
  id: number;
  bot: boolean;
  actor: string;
  initials: string;
  color: string;
  time: string;
  iso: string;
  cont: boolean;
  body: string;
  pending?: boolean;
  att?: {
    edge: string;
    glyph: string;
    fill: number;
    title: string;
    fields: [string, string][];
    gate?: boolean;
    requestId?: number;
  };
  folded?: number;
}

/** C5 — per-app progress feed.
 *
 *  Production data path (ADR 0012): one initial tail page from
 *  /api/subjects/{key}/feed, then ONLY the poll loop's per-tick delta is
 *  appended (id-deduped) — no per-tick refetch, no N+1 comment calls.
 *  Comments ride the same event log (kind=comment), so other admins'
 *  messages arrive through the identical cursor. */
@Component({
  selector: 'sf-feed-page',
  imports: [AdminShell, Glyph, Icon, Mark, Avatar, FormsModule, PopMenu],
  template: `
    <admin-shell [active]="'feed:' + key()" title="Apps">
      <div style="position:absolute;inset:0;display:flex;flex-direction:column">
        <!-- channel header -->
        <div
          class="row"
          style="gap:11px;padding:11px 22px;border-bottom:1px solid var(--border);background:var(--surface)"
        >
          <span style="font:700 16px/1 var(--display)"># {{ app()?.name }}</span>
          @if (app()?.repo) {
            <span class="reflink">{{ app()?.repo }}</span>
          }
          <span class="row" style="margin-left:auto;gap:8px">
            <span
              class="row"
              style="margin-right:4px"
              [title]="'People on this channel’s requests'"
            >
              @for (m of members(); track m.initials) {
                <sf-avatar [sm]="true" [color]="m.color">{{ m.initials }}</sf-avatar>
              }
            </span>
            <span style="position:relative">
              <button class="btn ghost sm" (click)="followOpen = !followOpen">
                Following: {{ follow() }} <sf-icon name="chevDown" [size]="13" />
              </button>
              <sf-pop-menu [open]="followOpen" [width]="200" (closed)="followOpen = false">
                @for (lvl of followLevels; track lvl) {
                  <button class="pop__opt" [class.on]="follow() === lvl" (click)="setFollow(lvl)">
                    <span style="flex:1">{{ lvl }}</span>
                    @if (follow() === lvl) {
                      <sf-icon name="check" [size]="14" color="var(--a600)" />
                    }
                  </button>
                }
              </sf-pop-menu>
            </span>
          </span>
        </div>

        <div
          #scroller
          class="scroll"
          style="flex:1;overflow-y:auto;padding-bottom:6px;position:relative"
          (scroll)="onScroll()"
        >
          @for (group of grouped(); track group.day) {
            <div class="sday">
              <span class="sday__lbl">{{ group.day }}</span>
            </div>
            @for (m of group.msgs; track m.id) {
              <div class="smsg" [style.opacity]="m.pending ? 0.55 : 1">
                <div class="smsg__actions">
                  <button class="smsg__act" title="React">
                    <sf-icon name="spark" [size]="15" />
                  </button>
                  <button class="smsg__act" title="Open">
                    <sf-icon name="link" [size]="15" />
                  </button>
                  <button class="smsg__act" title="More">
                    <sf-icon name="more" [size]="15" />
                  </button>
                </div>
                @if (m.cont) {
                  <div class="smsg__gutter">{{ m.time }}</div>
                } @else if (m.bot) {
                  <div class="smsg__av" style="background:var(--accent-tint)">
                    <sf-mark [size]="18" />
                  </div>
                } @else {
                  <div class="smsg__av" [style.background]="m.color">{{ m.initials }}</div>
                }
                <div style="flex:1;min-width:0">
                  @if (!m.cont) {
                    <div class="smsg__head">
                      <span class="smsg__name">{{ m.actor }}</span>
                      @if (m.bot) {
                        <span class="smsg__bot">App</span>
                      }
                      <span class="smsg__time">{{ m.pending ? 'sending…' : m.time }}</span>
                    </div>
                  }
                  <div class="smsg__body">{{ m.body }}</div>
                  @if (m.att; as att) {
                    <div class="satt" [style.border-left-color]="att.edge">
                      <div class="satt__title">
                        <sf-glyph
                          [type]="att.glyph"
                          [size]="14"
                          [color]="att.edge"
                          [fill]="att.fill"
                        />{{ att.title }}
                      </div>
                      @if (att.fields.length) {
                        <div class="satt__fields">
                          @for (f of att.fields; track f[0]) {
                            <span class="satt__f"
                              ><span class="k">{{ f[0] }} </span>{{ f[1] }}</span
                            >
                          }
                        </div>
                      }
                      @if (att.gate && att.requestId) {
                        <div class="satt__foot">
                          <button class="btn primary sm" (click)="review(att.requestId)">
                            Review &amp; approve
                          </button>
                          <button class="btn sm" (click)="openIssue(att.requestId)">
                            Open issue
                          </button>
                        </div>
                      } @else if (att.requestId) {
                        <div class="satt__foot">
                          <button class="btn ghost sm" (click)="openIssue(att.requestId)">
                            Open issue
                          </button>
                        </div>
                      }
                    </div>
                  }
                  @if (m.folded) {
                    <button
                      class="row"
                      style="gap:8px;margin-top:8px;padding:8px 12px;border:1px dashed var(--border-strong);border-radius:7px;background:none;cursor:pointer;font-family:inherit;font-size:12.5px;color:var(--muted);max-width:520px;width:100%"
                    >
                      <sf-icon name="chevRight" [size]="13" /> Retried {{ m.folded }}×
                      <span style="color:var(--faint)">— folded, click to expand</span>
                    </button>
                  }
                </div>
              </div>
            }
          }
          <div style="text-align:center;font-size:11.5px;color:var(--faint);margin:14px 0 4px">
            You're all caught up
          </div>
        </div>

        @if (showJump()) {
          <div style="position:relative">
            <button
              class="btn sm"
              style="position:absolute;left:50%;transform:translateX(-50%);top:-44px;z-index:5;box-shadow:var(--shadow-pop);border-radius:999px"
              (click)="jumpToLatest()"
            >
              New messages <sf-icon name="chevDown" [size]="13" />
            </button>
          </div>
        }

        <!-- composer -->
        <div class="scomposer">
          <div class="scomposer__row">
            <input
              class="scomposer__field"
              [placeholder]="'Message #' + (app()?.name ?? '')"
              [(ngModel)]="draft"
              (keydown.enter)="send()"
            />
            <button class="scomposer__ic" title="Send" (click)="send()">
              <sf-icon name="arrowRight" [size]="17" color="var(--accent)" />
            </button>
          </div>
          @if (target(); as t) {
            <div style="padding:0 13px 8px;font-size:11px;color:var(--faint)">
              Posts as a comment on <span class="mono" style="font-size:10.5px">{{ t.ref }}</span>
              {{ t.title }}
            </div>
          }
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
  private store = inject(Store);
  private route = inject(ActivatedRoute);
  key = toSignal(this.route.paramMap.pipe(map((p) => p.get('key')!)), {
    initialValue: this.route.snapshot.paramMap.get('key')!,
  });

  private scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  // header context (app, members, composer target) comes from the shared store —
  // the feed body itself stays delta-fed and never refetches (ADR 0012/0013)
  app = computed(() => this.store.apps().find((x) => x.key === this.key()) ?? null);
  items = signal<ProgressEvent[]>([]);
  requests = computed(() => this.store.requests().filter((r) => r.app_key === this.key()));
  pending = signal<FeedMsg | null>(null);
  showJump = signal(false);
  draft = '';
  followOpen = false;
  followLevels = ['All', 'Gate + Needs-human', 'Muted'];
  follow = signal('All');

  /** The follow level is a view filter over the delta-fed log — seen/cursor
   *  bookkeeping stays on items() so switching levels never refetches.
   *  All = everything · Gate + Needs-human = gate/escalation/recovery events
   *  plus human comments · Muted = bot events hidden, human comments kept. */
  private visible = computed(() => {
    const lvl = this.follow();
    const items = this.items();
    if (lvl === 'Gate + Needs-human') {
      return items.filter(
        (e) =>
          ['gate_event', 'escalation', 'recovery_action'].includes(e.kind) || e.kind === 'comment',
      );
    }
    if (lvl === 'Muted') return items.filter((e) => !e.bot);
    return items;
  });

  private seen = new Set<number>();
  private atBottom = true;
  private pendingCommentId: number | null = null;

  constructor() {
    let lastKey: string | null = null;

    // reload feed whenever the channel key changes; reset all per-channel state
    effect(() => {
      const key = this.key();
      if (key !== lastKey) {
        lastKey = key;
        this.items.set([]);
        this.pending.set(null);
        this.showJump.set(false);
        this.seen.clear();
        this.atBottom = true;
        this.pendingCommentId = null;
        this.draft = '';
        this.followOpen = false;
        this.follow.set(localStorage.getItem(`sf-follow-${key}`) ?? 'All');
        // one-time tail load for the new channel; afterwards only deltas arrive
        this.api.subjectFeed(key).subscribe((page) => {
          page.items.forEach((e) => this.seen.add(e.id));
          this.items.set(page.items);
          queueMicrotask(() => this.scrollToBottom());
        });
      }
    });

    // the poll loop's delta IS the update path — no refetching
    // Firehose guard (ADR 0014): mirrors backend TRACE_ONLY_KINDS — step-level
    // events belong only in the per-request trace, not in the channel feed.
    const TRACE_ONLY_KINDS = new Set(['step_summary', 'steer_note', 'verification']);
    effect(() => {
      const delta = this.poll.delta();
      const appId = this.app()?.id;
      if (!appId || !delta.length) return;
      const fresh = delta.filter(
        (e) => e.subject_id === appId && !this.seen.has(e.id) && !TRACE_ONLY_KINDS.has(e.kind),
      );
      if (!fresh.length) return;
      fresh.forEach((e) => this.seen.add(e.id));
      if (
        this.pendingCommentId != null &&
        fresh.some(
          (e) =>
            e.kind === 'comment' && (e.payload?.['comment_id'] as number) === this.pendingCommentId,
        )
      ) {
        this.pending.set(null);
        this.pendingCommentId = null;
      }
      this.items.update((list) => [...list, ...fresh]);
      queueMicrotask(() => (this.atBottom ? this.scrollToBottom() : this.showJump.set(true)));
    });
  }

  /** People actually on this channel's requests (reporters). */
  members = computed(() => {
    const seen = new Map<string, { initials: string; color: string }>();
    for (const r of this.requests()) {
      if (r.reporter_initials)
        seen.set(r.reporter_initials, { initials: r.reporter_initials, color: 'var(--avatar)' });
    }
    return [...seen.values()].slice(0, 3);
  });

  target = computed(
    () =>
      this.requests().find((r) => !['done', 'cancelled'].includes(r.status)) ??
      this.requests()[0] ??
      null,
  );

  grouped = computed(() => {
    const msgs: FeedMsg[] = this.visible().map((e) => this.toMsg(e));
    const p = this.pending();
    if (p) msgs.push(p);
    msgs.sort((a, b) => a.iso.localeCompare(b.iso));
    for (let i = 1; i < msgs.length; i++) {
      msgs[i].cont =
        msgs[i].bot &&
        msgs[i - 1].bot &&
        utc(msgs[i].iso).toDateString() === utc(msgs[i - 1].iso).toDateString();
    }
    const days = new Map<string, FeedMsg[]>();
    const today = new Date().toDateString();
    const yest = new Date(Date.now() - 864e5).toDateString();
    for (const m of msgs) {
      const d = utc(m.iso).toDateString();
      const label =
        d === today
          ? 'Today'
          : d === yest
            ? 'Yesterday'
            : utc(m.iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
      if (!days.has(label)) days.set(label, []);
      days.get(label)!.push(m);
    }
    return [...days.entries()].map(([day, list]) => ({ day, msgs: list }));
  });

  private toMsg(e: ProgressEvent): FeedMsg {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.kind === 'comment') {
      return {
        id: e.id,
        bot: false,
        actor: e.actor,
        initials:
          (p['initials'] as string) ??
          e.actor
            .split(' ')
            .map((w) => w[0])
            .join('')
            .slice(0, 2)
            .toUpperCase(),
        color: (p['color'] as string) ?? 'var(--avatar)',
        time: clock(e.created_at),
        iso: e.created_at,
        cont: false,
        body: (p['body'] as string) ?? e.title,
      };
    }
    const rawFields = (p['fields'] ?? {}) as Record<string, string>;
    const fields: [string, string][] = Object.entries(rawFields);
    if (e.request_ref) fields.push(['Ref', e.request_ref]);
    const edge =
      e.kind === 'escalation'
        ? 'var(--red)'
        : e.kind === 'gate_event'
          ? 'var(--amber)'
          : e.stage === 'done'
            ? 'var(--green)'
            : e.stage === 'intake'
              ? '#9A9AA6'
              : 'var(--a500)';
    const glyph =
      e.kind === 'escalation'
        ? 'flag'
        : e.stage === 'done'
          ? 'check'
          : e.stage === 'intake'
            ? 'dotted'
            : 'ring';
    return {
      id: e.id,
      bot: e.bot,
      actor: e.bot ? 'Factory' : e.actor,
      initials: e.actor
        .split(' ')
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase(),
      color: 'var(--avatar)',
      time: clock(e.created_at),
      iso: e.created_at,
      cont: false,
      body: e.title,
      att: e.request_title
        ? {
            edge,
            glyph,
            fill: 0.4,
            title: e.request_title,
            fields,
            gate:
              e.kind === 'gate_event' &&
              (p['gate'] === 'approve_spec' || p['gate'] === 'approve_merge'),
            requestId: e.request_id ?? undefined,
          }
        : undefined,
      folded: typeof p['folded'] === 'number' ? (p['folded'] as number) : undefined,
    };
  }

  // ---- scroll behavior: stick to bottom, never yank a reader ----
  onScroll() {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    this.atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 150;
    if (this.atBottom) this.showJump.set(false);
  }
  private scrollToBottom() {
    const el = this.scroller()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
    this.atBottom = true;
    this.showJump.set(false);
  }
  jumpToLatest() {
    this.scrollToBottom();
  }

  // ---- optimistic send ----
  send() {
    const text = this.draft.trim();
    const target = this.target();
    if (!text || !target || this.pending()) return;
    const u = this.session.user();
    const sentKey = this.key(); // capture channel at send time
    this.pending.set({
      id: -1,
      bot: false,
      actor: u.name,
      initials: u.initials,
      color: u.color,
      time: '',
      iso: new Date().toISOString(),
      cont: false,
      body: text,
      pending: true,
    });
    this.draft = '';
    queueMicrotask(() => this.scrollToBottom());
    this.api.comment(target.id, text, u.name, u.initials).subscribe({
      next: (c) => {
        this.pendingCommentId = c.id;
        this.poll.nudge();
      },
      error: () => {
        this.pending.set(null);
        // only restore draft if the user is still on the same channel
        if (this.key() === sentKey) {
          this.draft = text;
        }
      }, // restore, nothing lost
    });
  }
  setFollow(lvl: string) {
    this.follow.set(lvl);
    this.followOpen = false;
    localStorage.setItem(`sf-follow-${this.key()}`, lvl);
  }
  review(id: number) {
    this.router.navigate(['/admin/queue'], { queryParams: { sel: id } });
  }
  openIssue(id: number) {
    this.router.navigateByUrl(`/admin/requests/${id}`);
  }

  age = timeAgo;
}
