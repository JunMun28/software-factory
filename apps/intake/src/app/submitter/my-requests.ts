import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { Api, FactoryRequest, Icon, Poll, TYPE_LABEL, plainStage, timeAgo } from '@sf/shared';
import { Session } from '../core/session.service';
import { SubShell } from './sub-shell';

type GroupKey = 'building' | 'review' | 'wait' | 'shipped';

/** S4 — My Requests: the "Your turn inbox" redesign (mockups/my-requests verdict,
 *  2026-07-11). A submitter-scoped queue split into a "Your turn" zone —
 *  sent-back requests with the reviewer's question quoted and an inline answer
 *  box wired to api.respond — and a grouped "In the works" feed (Building now /
 *  In review / Waiting to start / Recently shipped) plus a collapsed Cancelled
 *  group. Plain-stage vocabulary throughout (CONTEXT.md). */
@Component({
  selector: 'sf-my-requests',
  imports: [SubShell, Icon, FormsModule],
  template: `
    <sub-shell active="list">
      <div class="mr fade-in">
        <header class="mr__intro">
          <div>
            <div class="mr__eyebrow">Your factory queue</div>
            <h1 class="mr__h1">My requests</h1>
            <p class="mr__sub">{{ subtitle() }}</p>
          </div>
          <button class="btn primary" (click)="go('/submit/new')">
            <sf-icon name="plus" [size]="16" /> New request
          </button>
        </header>

        @if (all().length === 0) {
          <div class="mr__empty">
            <div class="mr__empty-badge"><sf-icon name="plus" [size]="18" /></div>
            <div class="mr__empty-t">Nothing here yet</div>
            <div class="mr__empty-s">
              File your first request and the factory takes it from there.
            </div>
            <button class="btn primary" (click)="go('/submit/new')">
              <sf-icon name="plus" [size]="16" /> New request
            </button>
          </div>
        } @else {
          <!-- ===== YOUR TURN ===== -->
          @if (turnItems().length) {
            <section class="turn" aria-label="Needs your input">
              <div class="turn__label">
                Your turn
                @if (pendingCount()) {
                  <span class="turn__count">{{ pendingCount() }}</span>
                }
              </div>
              @for (r of turnItems(); track r.id) {
                @if (answered().has(r.id)) {
                  <div class="answered">
                    <span class="answered__check">✓</span>
                    <span>Answered — back with the factory</span>
                    <small>{{ r.title }}</small>
                  </div>
                } @else {
                  <article class="turn__card">
                    <div class="turn__meta">
                      <span class="turn__dot"></span>Reviewer question · {{ age(r) }} ago
                    </div>
                    <div class="turn__grid">
                      <div>
                        <div class="turn__title">{{ r.title }}</div>
                        <blockquote class="turn__q">{{ question(r) }}</blockquote>
                        <div class="turn__links">
                          <button class="turn__link" (click)="focusReply(r.id)">
                            Respond now <span aria-hidden="true">↓</span>
                          </button>
                          <button class="turn__link" (click)="go('/requests/' + r.id)">
                            Open request <span aria-hidden="true">↗</span>
                          </button>
                        </div>
                      </div>
                      <form class="reply" (submit)="$event.preventDefault(); respond(r)">
                        <label [attr.for]="'mr-answer-' + r.id">Answer the reviewer</label>
                        <textarea
                          [id]="'mr-answer-' + r.id"
                          placeholder="Share the answer in plain language…"
                          [ngModel]="replies()[r.id] ?? ''"
                          [ngModelOptions]="{ standalone: true }"
                          (ngModelChange)="setReply(r.id, $event)"
                        ></textarea>
                        <div class="reply__foot">
                          <span>This goes straight back to review.</span>
                          <button
                            class="reply__send"
                            type="submit"
                            [disabled]="!(replies()[r.id] || '').trim()"
                          >
                            Send answer →
                          </button>
                        </div>
                      </form>
                    </div>
                  </article>
                }
              }
            </section>
          } @else {
            <div class="allclear">
              <span class="allclear__check">✓</span>
              You're all caught up — nothing needs you right now.
            </div>
          }

          <!-- ===== IN THE WORKS ===== -->
          <section class="works" aria-label="In the works">
            <div class="works__top">
              <div>
                <h2 class="works__h">In the works</h2>
                <p class="works__s">A calm view of what's moving, waiting, and live.</p>
              </div>
              <span class="works__legend">UPDATED MOST RECENTLY FIRST</span>
            </div>

            @for (g of groups(); track g.key) {
              <div class="group" [class]="'group--' + g.key">
                <div class="group__head">
                  <span class="group__bar"></span>{{ g.label }}
                  <span class="group__n"
                    >{{ g.items.length }} {{ g.items.length > 1 ? 'requests' : 'request' }}</span
                  >
                </div>
                <div class="rows">
                  @for (r of g.items; track r.id) {
                    <button class="rowr" (click)="go('/requests/' + r.id)">
                      <div class="rowr__main">
                        <div class="rowr__title">
                          {{ r.title }} <span class="rowr__type">{{ typeLabel(r) }}</span>
                        </div>
                        <div class="rowr__sub">{{ subline(r) }}</div>
                      </div>
                      <div class="rowr__app">
                        {{ r.app_name || 'No app yet' }}
                        <small>{{ ageVerb(g.key) }} {{ age(r) }} ago</small>
                      </div>
                      <span class="stage">{{ ps(r).label }}</span>
                      <span class="rowr__arrow" aria-hidden="true">{{
                        g.key === 'shipped' ? '↗' : '→'
                      }}</span>
                    </button>
                  }
                </div>
              </div>
            }

            @if (cancelledRows().length) {
              <div class="cancelled" [class.open]="cancelOpen()">
                <button
                  class="cancelled__toggle"
                  [attr.aria-expanded]="cancelOpen()"
                  (click)="cancelOpen.set(!cancelOpen())"
                >
                  <span class="cancelled__chev" aria-hidden="true">›</span>Cancelled
                  <span class="cancelled__n"
                    >{{ cancelledRows().length }}
                    {{ cancelledRows().length > 1 ? 'requests' : 'request' }}</span
                  >
                </button>
                @if (cancelOpen()) {
                  <div class="cancelled__body">
                    @for (r of cancelledRows(); track r.id) {
                      <button class="rowr rowr--cancelled" (click)="go('/requests/' + r.id)">
                        <div class="rowr__main">
                          <div class="rowr__title">
                            {{ r.title }} <span class="rowr__type">{{ typeLabel(r) }}</span>
                          </div>
                          <div class="rowr__sub">This request will not move forward.</div>
                        </div>
                        <div class="rowr__app">
                          {{ r.app_name || 'No app' }}
                          <small>cancelled {{ age(r) }} ago</small>
                        </div>
                        <span class="stage">Cancelled</span>
                        <span class="rowr__arrow" aria-hidden="true">→</span>
                      </button>
                    }
                  </div>
                }
              </div>
            }
          </section>
        }
      </div>
    </sub-shell>
  `,
  styles: `
    .mr {
      max-width: 900px;
      margin: 0 auto;
      padding: 34px 26px 90px;
    }
    .mr__intro {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 30px;
    }
    .mr__eyebrow {
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--accent-tx);
      margin-bottom: 8px;
    }
    .mr__h1 {
      font-size: clamp(28px, 4vw, 40px);
      font-weight: 700;
      letter-spacing: -0.03em;
      line-height: 1;
      margin: 0;
    }
    .mr__sub {
      color: var(--muted);
      font-size: 15px;
      margin: 11px 0 0;
    }

    /* empty */
    .mr__empty {
      text-align: center;
      padding: 60px 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }
    .mr__empty-badge {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--muted);
      margin-bottom: 6px;
    }
    .mr__empty-t {
      font-size: 17px;
      font-weight: 600;
      color: var(--fg1);
    }
    .mr__empty-s {
      font-size: 13.5px;
      color: var(--muted);
      margin-bottom: 12px;
    }

    /* ===== YOUR TURN ===== */
    .turn__label {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
      font-size: 14px;
      font-weight: 600;
      color: var(--fg1);
    }
    .turn__count {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--amber-tx);
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
      padding: 2px 8px;
      border-radius: 999px;
    }
    .turn__card {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--amber-line);
      border-radius: var(--r-lg);
      background: var(--amber-bg);
      box-shadow: 0 8px 28px -18px rgba(199, 120, 0, 0.5);
      padding: clamp(22px, 4vw, 34px);
      margin-bottom: 12px;
    }
    .turn__meta {
      display: flex;
      align-items: center;
      gap: 9px;
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--amber-tx);
    }
    .turn__dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--amber);
      box-shadow: 0 0 0 5px color-mix(in srgb, var(--amber) 14%, transparent);
    }
    .turn__grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(280px, 0.7fr);
      gap: clamp(24px, 5vw, 52px);
      margin-top: 22px;
    }
    .turn__title {
      font-size: 14px;
      color: var(--muted);
      margin-bottom: 10px;
    }
    .turn__q {
      margin: 0;
      font-size: clamp(21px, 2.8vw, 30px);
      line-height: 1.2;
      letter-spacing: -0.025em;
      color: var(--fg1);
      font-weight: 600;
      max-width: 620px;
    }
    .turn__q::before {
      content: '\\201C';
      color: var(--amber);
      margin-right: 1px;
    }
    .turn__q::after {
      content: '\\201D';
      color: var(--amber);
    }
    .turn__links {
      display: flex;
      gap: 18px;
      margin-top: 20px;
    }
    .turn__link {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--amber-tx);
      font-size: 13px;
      font-weight: 600;
      background: none;
      border: 0;
      padding: 0;
      cursor: pointer;
    }
    .turn__link:hover {
      text-decoration: underline;
    }
    .reply {
      align-self: end;
    }
    .reply label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--fg1);
      margin-bottom: 8px;
    }
    .reply textarea {
      display: block;
      width: 100%;
      min-height: 108px;
      resize: vertical;
      border: 1px solid var(--amber-line);
      border-radius: 12px;
      background: color-mix(in srgb, var(--surface) 70%, transparent);
      color: var(--fg1);
      padding: 13px 14px;
      outline: 0;
      font: inherit;
      line-height: 1.45;
      transition:
        border-color 0.18s,
        box-shadow 0.18s;
    }
    .reply textarea::placeholder {
      color: var(--faint);
    }
    .reply textarea:focus {
      border-color: var(--amber);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--amber) 16%, transparent);
    }
    .reply__foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-top: 11px;
    }
    .reply__foot span {
      font-size: 11px;
      color: var(--muted);
    }
    .reply__send {
      border: 0;
      border-radius: 999px;
      background: var(--amber);
      color: #fff;
      font: 600 13px var(--body);
      padding: 9px 16px;
      cursor: pointer;
      white-space: nowrap;
      transition:
        transform 0.16s,
        opacity 0.16s;
    }
    .reply__send:hover {
      transform: translateY(-1px);
    }
    .reply__send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    .answered,
    .allclear {
      display: flex;
      align-items: center;
      gap: 12px;
      border: 1px solid var(--green-line);
      border-radius: 13px;
      background: var(--green-bg);
      padding: 14px 17px;
      color: var(--green-tx);
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 12px;
    }
    .answered__check,
    .allclear__check {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: var(--green);
      color: #fff;
      font-size: 12px;
      flex: none;
    }
    .answered small {
      margin-left: auto;
      color: var(--muted);
      font: 400 11px var(--mono);
    }
    .allclear {
      font-weight: 500;
      color: var(--green-tx);
    }

    /* ===== IN THE WORKS ===== */
    .works {
      margin-top: 40px;
    }
    .works__top {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 20px;
      margin-bottom: 14px;
    }
    .works__h {
      font-size: 22px;
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--fg1);
      margin: 0;
    }
    .works__s {
      color: var(--muted);
      font-size: 13px;
      margin: 2px 0 0;
    }
    .works__legend {
      font: 400 10px var(--mono);
      letter-spacing: 0.05em;
      color: var(--faint);
    }
    .group {
      margin-top: 16px;
    }
    .group__head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 13px;
      border: 1px solid var(--border);
      border-radius: 10px 10px 0 0;
      background: var(--surface-2);
      color: var(--fg1);
      font-size: 12px;
      font-weight: 600;
    }
    .group__bar {
      width: 22px;
      height: 3px;
      border-radius: 9px;
      background: var(--accent);
    }
    .group--review .group__bar {
      background: var(--a400);
    }
    .group--wait .group__bar {
      background: var(--faint);
    }
    .group--shipped .group__bar {
      background: var(--green);
    }
    .group__n {
      margin-left: auto;
      font: 400 10px var(--mono);
      color: var(--faint);
    }
    .rows {
      border: 1px solid var(--border);
      border-top: 0;
      border-radius: 0 0 12px 12px;
      overflow: hidden;
      background: var(--surface);
    }
    .rowr {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 148px 128px 40px;
      align-items: center;
      gap: 18px;
      min-height: 74px;
      padding: 13px 17px;
      border: 0;
      border-bottom: 1px solid var(--border);
      background: transparent;
      text-align: left;
      width: 100%;
      cursor: pointer;
      font: inherit;
      color: inherit;
      transition: background 0.16s;
    }
    .rowr:last-child {
      border-bottom: 0;
    }
    .rowr:hover {
      background: var(--surface-2);
    }
    .rowr:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .rowr__main {
      min-width: 0;
    }
    .rowr__title {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--fg1);
      font-weight: 600;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rowr__type {
      font: 400 9px var(--mono);
      color: var(--muted);
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      padding: 2px 7px;
      white-space: nowrap;
      flex: none;
    }
    .rowr__sub {
      font-size: 12px;
      color: var(--muted);
      margin-top: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rowr__app {
      color: var(--fg2);
      font-size: 13px;
      min-width: 0;
    }
    .rowr__app small {
      display: block;
      color: var(--faint);
      font: 400 10px var(--mono);
      margin-top: 2px;
    }
    .stage {
      justify-self: start;
      font: 500 10px var(--mono);
      border-radius: 999px;
      padding: 5px 9px;
      background: var(--accent-tint);
      border: 1px solid var(--accent-tint-bd);
      color: var(--accent-tx);
      white-space: nowrap;
    }
    .group--review .stage {
      color: var(--a400);
      background: color-mix(in srgb, var(--a400) 12%, transparent);
      border-color: color-mix(in srgb, var(--a400) 35%, transparent);
    }
    .group--wait .stage {
      color: var(--muted);
      background: var(--surface-2);
      border-color: var(--border-strong);
    }
    .group--shipped .stage {
      color: var(--green-tx);
      background: var(--green-bg);
      border-color: var(--green-line);
    }
    .rowr__arrow {
      justify-self: end;
      color: var(--faint);
      font-size: 18px;
      transition:
        transform 0.16s,
        color 0.16s;
    }
    .rowr:hover .rowr__arrow {
      transform: translateX(3px);
      color: var(--fg1);
    }

    /* cancelled */
    .cancelled {
      margin-top: 16px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface);
      overflow: hidden;
    }
    .cancelled__toggle {
      display: flex;
      align-items: center;
      width: 100%;
      gap: 10px;
      border: 0;
      background: transparent;
      padding: 13px 15px;
      cursor: pointer;
      text-align: left;
      color: var(--muted);
      font: 600 12px var(--body);
    }
    .cancelled__toggle:hover {
      background: var(--surface-2);
    }
    .cancelled__chev {
      transition: transform 0.18s;
    }
    .cancelled.open .cancelled__chev {
      transform: rotate(90deg);
    }
    .cancelled__n {
      margin-left: auto;
      font: 400 10px var(--mono);
      color: var(--faint);
    }
    .cancelled__body {
      border-top: 1px solid var(--border);
    }
    .rowr--cancelled {
      opacity: 0.62;
    }
    .rowr--cancelled .rowr__title {
      text-decoration: line-through;
    }
    .rowr--cancelled .stage {
      color: var(--muted);
      background: var(--surface-2);
      border-color: var(--border-strong);
    }

    /* responsive */
    @media (max-width: 720px) {
      .mr {
        padding: 26px 16px 80px;
      }
      .mr__intro {
        align-items: flex-start;
      }
      .turn__grid {
        grid-template-columns: 1fr;
        gap: 24px;
      }
      .works__legend {
        display: none;
      }
      .rowr,
      .rowr--cancelled {
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 6px 12px;
        padding: 13px 14px;
        min-height: 84px;
      }
      .rowr__main {
        grid-column: 1 / 2;
      }
      .rowr__app {
        grid-column: 1 / 2;
        font-size: 12px;
      }
      .stage {
        grid-column: 2;
        grid-row: 1;
        align-self: start;
      }
      .rowr__arrow {
        grid-column: 2;
        grid-row: 2;
        align-self: end;
      }
      .rowr__title {
        white-space: normal;
      }
      .rowr__sub {
        display: none;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .reply__send,
      .rowr__arrow,
      .cancelled__chev {
        transition: none;
      }
    }
  `,
})
export class MyRequests {
  private router = inject(Router);
  private session = inject(Session);
  private poll = inject(Poll);
  private api = inject(Api);

