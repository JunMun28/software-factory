import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { FactoryRequest } from '../core/models';
import { Store } from '../core/store.service';
import { TYPE_SHORT, inFlight as inFlightHelper, timeAgo } from '../core/util';
import { Avatar, Icon, Sig } from '../kit/kit';
import { AdminShell } from './admin-shell';

const STAGES = ['intake', 'spec', 'architecture', 'build', 'review', 'done'];
const STAGE_SHORT = ['Intake', 'Spec', 'Arch', 'Build', 'Review', 'Done'];

interface Strip {
  segs: ('done' | 'active' | 'pending' | 'off')[];
  specGate: 'passed' | 'waiting' | 'escalated' | 'submitter' | 'pending';
  mergeGate: 'passed' | 'waiting' | 'pending';
}

interface Group {
  key: string;
  label: string;
  count: number;
  items: FactoryRequest[];
  collapsed?: boolean;
}

/** Pipeline — the attention-first runs view: one row per Work item, the six stages
 *  compressed into a stage strip with the two human gates as diamonds. */
@Component({
  selector: 'sf-pipeline-page',
  imports: [AdminShell, Icon, Avatar, Sig],
  template: `
    <admin-shell active="pipeline" title="Pipeline">
      <span headerExtra class="row" style="gap:10px">
        <span style="font-size:12.5px;color:var(--muted)"
          >{{ activeCount() }} active · grouped by attention</span
        >
        <span style="font-size:11.5px;color:var(--faint)">J/K move · ↵ open</span>
      </span>

      <div class="list scroll" style="padding:14px 0 40px">
        <div style="max-width:880px;margin:0 auto;padding:0 22px">
          <!-- stage legend, aligned to the strips -->
          <div class="pipe-legend">
            @for (s of stageShort; track s; let i = $index) {
              <span class="pipe-legend__seg">{{ s }}</span>
              @if (i === 1 || i === 4) {
                <span
                  class="pipe-legend__gate"
                  [title]="i === 1 ? 'Spec gate' : 'Merge gate'"
                ></span>
              }
            }
          </div>

          @for (g of groups(); track g.key) {
            <div
              class="pipe-grouphead"
              (click)="g.collapsed && toggle(g.key)"
              [style.cursor]="g.collapsed !== undefined ? 'pointer' : 'default'"
            >
              @if (g.collapsed !== undefined) {
                <sf-icon
                  [name]="isOpen(g.key) ? 'chevDown' : 'chevRight'"
                  [size]="13"
                  color="var(--faint)"
                />
              }
              {{ g.label }} · {{ g.count }}
            </div>
            @if (g.collapsed === undefined || isOpen(g.key)) {
              @for (r of g.items; track r.id) {
                <div
                  class="pipe-row focusable"
                  tabindex="0"
                  role="button"
                  [class.pipe-row--red]="r.needs_human"
                  [class.pipe-row--focus]="flatIdx(r) === focusIdx()"
                  (click)="open(r)"
                  (keydown.enter)="open(r)"
                  (focus)="focusIdx.set(flatIdx(r))"
                >
                  <div class="pipe-row__main">
                    <span
                      class="mono"
                      style="font-size:11px;color:var(--faint);white-space:nowrap"
                      >{{ r.ref }}</span
                    >
                    <span
                      class="pipe-row__title"
                      [style.text-decoration]="r.status === 'cancelled' ? 'line-through' : ''"
                      >{{ r.title }}</span
                    >
                    <span style="font-size:11.5px;color:var(--muted);white-space:nowrap"
                      >#{{ r.app_name }} · {{ typeShort[r.type] }}</span
                    >
                    @if (r.assignee_initials) {
                      <sf-avatar [sm]="true" [color]="r.assignee_color ?? 'var(--avatar)'">{{
                        r.assignee_initials
                      }}</sf-avatar>
                    }
                    <span style="margin-left:auto"></span>
                    @if (r.needs_human) {
                      <sf-sig tone="red" glyph="flag" (click)="toQueue($event)">Needs human</sf-sig>
                    } @else if (r.gate === 'approve_spec') {
                      <sf-sig tone="amber" kbd="A" (click)="toQueue($event)">Approve spec</sf-sig>
                    } @else if (r.gate === 'approve_merge') {
                      <sf-sig tone="amber" kbd="A" (click)="toQueue($event)">Approve merge</sf-sig>
                    } @else if (r.status === 'sent_back') {
                      <span class="chip">with submitter</span>
                    } @else if (r.status === 'done') {
                      <span class="chip" style="color:var(--green-tx)">deployed</span>
                    } @else if (r.status === 'cancelled') {
                      <span class="chip">cancelled</span>
                    } @else if (r.status === 'approved') {
                      <span style="font-size:11.5px;color:var(--accent-tx)"
                        >{{ stageShort[stageIdx(r)] }} · agents working</span
                      >
                    } @else {
                      <span class="chip">triage</span>
                    }
                  </div>
                  <div class="pipe-strip">
                    @for (seg of strip(r).segs; track $index; let i = $index) {
                      <span class="pipe-seg" [class]="'pipe-seg pipe-seg--' + seg"></span>
                      @if (i === 1) {
                        <span
                          class="pipe-gate"
                          [class]="'pipe-gate pipe-gate--' + strip(r).specGate"
                        ></span>
                      }
                      @if (i === 4) {
                        <span
                          class="pipe-gate"
                          [class]="'pipe-gate pipe-gate--' + strip(r).mergeGate"
                        ></span>
                      }
                    }
                  </div>
                  <div class="pipe-row__meta">
                    <span class="row" style="gap:5px"
                      ><sf-icon name="clock" [size]="13" /> {{ clockLine(r) }}</span
                    >
                    @if (r.last_event) {
                      <span class="pipe-row__event">"{{ r.last_event }}"</span>
                    }
                  </div>
                </div>
              }
            }
          }
        </div>
      </div>
    </admin-shell>
  `,
  styles: `
    .pipe-legend {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 16px 7px;
    }
    .pipe-legend__seg {
      flex: 1;
      text-align: center;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--faint);
    }
    .pipe-legend__gate {
      width: 9px;
      height: 9px;
      flex: 0 0 9px;
      transform: rotate(45deg);
      border: 1.5px solid var(--border-strong);
      border-radius: 1px;
    }
    .pipe-grouphead {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.09em;
      text-transform: uppercase;
      color: var(--faint);
      margin: 16px 2px 7px;
    }
    .pipe-row {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      padding: 10px 16px 9px;
      margin-bottom: 8px;
      cursor: pointer;
      transition:
        border-color var(--dur) var(--ease),
        box-shadow var(--dur) var(--ease);
    }
    .pipe-row:hover {
      box-shadow: var(--shadow-pop);
    }
    .pipe-row--red {
      border-color: var(--red-line);
    }
    .pipe-row--focus {
      box-shadow: inset 0 0 0 2px var(--a500);
    }
    .pipe-row__main {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .pipe-row__title {
      font-size: 13.5px;
      font-weight: 600;
      color: var(--fg1);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pipe-strip {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-top: 9px;
    }
    .pipe-seg {
      flex: 1;
      height: 5px;
      border-radius: 3px;
      background: var(--surface-3);
    }
    .pipe-seg--done {
      background: var(--a400);
    }
    .pipe-seg--active {
      background: repeating-linear-gradient(90deg, var(--a400) 0 6px, var(--a100) 6px 12px);
      background-size: 200% 100%;
      animation: pipeflow 1.6s linear infinite;
    }
    .pipe-seg--off {
      background: var(--surface-2);
    }
    @keyframes pipeflow {
      to {
        background-position: -24px 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .pipe-seg--active {
        animation: none;
      }
    }
    .pipe-gate {
      width: 9px;
      height: 9px;
      flex: 0 0 9px;
      transform: rotate(45deg);
      border-radius: 1px;
      background: var(--border-strong);
    }
    .pipe-gate--passed {
      background: var(--a600);
    }
    .pipe-gate--waiting {
      background: var(--amber);
      box-shadow: 0 0 0 3px var(--amber-bg);
    }
    .pipe-gate--escalated {
      background: var(--red);
      box-shadow: 0 0 0 3px var(--red-bg);
    }
    .pipe-gate--submitter {
      background: var(--surface);
      border: 1.5px solid var(--amber-line);
    }
    .pipe-row__meta {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-top: 7px;
      font-size: 11.5px;
      color: var(--muted);
    }
    .pipe-row__event {
      color: var(--faint);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
  `,
})
export class Pipeline {
  private router = inject(Router);
  private store = inject(Store);

