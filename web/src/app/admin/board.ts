import {
  Component,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { Api } from '../core/api.service';
import { FactoryRequest, RequestDetail } from '../core/models';
import { Poll } from '../core/poll.service';
import { Session } from '../core/session.service';
import { Store } from '../core/store.service';
import { STAGE_LABEL, TYPE_SHORT, boardGlyph, gateLabel, timeAgo } from '../core/util';
import { Avatar, Glyph, Icon, PopMenu, Sig } from '../kit/kit';
import { AdminShell, ViewSeg } from './admin-shell';

const STAGE_COLS: { key: string; glyph: string }[] = [
  { key: 'intake', glyph: 'dotted' },
  { key: 'spec', glyph: 'ring' },
  { key: 'architecture', glyph: 'ring' },
  { key: 'build', glyph: 'ring' },
  { key: 'review', glyph: 'ring' },
  { key: 'done', glyph: 'check' },
];

/** One board card. */
@Component({
  selector: 'sf-bcard',
  imports: [Glyph, Avatar, Sig],
  template: `
    <div
      class="bcard focusable"
      tabindex="0"
      role="button"
      [class.sel]="sel()"
      [style.border-left-color]="g().color"
      (click)="open()"
      (keydown.enter)="open()"
    >
      <div class="bcard__top">
        <span class="bcard__app">{{ r().app_name }}</span>
        <span class="chip">{{ typeShort() }}</span>
      </div>
      <div class="bcard__title">{{ r().title }}</div>
      <div class="bcard__foot">
        <sf-glyph [type]="g().glyph" [size]="15" [color]="g().color" [fill]="g().fill" />
        @if (r().needs_human) {
          <sf-sig tone="red" glyph="flag">Needs human</sf-sig>
        } @else if (gate()) {
          <sf-sig tone="amber">{{ gate() }}</sf-sig>
        }
        <span class="row" style="margin-left:auto;gap:6px">
          @if (r().assignee_initials) {
            <sf-avatar [sm]="true" [color]="r().assignee_color ?? '#7A6E9A'">{{
              r().assignee_initials
            }}</sf-avatar>
          } @else {
            <span style="font-size:11px;color:var(--faint)">unassigned</span>
          }
          <span style="font-size:11px;color:var(--faint)">{{ age() }}</span>
        </span>
      </div>
    </div>
  `,
})
export class BCard {
  private router = inject(Router);
  r = input.required<FactoryRequest>();
  sel = input(false);
  gate = computed(() => gateLabel(this.r()));
  age = computed(() => timeAgo(this.r().created_at));
  typeShort = computed(() => TYPE_SHORT[this.r().type] ?? this.r().type);
  g = computed(() => boardGlyph(this.r()));
  open() {
    this.router.navigate([], { queryParams: { open: this.r().id }, queryParamsHandling: 'merge' });
  }
}

/** C4 — Detail side-panel over the board (full-contrast board + dark overlay). */
@Component({
  selector: 'sf-detail-panel',
  imports: [Glyph, Icon, Sig],
  template: `
    <div class="scrim" style="background:rgba(18,14,28,.42)" (click)="closed.emit()"></div>
    <div class="sidepanel fade-in" style="width:468px">
      @if (d(); as r) {
        <div class="sp-head">
          <div class="row" style="gap:8px">
            <sf-glyph
              [type]="r.needs_human ? 'flag' : 'ring'"
              [size]="15"
              [color]="r.needs_human ? 'var(--red)' : 'var(--a500)'"
              [fill]="0.4"
            />
            <span class="chip">{{ typeLabel(r.type) }}</span>
            @if (r.needs_human) {
              <sf-sig tone="red" glyph="flag">Needs human</sf-sig>
            } @else if (r.gate === 'approve_spec' && !approved()) {
              <sf-sig tone="amber">Approve spec</sf-sig>
            } @else if (r.gate === 'approve_merge' && !approved()) {
              <sf-sig tone="amber">Approve merge</sf-sig>
            } @else if (approved() || r.status === 'approved') {
              <span class="pill purple"
                ><sf-glyph
                  type="ring"
                  [size]="13"
                  color="var(--a600)"
                  [fill]="0.55"
                />Building</span
              >
            }
            <span class="row" style="margin-left:auto;gap:4px">
              <button class="btn ghost sm" title="Open full issue" (click)="openFull(r.id)">
                <sf-icon name="link" [size]="14" /> Open full issue
              </button>
              <button class="btn ghost sm" (click)="closed.emit()">
                <kbd class="kbd">Esc</kbd>
              </button>
            </span>
          </div>
          <h2 style="font-size:21px;margin:8px 0 2px">{{ r.title }}</h2>
          <div style="font-size:12.5px;color:var(--muted)">
            {{ r.app_name }} · <span class="mono" style="font-size:12px">{{ r.ref }}</span>
            @if (r.assignee_initials) {
              · owner {{ r.assignee_initials }}
            }
          </div>
        </div>
        <div class="sp-body scroll">
          @if (r.needs_human) {
            <div
              class="openq"
              style="margin-bottom:14px;border-color:#E7AEA7;background:var(--red-bg)"
            >
              <div class="row" style="gap:8px;margin-bottom:5px">
                <sf-glyph type="flag" [size]="14" color="var(--red)" /><span
                  style="font-size:13px;font-weight:600;color:var(--red-tx)"
                  >Escalated — why</span
                >
              </div>
              <div style="font-size:13px;color:var(--red-tx);line-height:1.45">
                {{ r.needs_human_reason }}
              </div>
            </div>
          }
          <!-- post-approval items lead with what's happening NOW; pre-approval with the spec -->
          @if (postApproval(r) && milestones().length) {
            <div class="section-eyebrow" style="margin-bottom:9px">Recent milestones</div>
            <div style="display:flex;flex-direction:column;gap:9px;margin-bottom:16px">
              @for (m of milestones(); track m.id) {
                <div
                  class="block"
                  [style.border-left-color]="
                    m.kind === 'gate_event'
                      ? 'var(--amber)'
                      : m.kind === 'escalation'
                        ? 'var(--red)'
                        : 'var(--a400)'
                  "
                >
                  <div style="flex:1;min-width:0">
                    <div class="block__head">
                      <span class="block__hl">{{ m.title }}</span
                      ><span class="block__time">{{ ago(m.created_at) }} ago</span>
                    </div>
                  </div>
                </div>
              }
            </div>
          }
          <div class="section-eyebrow" style="margin-bottom:8px">Draft spec</div>
          @for (line of r.spec_lines; track $index) {
            <div class="specline">
              <span style="color:var(--faint);font-size:12px;margin-top:4px">•</span>
              <span class="specline__b"
                >{{ line.text }}
                <span class="prov" [class.assume]="line.assume">{{
                  line.assume ? '(ASSUMPTION — not stated)' : '(from: ' + line.prov + ')'
                }}</span></span
              >
            </div>
          } @empty {
            <div style="font-size:13px;color:var(--faint)">
              Spec not drafted yet — still in triage.
            </div>
          }
          @if (r.spec_open_note && !postApproval(r)) {
            <div class="openq" style="margin:10px 0 0">
              <div class="row" style="gap:8px">
                <sf-glyph type="dotted" [size]="13" color="var(--amber)" /><span
                  style="font-size:12.5px;font-weight:600;color:var(--amber-tx)"
                  >Open questions · {{ r.spec_open_note }}</span
                >
              </div>
            </div>
          }

          <div class="section-eyebrow" style="margin:18px 0 9px">
            {{
              postApproval(r)
                ? 'Approve ledger · completed'
                : 'On approve · per-step ledger (idempotent retry)'
            }}
          </div>
          <div class="block" style="border-left:3px dashed var(--border-strong)">
            <div style="font-size:12.5px;color:var(--fg2)">
              <span [style.color]="r.repo_ready ? 'var(--green)' : 'var(--muted)'"
                >repo {{ r.repo_ready ? '✓' : '…' }}</span
              >
              →
              <span [style.color]="r.spec_pr_open ? 'var(--green)' : 'var(--muted)'"
                >SPEC.md PR {{ r.spec_pr_open ? '✓' : '…' }}</span
              >
              →
              <span [style.color]="r.stage2_fired ? 'var(--green)' : 'var(--muted)'"
                >Stage 2 {{ r.stage2_fired ? '✓' : '…' }}</span
              >
              <span style="color:var(--faint)"> (idempotent retry)</span>
            </div>
          </div>
        </div>
        <div class="sp-foot">
          @if (approved()) {
            <span class="row" style="gap:8px;font-size:13.5px;color:var(--green-tx)"
              ><sf-glyph type="check" [size]="16" color="var(--green)" /> Approved — build started.
              Watch it in the feed.</span
            >
          } @else if (r.needs_human) {
            <button class="btn primary" (click)="retry(r)">Retry stage</button>
            <button class="btn" (click)="openFull(r.id)">Open issue</button>
            <button
              class="btn sm"
              style="margin-left:auto;border-style:dashed;color:var(--muted)"
              (click)="cancel(r)"
            >
              Cancel
            </button>
          } @else if (r.gate) {
            <button class="btn primary" (click)="confirming.set(true)">
              Approve <kbd class="kbd">A</kbd>
            </button>
            @if (r.gate === 'approve_spec') {
              <button class="btn" (click)="openFull(r.id)">
                Send back <kbd class="kbd">S</kbd>
              </button>
            }
            <button
              class="btn sm"
              style="margin-left:auto;border-style:dashed;color:var(--muted)"
              (click)="cancel(r)"
            >
              Cancel <kbd class="kbd">C</kbd>
            </button>
          } @else {
            <button class="btn" (click)="openFull(r.id)">Open full issue</button>
          }
        </div>
      }
    </div>
    @if (confirming()) {
      <div
        class="palette-scrim"
        style="align-items:center;padding-top:0;z-index:50"
        (click)="confirming.set(false)"
      >
        <div
          class="palette"
          style="width:460px;padding:22px 24px;align-self:center"
          (click)="$event.stopPropagation()"
        >
          <h3 style="font-size:19px;margin-bottom:8px">
            {{ d()?.gate === 'approve_merge' ? 'Approve this merge?' : 'Approve this spec?' }}
          </h3>
          <p style="font-size:14px;color:var(--muted);margin:0 0 4px">
            Approving <b style="color:var(--fg1)">{{ d()?.title }}</b> is irreversible. It will:
          </p>
          <ul
            style="margin:12px 0 16px;padding:0;list-style:none;display:flex;flex-direction:column;gap:9px"
          >
            @for (step of confirmSteps(); track $index) {
              <li class="row" style="gap:10px;font-size:13.5px">
                <span
                  style="width:20px;height:20px;border-radius:50%;background:var(--a50);display:flex;align-items:center;justify-content:center;flex:0 0 auto"
                  ><sf-icon name="check" [size]="12" color="var(--a600)"
                /></span>
                <span
                  ><b style="font-weight:600">{{ step[0] }}</b>
                  <span class="mono" style="font-size:12px;color:var(--muted);margin-left:6px">{{
                    step[1]
                  }}</span></span
                >
              </li>
            }
          </ul>
          <div class="row" style="gap:9px;justify-content:flex-end">
            <button class="btn" (click)="confirming.set(false)">Cancel</button>
            <button class="btn primary" (click)="approve()">
              {{ d()?.gate === 'approve_merge' ? 'Approve & deploy' : 'Approve & start build' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class DetailPanel {
  private api = inject(Api);
  private router = inject(Router);
  private session = inject(Session);
  private poll = inject(Poll);

  id = input.required<number>();
  closed = output<void>();

  d = signal<RequestDetail | null>(null);
  milestones = signal<{ id: number; title: string; kind: string; created_at: string }[]>([]);
  approved = signal(false);
  confirming = signal(false);
  ago = timeAgo;

  constructor() {
    effect(() => {
      const rid = this.id();
      this.poll.version();
      this.api.request(rid).subscribe((r) => this.d.set(r));
      this.api
        .events({ request_id: rid })
        .subscribe((evs) => this.milestones.set(evs.slice(-3).reverse()));
    });
  }

  postApproval(r: RequestDetail) {
    return (
      ['approved', 'done'].includes(r.status) ||
      ['architecture', 'build', 'review', 'done'].includes(r.stage)
    );
  }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.key === 'Escape') {
      if (this.confirming()) this.confirming.set(false);
      else this.closed.emit();
    } else if (
      e.key.toLowerCase() === 'a' &&
      this.d()?.gate &&
      !this.d()?.needs_human &&
      !this.confirming()
    ) {
      e.preventDefault();
      this.confirming.set(true);
    }
  }

  typeLabel(t: string) {
    return (
      { bug: 'Bug fix', enh: 'Enhancement', new: 'New app', other: 'Other' } as Record<
        string,
        string
      >
    )[t];
  }
  confirmSteps(): [string, string][] {
    const r = this.d();
    if (r?.gate === 'approve_merge') {
      return [
        ['Merge the PR to main', r.repo ?? ''],
        ['Promote main → production', 'protected-branch approval'],
        ['Trigger the deploy', 'Stage 6'],
      ];
    }
    const repo =
      r?.repo ??
      `micron/${(r?.new_app_name || r?.title || '').toLowerCase().replaceAll(' ', '-').slice(0, 28)}`;
    return [
      ['Create the GitHub repo', repo],
      ['Open the SPEC.md pull request', 'from the grounded draft'],
      ['Start the Architecture stage', 'hands off to Stage 2'],
    ];
  }

  approve() {
    const r = this.d();
    if (!r) return;
    this.confirming.set(false);
    this.approved.set(true); // optimistic — reconciled by the next poll
    this.api.approve(r.id, this.session.user().name).subscribe({
      next: (d) => {
        this.d.set(d as RequestDetail);
        this.poll.nudge();
      },
      error: () => this.approved.set(false),
    });
  }
  retry(r: RequestDetail) {
    this.api.retry(r.id, this.session.user().name).subscribe(() => {
      this.poll.nudge();
      this.closed.emit();
    });
  }
  cancel(r: RequestDetail) {
    this.api.cancel(r.id, this.session.user().name).subscribe(() => {
      this.poll.nudge();
      this.closed.emit();
    });
  }
  openFull(id: number) {
    this.router.navigateByUrl(`/admin/issue/${id}`);
  }
}

/** C2 — Board: fixed stage columns; Group-by adds Jira-style horizontal swimlanes. */
@Component({
  selector: 'sf-board-page',
  imports: [AdminShell, Glyph, Icon, Avatar, BCard, DetailPanel, ViewSeg, PopMenu],
  template: `
    <admin-shell active="board" title="Board">
      <sf-view-seg headerRight active="board" />
      <span headerExtra class="row" style="gap:11px">
        <button
          class="kpill"
          (click)="mine.set(!mine())"
          style="padding:5px 11px 5px 8px;font-size:12.5px;gap:7px"
          [style.background]="mine() ? 'var(--a50)' : 'var(--surface)'"
          [style.border-color]="mine() ? 'var(--accent-tint-bd)' : 'var(--border-strong)'"
          [style.color]="mine() ? 'var(--a700)' : 'var(--muted)'"
        >
          @if (mine()) {
            <sf-avatar [sm]="true" [color]="session.user().color">{{
              session.user().initials
            }}</sf-avatar>
          } @else {
            <sf-icon name="user" [size]="15" />
          }
          <span [style.font-weight]="mine() ? 600 : 500">Assigned to me</span>
          @if (mine()) {
            <sf-icon name="check" [size]="14" color="var(--a600)" />
          }
        </button>
        <div style="position:relative">
          <button
            class="kpill"
            style="padding:5px 10px;font-size:12.5px"
            (click)="menu.set(!menu())"
          >
            <span style="color:var(--faint)">Group by:</span>
            <span style="color:var(--fg1);font-weight:600">{{ groupLabel() }}</span>
            <sf-icon name="chevDown" [size]="13" color="var(--faint)" />
          </button>
          <sf-pop-menu [open]="menu()" [width]="184" align="left" (closed)="menu.set(false)">
            <div class="pop__group">Swimlanes by</div>
            @for (g of groupOpts; track g[0]) {
              <button
                class="pop__opt"
                [class.on]="groupBy() === g[0]"
                (click)="groupBy.set($any(g[0])); menu.set(false)"
              >
                <sf-icon
                  [name]="g[2]"
                  [size]="15"
                  [color]="groupBy() === g[0] ? 'var(--a600)' : 'var(--muted)'"
                />
                <span style="flex:1">{{ g[1] }}</span>
                @if (groupBy() === g[0]) {
                  <sf-icon name="check" [size]="15" color="var(--a600)" />
                }
              </button>
            }
          </sf-pop-menu>
        </div>
      </span>

      @if (groupBy() === 'none') {
        <div class="board scroll-x">
          @for (col of cols; track col.key) {
            <div class="col" [class.inert]="inert(col.key)">
              <div class="col__head">
                <sf-glyph [type]="col.glyph" [size]="14" color="var(--muted)" />
                <span class="col__name">{{ stageLabel[col.key] }}</span>
                <span class="col__count">{{ byStage(col.key).length }}</span>
              </div>
              <div class="col__body scroll">
                @for (r of byStage(col.key); track r.id) {
                  <sf-bcard [r]="r" [sel]="r.gate === 'approve_spec' && r.id === firstGateId()" />
                }
              </div>
            </div>
          }
        </div>
      } @else {
        <div class="swimboard scroll">
          <div class="swim-colhead">
            @for (col of cols; track col.key) {
              <div class="col__head" [class.inert]="inert(col.key)">
                <sf-glyph [type]="col.glyph" [size]="14" color="var(--muted)" />
                <span class="col__name">{{ stageLabel[col.key] }}</span>
                <span class="col__count">{{ byStage(col.key).length }}</span>
              </div>
            }
          </div>
          @for (lane of lanes(); track lane.key) {
            <div class="swim">
              <button class="swim__head" (click)="toggleLane(lane.key)">
                <sf-icon
                  [name]="laneOpen(lane.key) ? 'chevDown' : 'chevRight'"
                  [size]="14"
                  color="var(--muted)"
                />
                @if (groupBy() === 'app') {
                  <span style="color:var(--faint);font-weight:600">#</span>
                }
                @if (groupBy() === 'owner') {
                  @if (lane.av) {
                    <sf-avatar [sm]="true" [color]="lane.color ?? '#7A6E9A'">{{
                      lane.av
                    }}</sf-avatar>
                  } @else {
                    <span class="swim__unassigned"></span>
                  }
                }
                <span class="swim__name">{{ lane.label }}</span>
                <span class="swim__count">{{ lane.items.length }}</span>
              </button>
              @if (laneOpen(lane.key)) {
                <div class="swim__row">
                  @for (col of cols; track col.key) {
                    <div class="swim__cell" [class.inert]="inert(col.key)">
                      @for (r of laneCell(lane, col.key); track r.id) {
                        <sf-bcard [r]="r" />
                      }
                    </div>
                  }
                </div>
              }
            </div>
          }
        </div>
      }

      <!-- detail side-panel: board stays at full contrast behind a dark overlay -->
      @if (openId(); as oid) {
        <sf-detail-panel [id]="oid" (closed)="closePanel()" />
      }
    </admin-shell>
  `,
})
export class Board {
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private store = inject(Store);
  session = inject(Session);

  cols = STAGE_COLS;
  stageLabel = STAGE_LABEL;
  mine = signal(false);
  menu = signal(false);
  groupBy = signal<'none' | 'app' | 'owner' | 'type'>('none');
  groupOpts: [string, string, string][] = [
    ['none', 'None', 'x'],
    ['app', 'App', 'hash'],
    ['owner', 'Assignee', 'user'],
    ['type', 'Type', 'grid'],
  ];
  closedLanes = signal<Set<string>>(new Set());
  all = computed(() => this.store.requests().filter((r) => r.status !== 'cancelled'));
  openId = signal<number | null>(null);

  constructor() {
    this.route.queryParamMap.subscribe((p) => {
      const v = p.get('open');
      this.openId.set(v ? Number(v) : null);
    });
  }

  // "me" is whoever is signed in — never a hardcoded persona
  pool = computed(() =>
    this.mine()
      ? this.all().filter((r) => r.assignee_initials === this.session.user().initials)
      : this.all(),
  );
  byStage(stage: string) {
    return this.pool().filter((r) => r.stage === stage);
  }
  inert(stage: string) {
    return (
      this.byStage(stage).length === 0 &&
      ['architecture', 'build', 'review', 'done'].includes(stage)
    );
  }
  firstGateId = computed(() => this.pool().find((r) => r.gate === 'approve_spec')?.id ?? -1);
  groupLabel() {
    return (
      { none: 'None', app: 'App', owner: 'Assignee', type: 'Type' } as Record<string, string>
    )[this.groupBy()];
  }

  lanes = computed(() => {
    const g = this.groupBy();
    const pool = this.pool();
    if (g === 'none') return [];
    const keyOf = (r: FactoryRequest) =>
      g === 'app' ? r.app_name : g === 'type' ? r.type : (r.assignee ?? 'Unassigned');
    const labelOf = (k: string) =>
      g === 'type'
        ? ((
            { bug: 'Bug fix', enh: 'Enhancement', new: 'New app', other: 'Other' } as Record<
              string,
              string
            >
          )[k] ?? k)
        : k;
    const map = new Map<string, FactoryRequest[]>();
    for (const r of pool) {
      const k = keyOf(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }
    return [...map.entries()].map(([key, items]) => ({
      key,
      label: labelOf(key),
      items,
      av:
        g === 'owner' ? (items.find((r) => r.assignee_initials)?.assignee_initials ?? null) : null,
      color: g === 'owner' ? (items.find((r) => r.assignee_color)?.assignee_color ?? null) : null,
    }));
  });
  laneCell(lane: { items: FactoryRequest[] }, stage: string) {
    return lane.items.filter((r) => r.stage === stage);
  }
  laneOpen(key: string) {
    return !this.closedLanes().has(key);
  }
  toggleLane(key: string) {
    this.closedLanes.update((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }
  closePanel() {
    this.router.navigate([], { queryParams: { open: null }, queryParamsHandling: 'merge' });
  }
}
