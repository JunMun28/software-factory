# Supervision Revamp — Plan 3: Request Detail Trace, Gates Evidence, Activity

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the supervision detail surfaces beside the existing ones: a new request-detail **trace** page (`/admin/requests/:id`), a **merge-gate evidence pane** on the Gates (queue) surface, a shared **`sf-evidence-strip`** kit component, and the **Activity** composer de-chatted — all with `make verify` green.

**Architecture:** Reuse before rebuild. The evidence display becomes one kit component (`sf-evidence-strip`) fed by a pure `evidenceBits()` extracted from `mission.ts` to `core/util.ts` (vitest-covered). The trace page is a new route consuming the already-plumbed `Api.trace()`, with a pure `groupTrace()` helper (vitest-covered) turning the flat event log into stage-grouped rows. The old `/admin/issue/:id` page is left untouched (deleted at cutover, Plan 5); Mission + Gates deep-link to the new page.

**Tech Stack:** Angular 22 standalone components + signals; FastAPI backend already exposes everything needed (Plan 1). Web commands from `web/`; full gate `make verify` from repo root.

**Spec:** `docs/superpowers/specs/2026-06-12-ui-supervision-revamp-design.md` §6 (Gates, Request detail, Activity). Phase 3 of 5 (cutover step 3). The vocabulary purge (assignee/owner columns) and route-default flip stay in Plan 5; **All requests** (List) is left as-is this plan — its only change is the cutover purge, so it is deferred to avoid a half-migration.

**Backend contract (live, Plan 1):**
- `GET /api/requests/{id}` → `RequestDetail` now carries `run: RunState|null` and `evidence: Evidence|null` (gate-scoped: present only while parked at a gate; closed items read evidence from the trace).
- `GET /api/requests/{id}/trace?after=` → `{items: ProgressEvent[], cursor}`; kinds include `step_summary` (payload `{step, of, label, why, acked_steer_ids?}`), `verification`, `gate_event`, `milestone_summary`, `escalation`, `steer_note`, `comment`. Ascending within a page.
- Actions: `approve`, `sendBack`, `cancel`, `retry(id, actor, note='')`, `comment`, `steer`.

**Repo rules:** one amber + one red family per surface; status by shape (kit `sf-glyph`/`sf-sig`); hairlines not boxes; Micron purple accent; mono for refs; polling consumes signals via `computed()` (no component refetch effects except the per-id detail load mirrored from `issue.ts`); keyboard parity. Commits: `feat(web):` / `fix(web):`. Dev stack may be up (API :8001, web :4200) — use it for visual checks; `make reset` + restart API for fresh seed.

**Out of scope (explicit):**
- `Take over` and `Send back to stage` recovery actions — **no backend endpoints exist**; do not invent them. The recovery cluster ships with the backed actions only (Retry stage, Retry with note, Cancel). Add a code comment marking the two as pending-backend; they become a future backend task.
- All requests (List) restyle / assignee-column purge → Plan 5 cutover.
- Dark mode → Plan 4.

---

### Task 1: Extract `evidenceBits` to util + vitest; build `sf-evidence-strip`; refactor mission

De-dup the evidence display into one tested helper and one kit component, then point Mission control at it.

**Files:**
- Modify: `web/src/app/core/util.ts`
- Modify: `web/src/app/core/util.spec.ts`
- Modify: `web/src/app/kit/kit.ts`
- Modify: `web/src/app/admin/mission.ts`