  /** Own fetch — the submitter face must not pull the admin Store's projections
   *  (apps/inbox/mission) that injecting Store would poll every tick. */
  private requests = signal<FactoryRequest[]>([]);

  /** Replies the submitter is drafting, keyed by request id. */
  replies = signal<Record<number, string>>({});
  /** Requests answered this session — collapses the card before the poll catches up. */
  answered = signal<Set<number>>(new Set());
  cancelOpen = signal(false);

  all = computed(() => this.requests().filter((r) => r.reporter === this.session.user().name));
  /** The "Your turn" zone: sent-back requests plus any answered this session — the
   *  answered ones stay pinned (as the green strip) until reload, since the poll
   *  drops them out of sent_back the moment respond() lands. */
  turnItems = computed(() =>
    this.all().filter((r) => r.status === 'sent_back' || this.answered().has(r.id)),
  );
  /** Still-actionable sent-back requests (drives the count + subtitle). */
  pendingCount = computed(() => this.turnItems().filter((r) => !this.answered().has(r.id)).length);
  cancelledRows = computed(() =>
    this.all()
      .filter((r) => r.status === 'cancelled')
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
  );

  private static readonly GROUP_META: Record<GroupKey, string> = {
    building: 'Building now',
    review: 'In review',
    wait: 'Waiting to start',
    shipped: 'Recently shipped',
  };
  private static readonly GROUP_ORDER: GroupKey[] = ['building', 'review', 'wait', 'shipped'];