  all = this.store.requests;
  openGroups = signal<Set<string>>(new Set());
  focusIdx = signal(0);
  typeShort = TYPE_SHORT;
  stageShort = STAGE_SHORT;

  activeCount = computed(
    () => this.all().filter((r) => !['done', 'cancelled'].includes(r.status)).length,
  );

  groups = computed<Group[]>(() => {
    const rs = this.all();
    const needsMe = rs
      .filter((r) => r.gate || r.needs_human)
      .sort((a, b) => Number(b.needs_human) - Number(a.needs_human));
    const inFlight = rs.filter((r) => r.status === 'approved' && inFlightHelper(r));
    const triage = rs.filter(
      (r) => !r.needs_human && r.status === 'submitted' && r.stage === 'intake',
    );
    const submitter = rs.filter((r) => r.status === 'sent_back');
    const closed = rs.filter((r) => ['done', 'cancelled'].includes(r.status));
    const defs: Group[] = [
      { key: 'me', label: 'Needs me', count: needsMe.length, items: needsMe },
      {
        key: 'flight',
        label: 'In flight — agents working',
        count: inFlight.length,
        items: inFlight,
      },
      { key: 'triage', label: 'In triage', count: triage.length, items: triage },
      { key: 'submitter', label: 'With submitter', count: submitter.length, items: submitter },
      {
        key: 'closed',
        label: 'Done & closed',
        count: closed.length,
        items: closed,
        collapsed: true,
      },
    ];
    return defs.filter((g) => g.count > 0);
  });