- [ ] **Step 1: Write the failing tests** — append to `web/src/app/core/util.spec.ts` (extend the import with `evidenceBits`; follow the file's describe/it style):

```typescript
describe('evidenceBits', () => {
  const base = {
    grounded_lines: null, total_lines: null, interview_count: null,
    tests_passed: null, tests_total: null, diff_added: null, diff_removed: null,
    files_changed: null, reviewer_verdict: null, assumptions: [] as string[],
  };
  it('null evidence → single "no evidence recorded" bit', () => {
    expect(evidenceBits(null)).toEqual([{ text: 'no evidence recorded', tone: '' }]);
  });
  it('spec gate → grounded-lines + interview bits', () => {
    const bits = evidenceBits({ ...base, kind: 'spec', grounded_lines: 3, total_lines: 4, interview_count: 4 });
    expect(bits[0]).toEqual({ text: '3 of 4 lines grounded in answers', tone: 'green' });
    expect(bits[1]).toEqual({ text: 'spec drafted from interview (4 Q)', tone: '' });
  });
  it('spec gate with no interview omits the interview bit', () => {
    const bits = evidenceBits({ ...base, kind: 'spec', grounded_lines: 2, total_lines: 3, interview_count: 0 });
    expect(bits).toHaveLength(1);
  });
  it('merge gate → tests + diff + reviewer bits', () => {
    const bits = evidenceBits({
      ...base, kind: 'merge', tests_passed: 8, tests_total: 8,
      diff_added: 412, diff_removed: 38, files_changed: 9, reviewer_verdict: 'no blocking findings',
    });
    expect(bits[0]).toEqual({ text: '8/8 tests pass', tone: 'green' });
    expect(bits[1]).toEqual({ text: 'diff +412 −38 · 9 files', tone: '' });
    expect(bits[2]).toEqual({ text: 'reviewer: no blocking findings', tone: 'purple' });
  });
  it('merge gate with no verification fields → no evidence recorded', () => {
    expect(evidenceBits({ ...base, kind: 'merge' })).toEqual([{ text: 'no evidence recorded', tone: '' }]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && npx ng test`
Expected: FAIL — `evidenceBits` not exported.

- [ ] **Step 3: Move `evidenceBits` into `web/src/app/core/util.ts`** — extend the models import with `Evidence`, append:

```typescript
export interface EvidenceBit {
  text: string;
  tone: '' | 'green' | 'purple';
}

/** The evidence strip's bits (spec §6): spec gates show grounding, merge gates show
 *  tests/diff/reviewer. null or a verification-less merge gate → "no evidence recorded". */
export function evidenceBits(ev: Evidence | null): EvidenceBit[] {
  const none: EvidenceBit[] = [{ text: 'no evidence recorded', tone: '' }];
  if (!ev) return none;
  if (ev.kind === 'spec') {
    const bits: EvidenceBit[] = [
      { text: `${ev.grounded_lines ?? 0} of ${ev.total_lines ?? 0} lines grounded in answers`, tone: 'green' },
    ];
    if (ev.interview_count) bits.push({ text: `spec drafted from interview (${ev.interview_count} Q)`, tone: '' });
    return bits;
  }
  const bits: EvidenceBit[] = [];
  if (ev.tests_total != null) bits.push({ text: `${ev.tests_passed}/${ev.tests_total} tests pass`, tone: 'green' });
  if (ev.diff_added != null)
    bits.push({ text: `diff +${ev.diff_added} −${ev.diff_removed} · ${ev.files_changed} files`, tone: '' });
  if (ev.reviewer_verdict) bits.push({ text: `reviewer: ${ev.reviewer_verdict}`, tone: 'purple' });
  return bits.length ? bits : none;
}
```

- [ ] **Step 4: Run tests**

Run: `cd web && npx ng test`
Expected: PASS (47 + new evidenceBits cases).

- [ ] **Step 5: Build the `sf-evidence-strip` kit component** in `web/src/app/kit/kit.ts` — find the file's component pattern (standalone, inline template) and add, importing `Evidence` and `evidenceBits` from `../core/util` (check kit.ts's existing import paths):

```typescript
@Component({
  selector: 'sf-evidence-strip',
  template: `
    <div class="evstrip">
      @for (bit of bits(); track bit.text) {
        <span class="evstrip__bit" [class.green]="bit.tone === 'green'" [class.purple]="bit.tone === 'purple'">{{ bit.text }}</span>
      }
    </div>
    @if (assumptions().length) {
      <div class="evstrip__assume">
        ⚠ {{ assumptions().length }} assumption{{ assumptions().length === 1 ? '' : 's' }}: {{ assumptions()[0] }}
      </div>
    }
  `,
  styles: `
    .evstrip { display: flex; flex-wrap: wrap; gap: 5px 16px; font-size: 12px; color: var(--fg2); }
    .evstrip__bit.green { color: var(--green-tx); font-weight: 500; }
    .evstrip__bit.purple { color: var(--a700); }
    .evstrip__assume { margin-top: 5px; font-size: 12px; color: var(--amber-tx); }
  `,
})
export class EvidenceStrip {
  evidence = input<Evidence | null>(null);
  bits = computed(() => evidenceBits(this.evidence()));
  assumptions = computed(() => this.evidence()?.assumptions ?? []);
}
```

Check kit.ts's actual imports for `Component`, `computed`, `input` (Angular 22 signal inputs) — the file already uses them (Sig/Pill etc.); match. Replace the `⚠` literal with the same affordance the rest of kit.ts uses if it has one (e.g. an `sf-glyph type="dotted"` — check `EscalationBox`/`SpecLines`); the design system renders assumptions with a dotted amber glyph, so mirror that.