  groups = computed(() => {
    const active = this.all().filter(
      (r) => r.status !== 'sent_back' && r.status !== 'cancelled' && !this.answered().has(r.id),
    );
    const buckets: Record<GroupKey, FactoryRequest[]> = {
      building: [],
      review: [],
      wait: [],
      shipped: [],
    };
    for (const r of active) buckets[this.groupOf(r)].push(r);
    return MyRequests.GROUP_ORDER.map((key) => ({
      key,
      label: MyRequests.GROUP_META[key],
      items: buckets[key].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    })).filter((g) => g.items.length);
  });

  constructor() {
    this.poll.start();
    effect(() => {
      this.poll.version();
      this.api.requests().subscribe((v) => this.requests.set(v));
    });
  }

  ps = plainStage;
  age(r: FactoryRequest) {
    return timeAgo(r.updated_at);
  }
  typeLabel(r: FactoryRequest) {
    return TYPE_LABEL[r.type];
  }
  go(url: string) {
    this.router.navigateByUrl(url);
  }

  subtitle() {
    if (this.all().length === 0) return 'File your first request to get started.';
    const n = this.pendingCount();
    if (n) return `${n} thing${n > 1 ? 's need' : ' needs'} you. Everything else is moving.`;
    return "Everything's moving — nothing needs you right now.";
  }