  stageIdx(r: FactoryRequest) {
    return Math.max(0, STAGES.indexOf(r.stage));
  }

  strip(r: FactoryRequest): Strip {
    const idx = this.stageIdx(r);
    const closed = r.status === 'done';
    const cancelled = r.status === 'cancelled';
    const segs = STAGES.map((_, i): Strip['segs'][number] => {
      if (cancelled) return i <= idx ? 'done' : 'off';
      if (closed) return 'done';
      if (i < idx) return 'done';
      if (i === idx) return r.status === 'approved' && !r.gate ? 'active' : 'done';
      return 'pending';
    });
    const specGate: Strip['specGate'] =
      r.needs_human && idx <= 1
        ? 'escalated'
        : r.gate === 'approve_spec'
          ? 'waiting'
          : r.status === 'sent_back'
            ? 'submitter'
            : idx >= 2 || closed
              ? 'passed'
              : 'pending';
    const mergeGate: Strip['mergeGate'] =
      r.gate === 'approve_merge' ? 'waiting' : closed ? 'passed' : 'pending';
    return { segs, specGate, mergeGate };
  }

  clockLine(r: FactoryRequest): string {
    const t = r.stage_entered_at ? timeAgo(r.stage_entered_at) : timeAgo(r.updated_at);
    if (r.needs_human) return `stalled ${t} — Retry · Take over · Cancel`;
    if (r.gate === 'approve_spec') return `${t} at the spec gate`;
    if (r.gate === 'approve_merge') return `${t} at the merge gate`;
    if (r.status === 'sent_back') return `${t} waiting on the submitter`;
    if (r.status === 'done') return `deployed ${t} ago`;
    if (r.status === 'cancelled') return `cancelled ${t} ago`;
    if (r.status === 'approved') return `${t} in ${STAGE_SHORT[this.stageIdx(r)]}`;
    return `${t} in triage`;
  }

  isOpen(key: string) {
    return this.openGroups().has(key);
  }
  toggle(key: string) {
    this.openGroups.update((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }
  open(r: FactoryRequest) {
    this.router.navigateByUrl(`/admin/issue/${r.id}`);
  }
  toQueue(e: Event) {
    e.stopPropagation();
    this.router.navigateByUrl('/admin/queue');
  }

  /** Visible (non-collapsed) rows in display order — the J/K traversal list. */
  visible = computed(() =>
    this.groups().flatMap((g) => (g.collapsed == null || this.isOpen(g.key) ? g.items : [])),
  );
  flatIdx(r: FactoryRequest) {
    return this.visible().findIndex((x) => x.id === r.id);
  }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    const cur = this.visible()[this.focusIdx()];
    if (k === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.focusIdx.update((s) => Math.min(this.visible().length - 1, s + 1));
    } else if (k === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.focusIdx.update((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter' && cur) {
      e.preventDefault();
      this.open(cur);
    } else if (k === 'a' && cur && (cur.gate || cur.needs_human)) {
      e.preventDefault();
      this.router.navigate(['/admin/queue'], { queryParams: { sel: cur.id } });
    }
  }
}