- [ ] **Step 6: Refactor `mission.ts`** to use the kit component — add `EvidenceStrip` to imports/`imports:[]`; remove the local `evidenceBits` method and the `.msn-evid`/`.msn-assume` markup + styles; in the gates band replace them with `<sf-evidence-strip [evidence]="g.evidence" />`. Keep the `no-evidence`/assumptions behavior identical (the kit component reproduces it). Build + lint must stay green and the component CSS budget must not regress.

- [ ] **Step 7: Full web gate + visual parity check**

Run: `cd web && npx ng test && npx ng lint && npx ng build`
Expected: green, no budget warning.
Visual: `/admin/mission` gate cards look identical to before (evidence bits + assumptions) — the refactor is invisible.

- [ ] **Step 8: Commit**

```bash
git add web/src/app/core/util.ts web/src/app/core/util.spec.ts web/src/app/kit/kit.ts web/src/app/admin/mission.ts
git commit -m "feat(web): sf-evidence-strip kit component + tested evidenceBits; mission reuses it"
```

---

### Task 2: Merge-gate evidence pane on the Gates (queue) surface

Today the queue's detail pane shows "No draft spec yet." for merge gates. Add the evidence strip so a merge gate shows tests/diff/reviewer before the Approve button. Spec gates keep the grounded draft spec.

**Files:**
- Modify: `web/src/app/admin/queue.ts`

- [ ] **Step 1: Wire it in** — add `EvidenceStrip` to `queue.ts` imports/`imports:[]`. The pane already binds `detail()` to a `RequestDetail` (`r`) which now carries `r.evidence`. Replace the `Draft spec` block for the merge-gate case:

Find the existing:
```html
              <div class="section-eyebrow" style="margin-bottom:10px">Draft spec</div>
              <sf-spec-lines
                [lines]="r.spec_lines"
                emptyText="No draft spec yet."
                [openNote]="r.spec_open_note"
              />
```
and replace with a gate-aware branch:
```html
              @if (r.gate === 'approve_merge') {
                <div class="section-eyebrow" style="margin-bottom:10px">Verification</div>
                <sf-evidence-strip [evidence]="r.evidence" />
              } @else {
                <div class="section-eyebrow" style="margin-bottom:10px">Draft spec</div>
                <sf-spec-lines
                  [lines]="r.spec_lines"
                  emptyText="No draft spec yet."
                  [openNote]="r.spec_open_note"
                />
              }
```

- [ ] **Step 2: Web gate + visual check**

Run: `cd web && npx ng test && npx ng lint && npx ng build` — green.
Visual: open the Gates queue (`/admin/queue`), select the "Migrate auth to SSO" merge gate (or drive a request to the merge gate via the sim), confirm the Verification strip shows `8/8 tests pass · diff +412 −38 · 9 files · reviewer: no blocking findings`. Spec gates still show the grounded draft spec.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/admin/queue.ts
git commit -m "feat(web): merge gate shows its verification evidence in the Gates pane"
```

---

### Task 3: `groupTrace()` helper + vitest

Turn the flat trace event list into stage-grouped rows for the timeline.

**Files:**
- Modify: `web/src/app/core/util.ts`
- Modify: `web/src/app/core/util.spec.ts`

- [ ] **Step 1: Write the failing tests** — append to `util.spec.ts` (extend import with `groupTrace`):

```typescript
describe('groupTrace', () => {
  const ev = (id: number, kind: string, stage: string, payload: Record<string, unknown> = {}, title = '') =>
    ({ id, kind, stage, payload, title, actor: 'Factory', bot: true, broadcast: false,
       request_id: 1, subject_id: 1, body: null, created_at: '2026-06-12T00:00:00Z',
       request_ref: null, request_title: null }) as any;

  it('groups consecutive events by stage in order', () => {
    const g = groupTrace([
      ev(1, 'step_summary', 'architecture', { step: 1, of: 4, label: 'reading SPEC.md' }),
      ev(2, 'step_summary', 'architecture', { step: 2, of: 4, label: 'drafting PLAN.md' }),
      ev(3, 'step_summary', 'build', { step: 1, of: 6, label: 'authoring failing tests' }),
    ]);
    expect(g.map((x) => x.stage)).toEqual(['architecture', 'build']);
    expect(g[0].rows).toHaveLength(2);
    expect(g[1].rows).toHaveLength(1);
  });

  it('marks a step that acknowledges a steer note', () => {
    const g = groupTrace([
      ev(5, 'steer_note', 'build', {}, 'Reuse the CSV parser'),
      ev(6, 'step_summary', 'build', { step: 3, of: 6, label: 'implementing', acked_steer_ids: [5] }),
    ]);
    const rows = g[0].rows;
    expect(rows.find((r) => r.kind === 'steer_note')?.acked).toBe(true);
    expect(rows.find((r) => r.kind === 'step_summary')?.acksSteer).toBe(true);
  });

  it('keeps gate and verification events as rows', () => {
    const g = groupTrace([
      ev(7, 'verification', 'review', { tests_passed: 8 }, 'Verification report'),
      ev(8, 'gate_event', 'review', { gate: 'approve_merge' }, 'Waiting at the merge gate'),
    ]);
    expect(g[0].rows.map((r) => r.kind)).toEqual(['verification', 'gate_event']);
  });
});
```

- [ ] **Step 2: Verify fail** — `cd web && npx ng test` → FAIL (`groupTrace` not exported).

- [ ] **Step 3: Implement in `util.ts`** — extend the models import with `ProgressEvent`, append:

```typescript
export interface TraceRow {
  id: number;
  kind: ProgressEvent['kind'];
  title: string;
  /** step_summary only */
  step?: number;
  of?: number;
  label?: string;
  why?: string;
  /** this row is a steer note that a later step acknowledged */
  acked?: boolean;
  /** this step_summary consumed one or more steer notes */
  acksSteer?: boolean;
  payload: Record<string, unknown> | null;
  created_at: string;
}
export interface TraceGroup {
  stage: string;
  label: string;
  rows: TraceRow[];
}