  /** Which "In the works" group a request lands in — mirrors plainStage precedence. */
  private groupOf(r: FactoryRequest): GroupKey {
    if (r.status === 'done') return 'shipped';
    if (r.status === 'submitted' || r.status === 'pending_approval') return 'wait';
    if (r.stage === 'review') return 'review';
    if (r.status === 'approved') return 'building';
    return 'wait';
  }

  subline(r: FactoryRequest): string {
    const base = {
      building: 'Agents are turning the approved spec into working software',
      review: 'The finished change is being checked before release',
      wait:
        r.status === 'pending_approval'
          ? 'The factory has drafted the solution'
          : 'Received and waiting for the first pass',
      shipped: 'Live and available to your team',
    }[this.groupOf(r)];
    const impact = this.impactGarnish(r);
    return impact ? `${base} · ${impact}` : base;
  }

  private impactGarnish(r: FactoryRequest): string {
    const v = r.impact_value?.trim();
    if (!v) return '';
    if (r.impact_metric === 'hours') return `~${v} h/yr`;
    if (r.impact_metric === 'cost') return `~$${v}k/yr`;
    return v;
  }

  ageVerb(key: GroupKey) {
    return key === 'shipped' ? 'shipped' : 'updated';
  }
  question(r: FactoryRequest) {
    return r.send_back_question || 'The reviewer has a question before this can move on.';
  }

  setReply(id: number, v: string) {
    this.replies.update((m) => ({ ...m, [id]: v }));
  }
  focusReply(id: number) {
    document.getElementById('mr-answer-' + id)?.focus();
  }
  respond(r: FactoryRequest) {
    const note = (this.replies()[r.id] ?? '').trim();
    if (!note) return;
    this.api.respond(r.id, note, this.session.user().name).subscribe(() => {
      this.answered.update((s) => new Set(s).add(r.id));
      this.poll.nudge();
    });
  }
}