/** Flatten the per-request trace into stage-grouped rows for the timeline (ADR 0014).
 *  Steer-note consumption is derived: a step_summary's payload.acked_steer_ids marks both
 *  the consuming step and the consumed notes. */
export function groupTrace(events: ProgressEvent[]): TraceGroup[] {
  const acked = new Set<number>();
  for (const e of events)
    for (const id of (e.payload?.['acked_steer_ids'] as number[] | undefined) ?? []) acked.add(id);

  const groups: TraceGroup[] = [];
  for (const e of events) {
    const p = e.payload ?? {};
    const row: TraceRow = {
      id: e.id, kind: e.kind, title: e.title, payload: e.payload, created_at: e.created_at,
      step: p['step'] as number | undefined,
      of: p['of'] as number | undefined,
      label: p['label'] as string | undefined,
      why: p['why'] as string | undefined,
      acked: e.kind === 'steer_note' && acked.has(e.id),
      acksSteer: e.kind === 'step_summary' && Array.isArray(p['acked_steer_ids']) && (p['acked_steer_ids'] as unknown[]).length > 0,
    };
    const last = groups[groups.length - 1];
    if (last && last.stage === e.stage) last.rows.push(row);
    else groups.push({ stage: e.stage, label: STAGE_LABEL[e.stage] ?? e.stage, rows: [row] });
  }
  return groups;
}
```

- [ ] **Step 4: Run tests** — `cd web && npx ng test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/util.ts web/src/app/core/util.spec.ts
git commit -m "feat(web): groupTrace — stage-grouped trace rows with derived steer-ack marks"
```

---

### Task 4: Request-detail trace page — scaffold, route, header, trace timeline

The new supervision detail page. Header carries *waiting on* / *decided by* (no Assignee/Reporter/Subscribers/labels/attachments/checklist). Body is the stage-grouped trace timeline with expandable "why" and inline steer notes.

**Files:**
- Create: `web/src/app/admin/request-detail.ts`
- Modify: `web/src/app/app.routes.ts`

- [ ] **Step 1: Create `web/src/app/admin/request-detail.ts`**

Model the data-loading + per-id reset on `issue.ts` (the `effect` that resets on id change and fetches `api.request(id)`), but ALSO fetch the trace. Use this component:

```typescript
import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';

import { Api } from '../core/api.service';
import { ProgressEvent, RequestDetail } from '../core/models';
import { Poll } from '../core/poll.service';
import { Session } from '../core/session.service';
import { STAGE_LABEL, TraceGroup, groupTrace, timeAgo } from '../core/util';
import { EvidenceStrip, Glyph, Icon, Sig, TypeChip } from '../kit/kit';
import { AdminShell } from './admin-shell';

/** Request detail (spec §6) — the supervision replacement for the Jira issue page.
 *  Header: waiting-on / decided-by. Body: the stage-grouped trace timeline. */
@Component({
  selector: 'sf-request-detail-page',
  imports: [AdminShell, Glyph, Icon, Sig, TypeChip, EvidenceStrip],
  template: `
    <admin-shell active="mission" title="Request">
      <span headerExtra class="row" style="gap:7px;font-size:12.5px;color:var(--muted)">
        <button class="btn ghost sm" style="margin-left:-6px;color:var(--muted)" (click)="back()">
          <sf-icon name="back" [size]="15" /> Mission control
        </button>
        <span style="color:var(--faint)">/</span
        ><span class="mono" style="font-size:12px">{{ d()?.ref }}</span>
      </span>
      <div style="position:absolute;inset:0;overflow-y:auto" class="scroll">
        @if (d(); as r) {
          <div style="max-width:760px;margin:0 auto;padding:24px 28px 80px">
            <!-- header -->
            <div class="row" style="gap:9px;margin-bottom:9px">
              <sf-type-chip [t]="r.type" />
              <span style="font-size:12.5px;color:var(--muted)">{{ r.app_name }}</span>
              @if (r.repo) {
                <span class="mono" style="font-size:11.5px;color:var(--faint)">{{ r.repo }}</span>
              }
            </div>
            <h1 style="font-size:25px;margin-bottom:12px">{{ r.title }}</h1>

            <div class="row" style="gap:14px;margin-bottom:20px;font-size:12.5px;color:var(--muted)">
              <span class="rd-state">{{ stateLine(r) }}</span>
              <span class="rd-who">{{ whoLine(r) }}</span>
            </div>

            @if (r.evidence) {
              <div class="rd-evidence">
                <sf-evidence-strip [evidence]="r.evidence" />
              </div>
            }

            <!-- trace timeline -->
            <div class="section-eyebrow" style="margin:8px 0 12px">Trace</div>
            @for (g of trace(); track g.stage; let gi = $index) {
              <div class="rd-stage">
                <div class="rd-stage__head">
                  <sf-glyph type="ring" [size]="12" color="var(--a500)" [fill]="0.5" />
                  {{ g.label }}
                </div>
                @for (row of g.rows; track row.id) {
                  @if (row.kind === 'steer_note') {
                    <div class="rd-steer">
                      <sf-icon name="back" [size]="12" color="var(--a600)" />
                      <span class="rd-steer__txt">{{ row.title }}</span>
                      <span class="rd-steer__tag">{{ row.acked ? 'honored' : 'queued' }}</span>
                    </div>
                  } @else {
                    <div class="rd-row" [class.rd-row--gate]="row.kind === 'gate_event'">
                      <span class="rd-row__dot"
                        ><sf-glyph [type]="rowGlyph(row.kind)" [size]="11" color="var(--muted)"
                      /></span>
                      <div class="rd-row__body">
                        <div class="rd-row__head">
                          <span class="rd-row__title">{{ rowTitle(row) }}</span>
                          @if (row.acksSteer) {
                            <span class="rd-row__ack">honoring your note</span>
                          }
                          <span class="rd-row__time">{{ ago(row.created_at) }}</span>
                        </div>
                        @if (row.why) {
                          <button class="rd-row__why" (click)="toggleWhy(row.id)">
                            <sf-icon [name]="openWhy().has(row.id) ? 'chevDown' : 'chevRight'" [size]="12" />
                            why
                          </button>
                          @if (openWhy().has(row.id)) {
                            <div class="rd-row__whytext">{{ row.why }}</div>
                          }
                        }
                      </div>
                    </div>
                  }
                }
              </div>
            } @empty {
              <div style="color:var(--faint);font-size:12.5px;padding:8px 0">
                No trace yet — work begins after the spec gate.
              </div>
            }
          </div>
        }
      </div>
    </admin-shell>
  `,
  styles: `
    .rd-state { font-weight: 500; color: var(--fg2); }
    .rd-evidence { padding: 12px 0 18px; border-bottom: 1px solid var(--hairline); margin-bottom: 4px; }
    .rd-stage { margin-bottom: 14px; }
    .rd-stage__head { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 600;
      letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg2); margin-bottom: 8px; }
    .rd-row { display: flex; gap: 10px; padding: 5px 0 5px 4px; }
    .rd-row__title { font-size: 13px; color: var(--fg1); }
    .rd-row__head { display: flex; align-items: baseline; gap: 9px; }
    .rd-row__ack { font-size: 10.5px; color: var(--a700); background: var(--a50); border-radius: 4px; padding: 1px 6px; }
    .rd-row__time { margin-left: auto; font-size: 11px; color: var(--faint); white-space: nowrap; }
    .rd-row__why { display: inline-flex; align-items: center; gap: 4px; margin-top: 3px; padding: 0;
      background: none; border: none; cursor: pointer; font-family: inherit; font-size: 11.5px; color: var(--muted); }
    .rd-row__whytext { font-size: 12px; color: var(--muted); margin: 3px 0 0 16px; line-height: 1.5; }
    .rd-row--gate .rd-row__title { color: var(--amber-tx); font-weight: 500; }
    .rd-steer { display: flex; align-items: center; gap: 8px; padding: 5px 0 5px 4px;
      font-size: 12.5px; color: var(--a700); }
    .rd-steer__txt { color: var(--fg2); }
    .rd-steer__tag { font-size: 10.5px; color: var(--muted); background: var(--surface-2); border-radius: 4px; padding: 1px 6px; }
  `,
})
export class RequestDetailPage {
  private api = inject(Api);
  private router = inject(Router);
  private poll = inject(Poll);
  protected session = inject(Session);
  private route = inject(ActivatedRoute);
  id = toSignal(this.route.paramMap.pipe(map((p) => Number(p.get('id')))), {
    initialValue: Number(this.route.snapshot.paramMap.get('id')),
  });

  d = signal<RequestDetail | null>(null);
  events = signal<ProgressEvent[]>([]);
  openWhy = signal<Set<number>>(new Set());
  stageLabel = STAGE_LABEL;
  ago = timeAgo;

  constructor() {
    let lastId: number | null = null;
    effect(() => {
      const id = this.id();
      this.poll.version();
      if (id !== lastId) {
        lastId = id;
        this.d.set(null);
        this.events.set([]);
        this.openWhy.set(new Set());
      }
      this.api.request(id).subscribe((r) => this.d.set(r));
      this.api.trace(id).subscribe((p) => this.events.set(p.items));
    });
  }

  trace = computed<TraceGroup[]>(() => groupTrace(this.events()));

  stateLine(r: RequestDetail): string {
    if (r.needs_human) return 'Stalled — needs a human';
    if (r.gate === 'approve_spec') return 'Waiting at the spec gate';
    if (r.gate === 'approve_merge') return 'Waiting at the merge gate';
    if (r.status === 'sent_back') return 'With the submitter';
    if (r.status === 'done') return 'Deployed';
    if (r.status === 'cancelled') return 'Cancelled';
    if (r.run) return `Building · ${this.stageLabel[r.stage]} · step ${r.run.step}/${r.run.of}`;
    if (r.status === 'approved') return `Building · ${this.stageLabel[r.stage]}`;
    return this.stageLabel[r.stage] ?? r.stage;
  }
  whoLine(r: RequestDetail): string {
    if (r.gate || r.needs_human) return 'waiting on you';
    if (r.status === 'sent_back') return `waiting on ${r.reporter}`;
    if (r.status === 'approved') return 'agents working';
    return `filed by ${r.reporter}`;
  }
  rowGlyph(kind: string): string {
    if (kind === 'gate_event') return 'flag';
    if (kind === 'verification' || kind === 'milestone_summary') return 'check';
    if (kind === 'escalation') return 'flag';
    return 'ring';
  }
  rowTitle(row: { kind: string; label?: string; step?: number; of?: number; title: string }): string {
    if (row.kind === 'step_summary' && row.label) return `${row.label} (${row.step}/${row.of})`;
    return row.title;
  }
  toggleWhy(id: number) {
    this.openWhy.update((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  back() {
    this.router.navigateByUrl('/admin/mission');
  }
}
```

Verify against source before building: `sf-type-chip` input name (`[t]`), `sf-glyph` inputs (`type`/`size`/`color`/`fill`), `sf-icon` names actually present (`back`, `chevDown`, `chevRight`) — substitute existing names where the plan guessed. Confirm `--surface-2`, `--a50`, `--a700`, `--amber-tx`, `--hairline` exist in styles.css.

- [ ] **Step 2: Add the route** in `app.routes.ts` (copy the admin guard exactly), before the `admin/issue/:id` route:

```typescript
  {
    path: 'admin/requests/:id',
    canActivate: [adminGuard],
    loadComponent: () => import('./admin/request-detail').then((m) => m.RequestDetailPage),
  },
```

- [ ] **Step 3: Web gate + visual check**

Run: `cd web && npx ng test && npx ng lint && npx ng build` — green.
Visual: navigate to `/admin/requests/2029` (or an in-flight request id) — header shows the state + who line; the trace timeline groups by stage; clicking "why" expands a step's reason; a steered run shows the note row with "honored" and the consuming step shows "honoring your note".

- [ ] **Step 4: Commit**

```bash
git add web/src/app/admin/request-detail.ts web/src/app/app.routes.ts
git commit -m "feat(web): request-detail trace page — waiting-on/decided-by header + stage-grouped trace"
```

---

### Task 5: Detail actions — gate approve/send-back, recovery cluster, comments

Add the action surfaces to the detail page: gate cards' Approve/Send-back (reuse kit modals), the needs-human recovery cluster (backed actions only), and the comment composer (plain, no Slack toolbar).

**Files:**
- Modify: `web/src/app/admin/request-detail.ts`

- [ ] **Step 1: Imports + state** — add to imports: `ApproveModal, SendBackModal, CancelConfirm, EscalationBox, Avatar` from kit; `FormsModule` from `@angular/forms`. Add class state mirroring `issue.ts`:

```typescript
  confirming = signal(false);
  sendingBack = signal(false);
  cancelling = signal(false);
  retryNote = signal('');
  showRetryNote = signal(false);
  commentText = '';
  composerFocus = signal(false);
```

and the action methods (mirror `issue.ts` exactly — they set `d` from the response and `poll.nudge()`): `approve`, `sendBack`, `cancel`, `retry` (extend to pass `retryNote()` when present: `this.api.retry(r.id, this.session.user().name, this.retryNote().trim())`), `comment`. Reset the new per-id UI (`confirming/sendingBack/cancelling/retryNote/showRetryNote/commentText`) in the id-change branch of the effect.

- [ ] **Step 2: Action bar markup** — directly under the `<h1>` title row's state line, add the action cluster:

```html
            <div class="row" style="gap:9px;margin-bottom:20px">
              @if (r.needs_human) {
                <button class="btn primary sm" (click)="retry(r)">Retry stage</button>
                <button class="btn sm" (click)="showRetryNote.set(!showRetryNote())">Retry with a note</button>
              } @else if (r.gate) {
                <button class="btn primary" (click)="confirming.set(true)">
                  {{ r.gate === 'approve_merge' ? 'Approve merge' : 'Approve spec' }}
                  <kbd class="kbd">A</kbd>
                </button>
                @if (r.gate === 'approve_spec') {
                  <button class="btn" (click)="sendingBack.set(true)">Send back <kbd class="kbd">S</kbd></button>
                }
              }
              @if (!['done', 'cancelled'].includes(r.status)) {
                <button class="btn sm" style="margin-left:auto;border-style:dashed;color:var(--muted)" (click)="cancelling.set(true)">
                  Cancel request <kbd class="kbd">C</kbd>
                </button>
              }
            </div>
            @if (showRetryNote()) {
              <div class="row" style="gap:8px;margin-bottom:16px">
                <input class="input" style="flex:1" placeholder="What should the retry do differently?"
                  [value]="retryNote()" (input)="retryNote.set($any($event.target).value)"
                  (keydown.enter)="retry(r)" />
                <button class="btn primary sm" (click)="retry(r)">Retry</button>
              </div>
            }
            @if (r.needs_human) {
              <sf-escalation-box title="Escalated — needs a person" [reason]="r.needs_human_reason" style="margin-bottom:16px" />
            }
```

Add a code comment above the recovery buttons:
```html
            <!-- Recovery cluster: Take over / Send back to stage need backend endpoints (not built) — Retry/Cancel are the backed actions. -->
```

- [ ] **Step 3: Comments** — after the trace timeline, add a plain comments section (reuse the `issue.ts` comment rendering + composer but WITHOUT the formatting toolbar buttons — just the textarea + Comment button):

```html
            <div class="section-eyebrow" style="margin:24px 0 12px">Comments</div>
            @for (c of r.comments; track c.id) {
              <div class="rd-cmt">
                <sf-avatar [color]="c.color">{{ c.initials }}</sf-avatar>
                <div style="flex:1">
                  <div class="row" style="gap:8px"><span style="font-size:13px;font-weight:600">{{ c.author }}</span>
                    <span style="font-size:11px;color:var(--faint)">{{ ago(c.created_at) }}</span></div>
                  <div style="font-size:13.5px;color:var(--fg1);margin-top:2px">{{ c.body }}</div>
                </div>
              </div>
            }
            <div class="row" style="gap:11px;margin-top:10px;align-items:flex-start">
              <sf-avatar color="#6E5A8A">{{ session.user().initials }}</sf-avatar>
              <div style="flex:1;display:flex;flex-direction:column;gap:8px">
                <textarea class="input" rows="2" placeholder="Leave a comment…"
                  [(ngModel)]="commentText" style="resize:vertical;min-height:54px"></textarea>
                <button class="btn primary sm" style="align-self:flex-end" [disabled]="!commentText.trim()" (click)="comment(r)">Comment</button>
              </div>
            </div>
```

Add `.rd-cmt { display:flex; gap:11px; padding:9px 0; border-bottom:1px solid var(--hairline); }` to styles. Add the three modals at the end (mirror `issue.ts`'s `@if (confirming() && d(); as r)` blocks verbatim).

- [ ] **Step 4: Keyboard** — add the `@HostListener('window:keydown')` mirroring `queue.ts`'s grammar: guard typing/modals; `A` confirm (when `r.gate`), `S` send-back (spec gate), `C` cancel, `R` retry (when needs_human). Import `HostListener`.

- [ ] **Step 5: Web gate + behavior check**

Run: `cd web && npx ng test && npx ng lint && npx ng build` — green.
Behavior: on `/admin/requests/<spec-gate id>` Approve opens the side-effect-naming modal; Send back works; on a needs-human request (REQ-2043) Retry stage and Retry-with-a-note appear with the escalation box; comments post and render.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/admin/request-detail.ts
git commit -m "feat(web): request-detail actions — gate approve/send-back, retry recovery, plain comments"
```

---

### Task 6: Deep-link Mission + Gates to the new detail page; de-chat the Activity composer

**Files:**
- Modify: `web/src/app/admin/mission.ts`
- Modify: `web/src/app/admin/queue.ts`
- Modify: `web/src/app/admin/feed.ts`

- [ ] **Step 1: Repoint Mission** — in `mission.ts`, change `openIssue` to navigate to `/admin/requests/${r.id}` (was `/admin/issue/${r.id}`). The gate cards' "Open" button (`openInQueue`) stays pointing at the queue.

- [ ] **Step 2: Repoint Gates** — in `queue.ts`, change `openIssue(id)` to `/admin/requests/${id}` (was `/admin/issue/${id}`). (The old issue page still exists for Pipeline until Plan 5.)

- [ ] **Step 3: De-chat the Activity composer** — in `feed.ts`, the composer has a `.scomposer__bar` with Bold/Italic/Link/Mention/Attach buttons (spec §6: "the Slack-style formatting toolbar goes; a plain comment box stays"). Remove the formatting buttons (Bold, Italic, Link, Mention, Attach), keeping the text field and the Send affordance. Leave the rest of the feed untouched. Remove any now-unused icon imports/styles to keep lint clean.

- [ ] **Step 4: Web gate + visual check**

Run: `cd web && npx ng test && npx ng lint && npx ng build` — green.
Visual: from Mission control, Enter / clicking a row opens `/admin/requests/:id` (the new trace page, not the Jira page); the Gates pane "Open issue" on an escalation also lands there; the Activity feed composer is now a plain box with no formatting toolbar.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/admin/mission.ts web/src/app/admin/queue.ts web/src/app/admin/feed.ts
git commit -m "feat(web): Mission + Gates open the trace detail page; Activity composer de-chatted"
```

---

### Task 7: Full verification + visual proof + final review

- [ ] **Step 1: `make verify`** from repo root — lint + pytest + vitest + build + smoke all green. (Run `npm run format:check` inside web first; if it flags files, `npx prettier --write` them and fold into the last commit or a `style(web):` commit.)

- [ ] **Step 2: Visual proof** (light mode; dark is Plan 4). Dev stack up (API :8001 fresh seed, web :4200):
  1. Screenshot `/admin/requests/2029` at 1440 — header (state + who), evidence (if at a gate), stage-grouped trace with at least one expanded "why" and the steer note's "honored" row.
  2. Screenshot the Gates queue with the merge gate selected — Verification strip visible.
  3. Drive a request through steer (Mission → Steer a run → open its detail) and confirm the note + "honoring your note" appear in the trace.
  4. Confirm Mission/Gates links land on `/admin/requests/:id`, and the Activity composer has no formatting toolbar.

- [ ] **Step 3: Report** screenshots + deviations. Done = verify green + all four checks pass.

---

## Self-review notes (already applied)

- **Spec §6 coverage:** Gates merge-evidence pane ✓ (T2); request-detail = trace timeline with waiting-on/decided-by, expandable why, inline steer notes + acks ✓ (T4), evidence block at gate ✓ (T4), gate approve/send-back + recovery + comments ✓ (T5); Activity de-chatted ✓ (T6). Deep-links ✓ (T6). Shared evidence strip promoted to kit per spec §7 ✓ (T1).
- **Honest deferral:** Take-over / Send-back-to-stage have no backend — explicitly out of scope with a code marker, so "nothing lost" (criterion 2) stays true (they were never real actions). All requests purge → Plan 5.
- **Placeholder scan:** every code step carries real code; "verify against kit.ts/styles.css names" are gates, with `issue.ts`/`queue.ts` named as the exact mirrors for modal/comment/keyboard idioms.
- **Type consistency:** `evidenceBits`/`EvidenceBit` (T1) consumed by `EvidenceStrip` (T1) and the merge pane (T2); `groupTrace`/`TraceGroup`/`TraceRow` (T3) consumed by the detail page (T4); `RequestDetail.run`/`.evidence` already in models from Plan 2.
- **No-flash:** the detail page mirrors `issue.ts`'s per-id effect (the one sanctioned component fetch); Mission/Gates keep consuming Store signals.
