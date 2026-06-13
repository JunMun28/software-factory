# Supervision Revamp — Plan 2: Mission Control UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Mission control home at `/admin/mission` — four supervision bands (Needs me · In flight · Stalled · Recent) over the Plan 1 backend — beside the existing views, leaving `make verify` green.

**Architecture:** One new self-contained page component (`web/src/app/admin/mission.ts`, the repo's page-per-file pattern) consuming a new `mission` projection on the shared `Store` (version-keyed refetch per poll bump, ADR 0013 single-seam). Gate actions reuse the kit's `ApproveModal`/`SendBackModal` and the queue's optimistic `api.X().subscribe(() => poll.nudge())` idiom. Pure display logic goes in `core/util.ts` where vitest covers it.

**Tech Stack:** Angular 22 standalone components, signals, vitest. Run web commands from `web/`: `npx ng test`, `npx ng lint`, `npx ng build`. Full gate: `make verify` from the repo root.

**Spec:** `docs/superpowers/specs/2026-06-12-ui-supervision-revamp-design.md` §6 "Mission control". This is phase 2 of 5 (spec §10 cutover step 2). Board/Pipeline/List stay untouched — deletion is Plan 5.

**Backend contract (live, Plan 1):** `GET /api/mission` returns

```json
{
  "gates":   [{ "request": {…RequestOut…}, "evidence": { "kind": "spec|merge",
                "grounded_lines": 2, "total_lines": 3, "interview_count": 0,
                "tests_passed": null, "tests_total": null, "diff_added": null,
                "diff_removed": null, "files_changed": null,
                "reviewer_verdict": null, "assumptions": ["…"] } | null }],
  "runs":    [{ "request": {…}, "run": { "step": 3, "of": 6, "label": "implementing the change",
                "health": "healthy|slow|no_signal", "seconds_since_event": 120 } }],
  "stalled": [{…RequestOut…}],
  "recent":  [{…RequestOut…}],
  "cursor":  18
}
```

`POST /api/requests/{id}/steer {note, actor}` → 201 `{id, status:"queued"}`, 409 when not in flight.

**Repo rules that bind every task:**
- Quiet-by-default visual language: at most ONE amber family and ONE red element per surface; status by shape (kit `sf-glyph`/`sf-sig`); hairlines not boxes; 8px rhythm; Micron purple `var(--a***)` accent ramp; mono (`.mono`) for refs.
- Polling never flashes: consume `Store` signals via `computed()`; never refetch-and-replace in component effects.
- Keyboard-first: every primary action has a key; follow `pipeline.ts`'s `@HostListener` J/K pattern and `admin-shell.ts`'s G-nav.
- Commit style: `feat(web): …` / `fix(web): …`.
- A dev stack may already be running (API :8001, web :4200, proxy `/tmp/sf-proxy-8001.json`). For visual checks reuse it; to refresh demo data: `make reset` then restart the API (fresh seed has REQ-2029 mid-build at step 3/6).

---

### Task 1: Plumbing — models, Api methods, Store projection

**Files:**
- Modify: `web/src/app/core/models.ts`
- Modify: `web/src/app/core/api.service.ts`
- Modify: `web/src/app/core/store.service.ts`

- [ ] **Step 1: Add the mission types to `core/models.ts`** (append at the end of the file)

```typescript
/** Derived run-state for an in-flight build (ADR 0014 — computed server-side, never stored). */
export interface RunState {
  step: number;
  of: number;
  label: string | null;
  health: 'healthy' | 'slow' | 'no_signal';
  seconds_since_event: number;
}

/** What the admin sees before approving (spec §6 evidence strip). */
export interface Evidence {
  kind: 'spec' | 'merge';
  grounded_lines: number | null;
  total_lines: number | null;
  interview_count: number | null;
  tests_passed: number | null;
  tests_total: number | null;
  diff_added: number | null;
  diff_removed: number | null;
  files_changed: number | null;
  reviewer_verdict: string | null;
  assumptions: string[];
}

export interface MissionGate {
  request: FactoryRequest;
  /** null → render "no evidence recorded" (legacy/pre-revamp gates). */
  evidence: Evidence | null;
}

export interface MissionRun {
  request: FactoryRequest;
  run: RunState;
}

/** One poll for the Mission control home (spec §6). */
export interface MissionOut {
  gates: MissionGate[];
  runs: MissionRun[];
  stalled: FactoryRequest[];
  recent: FactoryRequest[];
  cursor: number;
}
```

- [ ] **Step 2: Add Api methods** in `core/api.service.ts` — extend the models import with `MissionOut`, then add after the `inbox()` method:

```typescript
  mission() {
    return this.http.get<MissionOut>(`${BASE}/mission`);
  }
  steer(id: number, note: string, actor: string) {
    return this.http.post<{ id: number; status: string }>(`${BASE}/requests/${id}/steer`, {
      note,
      actor,
    });
  }
  trace(id: number, after = 0, limit = 200) {
    return this.http.get<{ items: ProgressEvent[]; cursor: number }>(
      `${BASE}/requests/${id}/trace`,
      { params: { after: String(after), limit: String(limit) } },
    );
  }
```

- [ ] **Step 3: Add the `mission` projection to `core/store.service.ts`** — extend the models import with `MissionOut`, add the signal next to the others, and the fetch inside the existing effect:

```typescript
  mission = signal<MissionOut | null>(null);
```

and inside the constructor effect, after the `inbox` line:

```typescript
      this.api.mission().subscribe((v) => this.mission.set(v));
```

Update the Store's class docstring sentence "The three shared projections" → "The shared projections".

- [ ] **Step 4: Build + lint**

Run: `cd web && npx ng build && npx ng lint`
Expected: clean build, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/models.ts web/src/app/core/api.service.ts web/src/app/core/store.service.ts
git commit -m "feat(web): mission/steer/trace plumbing — types, Api methods, Store projection"
```

---

### Task 2: Pure display helpers + vitest

**Files:**
- Modify: `web/src/app/core/util.ts`
- Modify: `web/src/app/core/util.spec.ts`

- [ ] **Step 1: Write the failing tests** — append to `web/src/app/core/util.spec.ts` (follow the file's existing describe/it style; check the import line at the top and extend it with `healthLine, elapsedShort`):

```typescript
describe('elapsedShort', () => {
  it('formats seconds under a minute', () => {
    expect(elapsedShort(8)).toBe('8s');
    expect(elapsedShort(59)).toBe('59s');
  });
  it('formats minutes with seconds', () => {
    expect(elapsedShort(60)).toBe('1m 00s');
    expect(elapsedShort(100)).toBe('1m 40s');
    expect(elapsedShort(3599)).toBe('59m 59s');
  });
  it('formats hours above an hour', () => {
    expect(elapsedShort(3600)).toBe('1h');
    expect(elapsedShort(9000)).toBe('2h 30m');
  });
});

describe('healthLine', () => {
  it('renders a healthy run', () => {
    expect(
      healthLine({ step: 3, of: 6, label: 'implementing the change', health: 'healthy', seconds_since_event: 100 }),
    ).toBe('implementing the change · 1m 40s · healthy');
  });
  it('renders a slow run', () => {
    expect(
      healthLine({ step: 2, of: 9, label: 'running the test suite', health: 'slow', seconds_since_event: 305 }),
    ).toBe('running the test suite · 5m 05s · slow');
  });
  it('renders no signal without a label', () => {
    expect(
      healthLine({ step: 0, of: 4, label: null, health: 'no_signal', seconds_since_event: 12 }),
    ).toBe('no signal for 12s');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && npx ng test`
Expected: FAIL — `elapsedShort`/`healthLine` not exported.

- [ ] **Step 3: Implement in `core/util.ts`** — extend the models import with `RunState`, append:

```typescript
/** Compact elapsed time for run rows: 8s · 1m 40s · 2h 30m. */
export function elapsedShort(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** The run row's one-line state: "label · elapsed · health", honest when silent. */
export function healthLine(run: RunState): string {
  if (run.health === 'no_signal' || !run.label)
    return `no signal for ${elapsedShort(run.seconds_since_event)}`;
  return `${run.label} · ${elapsedShort(run.seconds_since_event)} · ${run.health}`;
}
```

- [ ] **Step 4: Run tests**

Run: `cd web && npx ng test`
Expected: ALL PASS (40 existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/util.ts web/src/app/core/util.spec.ts
git commit -m "feat(web): elapsedShort + healthLine display helpers for run rows"
```

---

### Task 3: Route, nav entry, G M, scaffold page

**Files:**
- Create: `web/src/app/admin/mission.ts`
- Modify: `web/src/app/app.routes.ts`
- Modify: `web/src/app/admin/admin-shell.ts`

- [ ] **Step 1: Create the scaffold `web/src/app/admin/mission.ts`**

```typescript
import { Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';

import { Store } from '../core/store.service';
import { Icon } from '../kit/kit';
import { AdminShell } from './admin-shell';

/** Mission control — the supervision home (spec §6): what needs me, what's
 *  running autonomously, what stalled, what just finished. One poll
 *  (Store.mission), bands render top-down by consequence. */
@Component({
  selector: 'sf-mission-page',
  imports: [AdminShell, Icon],
  template: `
    <admin-shell active="mission" title="Mission control">
      <span headerExtra class="row" style="gap:10px">
        <span style="font-size:12.5px;color:var(--muted)">{{ subtitle() }}</span>
      </span>
      <div class="list scroll" style="padding:18px 0 40px">
        <div style="max-width:920px;margin:0 auto;padding:0 22px">
          @if (m(); as m) {
            <div class="msn-empty">
              <sf-icon name="check" [size]="20" color="var(--green)" />
              Mission control is live — bands land in the next tasks.
            </div>
          } @else {
            <div class="msn-empty">Loading…</div>
          }
        </div>
      </div>
    </admin-shell>
  `,
  styles: `
    .msn-empty {
      display: flex;
      align-items: center;
      gap: 10px;
      justify-content: center;
      padding: 48px 0;
      color: var(--muted);
      font-size: 13px;
    }
  `,
})
export class Mission {
  protected router = inject(Router);
  private store = inject(Store);

  m = this.store.mission;

  subtitle = computed(() => {
    const m = this.m();
    if (!m) return '';
    const g = m.gates.length;
    const r = m.runs.length;
    return `${g} gate${g === 1 ? '' : 's'} waiting on you · ${r} build${r === 1 ? '' : 's'} running`;
  });
}
```

- [ ] **Step 2: Add the route** in `web/src/app/app.routes.ts`, directly before the `admin/pipeline` entry (copy its guard line exactly — look at how the pipeline route declares `canActivate`):

```typescript
  {
    path: 'admin/mission',
    canActivate: [adminGuard],
    loadComponent: () => import('./admin/mission').then((m) => m.Mission),
  },
```

(Check the actual guard import/name used by the sibling admin routes and match it verbatim.)

- [ ] **Step 3: Add the nav row + G-nav** in `web/src/app/admin/admin-shell.ts`:

(a) Sidebar: directly ABOVE the Pipeline navrow button, insert:

```html
        <button class="navrow" [class.on]="active() === 'mission'" (click)="go('/admin/mission')">
          <span class="navrow__ic"><sf-icon name="pulse" [size]="17" /></span
          ><span class="navrow__label">Mission control</span>
          <span class="navrow__tip">Mission <kbd class="kbd">G</kbd><kbd class="kbd">M</kbd></span>
        </button>
```

First check `kit/kit.ts`'s `sf-icon` name map for an available icon (look at the `Icon` component's path table). If there is no `pulse` icon, pick the closest existing one (e.g. reuse `pipeline`) — do NOT hand-author new SVG paths in this task.

(b) G-nav: in the `nav` record inside `onKey`, add `m: '/admin/mission',`.

(c) If the shell's command palette has a JUMP-TO list of pages (search for where `palette` items are defined), add a "Mission control" entry following the same shape.

- [ ] **Step 4: Build, lint, visual check**

Run: `cd web && npx ng build && npx ng lint && npx ng test`
Expected: all green.

Then open `http://localhost:4200/admin/mission` (sign in via "Sign in as a reviewer" if logged out) — the scaffold renders inside the shell, nav row highlights, `G` then `M` navigates from another page.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/admin/mission.ts web/src/app/app.routes.ts web/src/app/admin/admin-shell.ts
git commit -m "feat(web): /admin/mission scaffold — route, nav row, G M"
```

---

### Task 4: Needs-me gates band (evidence strip + inline actions)

The hero band. Each gate card: title line (ref · title · gate pill · app), evidence strip, amber assumptions line, side-effect line, and the action cluster — Approve (A) / Send back (S) / open in queue. Approve/Send-back reuse the kit modals and the queue's optimistic idiom.

**Files:**
- Modify: `web/src/app/admin/mission.ts`

- [ ] **Step 1: Extend imports and component state**

Update the imports at the top of `mission.ts`:

```typescript
import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { Api } from '../core/api.service';
import { Poll } from '../core/poll.service';
import { SessionService } from '../core/session.service';
import { Store } from '../core/store.service';
import { Evidence, FactoryRequest, MissionGate } from '../core/models';
import { TYPE_SHORT, timeAgo } from '../core/util';
import { ApproveModal, Glyph, Icon, SendBackModal, Sig } from '../kit/kit';
import { AdminShell } from './admin-shell';
```

(Check the actual exported name of the session service in `core/session.service.ts` — the shell uses `session.user().name`; match it. Check `SendBackModal`/`ApproveModal` input/output names in `kit/kit.ts` — the queue at `admin/queue.ts` uses `<sf-approve-modal [r]="r" (cancelled)="…" (approved)="approve(r)" />` and a send-back equivalent; mirror the queue exactly, including the payload the send-back modal emits.)

Add to the `Mission` class:

```typescript
  private api = inject(Api);
  private poll = inject(Poll);
  protected session = inject(SessionService);

  confirming = signal<FactoryRequest | null>(null);
  sendingBack = signal<FactoryRequest | null>(null);

  gates = computed<MissionGate[]>(() => this.m()?.gates ?? []);

  gatePill(r: FactoryRequest) {
    return r.gate === 'approve_merge' ? 'MERGE GATE' : 'SPEC GATE';
  }

  /** spec gate: "3 of 4 lines grounded in answers"; merge gate: tests/diff/reviewer. */
  evidenceBits(ev: Evidence | null): { icon: string; text: string; tone: '' | 'green' | 'purple' }[] {
    if (!ev) return [{ icon: 'dotted', text: 'no evidence recorded', tone: '' }];
    if (ev.kind === 'spec') {
      const bits: { icon: string; text: string; tone: '' | 'green' | 'purple' }[] = [
        {
          icon: 'check',
          text: `${ev.grounded_lines ?? 0} of ${ev.total_lines ?? 0} lines grounded in answers`,
          tone: 'green',
        },
      ];
      if (ev.interview_count)
        bits.push({ icon: 'doc', text: `spec drafted from interview (${ev.interview_count} Q)`, tone: '' });
      return bits;
    }
    const bits: { icon: string; text: string; tone: '' | 'green' | 'purple' }[] = [];
    if (ev.tests_total != null)
      bits.push({ icon: 'check', text: `${ev.tests_passed}/${ev.tests_total} tests pass`, tone: 'green' });
    if (ev.diff_added != null)
      bits.push({
        icon: 'diff',
        text: `diff +${ev.diff_added} −${ev.diff_removed} · ${ev.files_changed} files`,
        tone: '',
      });
    if (ev.reviewer_verdict)
      bits.push({ icon: 'ring', text: `reviewer: ${ev.reviewer_verdict}`, tone: 'purple' });
    return bits.length ? bits : [{ icon: 'dotted', text: 'no evidence recorded', tone: '' }];
  }

  sideEffects(r: FactoryRequest): string {
    return r.gate === 'approve_merge'
      ? 'Approve merges to main · promotes to production'
      : 'Approve creates repo · writes SPEC.md PR · starts Architecture';
  }

  approve(r: FactoryRequest) {
    this.confirming.set(null);
    this.api.approve(r.id, this.session.user().name).subscribe(() => this.poll.nudge());
  }
  sendBack(r: FactoryRequest, note: string) {
    this.sendingBack.set(null);
    this.api.sendBack(r.id, note, this.session.user().name).subscribe(() => this.poll.nudge());
  }
  openInQueue(r: FactoryRequest) {
    this.router.navigate(['/admin/queue'], { queryParams: { sel: r.id } });
  }
```

For `evidenceBits` icon names: check the `sf-icon`/`sf-glyph` name tables in `kit/kit.ts` first and substitute the closest existing names (`check`, `dotted`, `ring` are glyph types; `doc`/`diff` icons may not exist — fall back to an existing icon or drop the icon for that bit). Do not invent new SVG.

- [ ] **Step 2: Replace the placeholder band markup**

In the template, replace the `msn-empty` success block with:

```html
            <!-- NEEDS ME — gates -->
            <div class="msn-bandhead">
              <sf-icon name="flag" [size]="13" color="var(--amber)" />
              <span>Needs me — gates</span>
              <span class="msn-count">{{ m.gates.length }}</span>
              <span class="msn-hint">grounded · A approve · S send back</span>
            </div>
            @for (g of m.gates; track g.request.id) {
              <div class="msn-gate" [class.msn-gate--merge]="g.request.gate === 'approve_merge'">
                <div class="msn-gate__top">
                  <sf-glyph type="ring" [size]="15" [fill]="0.5" color="var(--a500)" />
                  <span class="msn-gate__title">{{ g.request.title }}</span>
                  <span class="pill amber-pill">{{ gatePill(g.request) }}</span>
                  <span class="msn-meta">{{ g.request.app_name }}</span>
                  <span class="mono msn-ref">{{ g.request.ref }}</span>
                  <span style="margin-left:auto"></span>
                  <button class="btn primary sm" (click)="confirming.set(g.request)">
                    Approve <kbd class="kbd">A</kbd>
                  </button>
                  <button class="btn sm" (click)="sendingBack.set(g.request)">
                    Send back <kbd class="kbd">S</kbd>
                  </button>
                  <button class="btn sm" (click)="openInQueue(g.request)">Open</button>
                </div>
                <div class="msn-evid">
                  @for (bit of evidenceBits(g.evidence); track bit.text) {
                    <span class="msn-evid__bit" [class.green]="bit.tone === 'green'">{{ bit.text }}</span>
                  }
                </div>
                @if (g.evidence?.assumptions?.length) {
                  <div class="msn-assume">
                    ⚠ {{ g.evidence!.assumptions.length }} assumption{{
                      g.evidence!.assumptions.length === 1 ? '' : 's'
                    }}: {{ g.evidence!.assumptions[0] }}
                  </div>
                }
                <div class="msn-side">{{ sideEffects(g.request) }}</div>
              </div>
            } @empty {
              <div class="msn-clear">No gates waiting on you.</div>
            }
```

and after the closing `</admin-shell>`-internal scroll div (still inside the shell content), the modals — mirror `admin/queue.ts`'s modal usage verbatim:

```html
      @if (confirming(); as r) {
        <sf-approve-modal [r]="r" (cancelled)="confirming.set(null)" (approved)="approve(r)" />
      }
      @if (sendingBack(); as r) {
        <sf-send-back-modal … />
      }
```

For the send-back modal, copy the exact bindings the queue uses (it emits the note text — check `(sent)`/output names in kit.ts) and adapt to call `sendBack(r, note)`.

NOTE on the unicode `⚠`: check how the codebase renders warnings elsewhere (queue's open-questions block) — if it uses an `sf-icon`, use that instead of the literal glyph.

- [ ] **Step 3: Add band styles** (append to the component `styles`)

```css
    .msn-bandhead {
      display: flex;
      align-items: center;
      gap: 9px;
      margin: 22px 2px 10px;
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--fg2);
    }
    .msn-bandhead:first-child {
      margin-top: 0;
    }
    .msn-count {
      font-size: 11px;
      color: var(--faint);
      background: var(--surface-2);
      border-radius: 9px;
      padding: 0 7px;
      font-weight: 500;
    }
    .msn-hint {
      margin-left: auto;
      font-size: 11px;
      font-weight: 400;
      letter-spacing: 0;
      text-transform: none;
      color: var(--faint);
    }
    .msn-gate {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      padding: 13px 16px 11px;
      margin-bottom: 9px;
    }
    .msn-gate__top {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
    }
    .msn-gate__title {
      font-size: 13.5px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .amber-pill {
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.05em;
      color: var(--amber);
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
      border-radius: 4px;
      padding: 1.5px 6px;
    }
    .msn-meta {
      font-size: 11.5px;
      color: var(--muted);
      white-space: nowrap;
    }
    .msn-ref {
      font-size: 11px;
      color: var(--faint);
    }
    .msn-evid {
      display: flex;
      flex-wrap: wrap;
      gap: 5px 16px;
      margin: 9px 0 0 24px;
      font-size: 12px;
      color: var(--fg2);
    }
    .msn-evid__bit.green {
      color: var(--green-tx);
      font-weight: 500;
    }
    .msn-assume {
      margin: 5px 0 0 24px;
      font-size: 12px;
      color: var(--amber);
    }
    .msn-side {
      margin: 6px 0 0 24px;
      font-size: 11.5px;
      color: var(--faint);
    }
    .msn-clear {
      padding: 14px 16px;
      color: var(--muted);
      font-size: 12.5px;
    }
```

Check `var(--amber-bg)`, `var(--amber-line)`, `var(--green-tx)`, `var(--surface-2)`, `var(--r-lg)` exist in `web/src/styles.css` (pipeline.ts already uses most); substitute the file's actual token names if they differ.

- [ ] **Step 4: Build, lint, test, visual check**

`cd web && npx ng build && npx ng lint && npx ng test` — green.
Open `/admin/mission`: gate cards render with evidence, assumptions, side-effects; Approve opens the confirm modal naming side effects; approving moves the item out of the band on the next poll without a flash.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/admin/mission.ts
git commit -m "feat(web): mission needs-me band — gate cards with evidence strip and inline approve/send-back"
```

---

### Task 5: In-flight band + steer composer

**Files:**
- Modify: `web/src/app/admin/mission.ts`

- [ ] **Step 1: Component state + steer logic** — add to the class:

```typescript
  steeringId = signal<number | null>(null);
  steerText = signal('');
  steerErr = signal('');
  /** ids steered this session — renders the optimistic "note queued" chip until acked. */
  steered = signal<Set<number>>(new Set());

  openSteer(r: FactoryRequest) {
    this.steerErr.set('');
    this.steerText.set('');
    this.steeringId.set(this.steeringId() === r.id ? null : r.id);
  }
  sendSteer(r: FactoryRequest) {
    const note = this.steerText().trim();
    if (!note) return;
    this.api.steer(r.id, note, this.session.user().name).subscribe({
      next: () => {
        this.steeringId.set(null);
        this.steered.update((s) => new Set(s).add(r.id));
        this.poll.nudge();
      },
      error: (e) => {
        // 409 = no longer in flight (reached a gate mid-typing) — keep the text, say why
        this.steerErr.set(
          e?.status === 409 ? 'Run is no longer in flight — it reached a gate.' : 'Could not send — try again.',
        );
      },
    });
  }
```

Import `MissionRun`, `RunState` into the models import and `elapsedShort, healthLine` into the util import.

- [ ] **Step 2: Band markup** — after the gates band `@for/@empty` block:

```html
            <!-- IN FLIGHT — autonomous runs -->
            <div class="msn-bandhead">
              <sf-glyph type="dotted" [size]="13" color="var(--a500)" />
              <span>In flight — autonomous runs</span>
              <span class="msn-count">{{ m.runs.length }}</span>
              <span class="msn-hint">live run-state · steer to course-correct</span>
            </div>
            @for (it of m.runs; track it.request.id) {
              <div class="msn-run" [class.msn-run--slow]="it.run.health === 'slow'">
                <span class="msn-pulse" [class.amber]="it.run.health !== 'healthy'"></span>
                <div class="msn-run__id">
                  <span class="msn-run__title">{{ it.request.title }}</span>
                  <span class="msn-run__meta">
                    <span class="msn-stagepill">{{ it.request.stage }}</span>
                    {{ it.request.app_name }} <span class="mono msn-ref">{{ it.request.ref }}</span>
                  </span>
                </div>
                <div class="msn-progress">
                  <div class="msn-ptrack">
                    <div
                      class="msn-pfill"
                      [class.amber]="it.run.health === 'slow'"
                      [style.width.%]="it.run.of ? (100 * it.run.step) / it.run.of : 0"
                    ></div>
                  </div>
                  <span class="mono msn-pstep">step {{ it.run.step }} / {{ it.run.of }}</span>
                </div>
                <span class="msn-runstate" [class.amber-tx]="it.run.health === 'slow'">{{
                  healthLine(it.run)
                }}</span>
                @if (steered().has(it.request.id)) {
                  <span class="chip">note queued</span>
                }
                <button class="btn sm" (click)="openSteer(it.request)">Steer</button>
              </div>
              @if (steeringId() === it.request.id) {
                <div class="msn-steer">
                  <input
                    class="input"
                    placeholder="Add a constraint the next step must honor…"
                    [value]="steerText()"
                    (input)="steerText.set($any($event.target).value)"
                    (keydown.enter)="sendSteer(it.request)"
                    (keydown.escape)="steeringId.set(null)"
                    sfAutofocus
                  />
                  <button class="btn primary sm" (click)="sendSteer(it.request)">Send</button>
                  @if (steerErr()) {
                    <span class="msn-steer__err">{{ steerErr() }}</span>
                  }
                </div>
              }
            } @empty {
              <div class="msn-clear">Nothing running right now.</div>
            }
```

`healthLine` must be exposed on the class: `healthLine = healthLine;` (the repo pattern for template helpers, see `typeShort = TYPE_SHORT` in pipeline.ts). Check `sfAutofocus` directive export name in kit.ts and add it to `imports`.

- [ ] **Step 3: Styles** — append:

```css
    .msn-run {
      display: flex;
      align-items: center;
      gap: 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      padding: 10px 16px;
      margin-bottom: 8px;
    }
    .msn-run--slow {
      border-color: var(--amber-line);
    }
    .msn-pulse {
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--a500);
      position: relative;
    }
    .msn-pulse::after {
      content: '';
      position: absolute;
      inset: -5px;
      border-radius: 50%;
      border: 1px solid var(--a500);
      opacity: 0.35;
      animation: msn-pulse 1.8s var(--ease) infinite;
    }
    .msn-pulse.amber {
      background: var(--amber);
    }
    .msn-pulse.amber::after {
      border-color: var(--amber);
    }
    @keyframes msn-pulse {
      from { transform: scale(0.6); opacity: 0.5; }
      to { transform: scale(1.5); opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .msn-pulse::after { animation: none; }
    }
    .msn-run__id { min-width: 220px; flex: 1; min-width: 0; }
    .msn-run__title { display: block; font-size: 13.5px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .msn-run__meta { display: flex; align-items: center; gap: 8px;
      font-size: 11.5px; color: var(--muted); }
    .msn-stagepill { font-family: var(--mono-font, ui-monospace); font-size: 9.5px;
      letter-spacing: 0.05em; text-transform: uppercase; color: var(--a700);
      background: var(--a50); border-radius: 4px; padding: 1.5px 6px; }
    .msn-progress { flex: none; width: 130px; }
    .msn-ptrack { height: 5px; border-radius: 3px; background: var(--surface-3); overflow: hidden; }
    .msn-pfill { height: 100%; background: var(--a500); border-radius: 3px;
      transition: width var(--dur) var(--ease); }
    .msn-pfill.amber { background: var(--amber); }
    .msn-pstep { display: block; text-align: right; font-size: 10.5px;
      color: var(--muted); margin-top: 3px; }
    .msn-runstate { flex: none; min-width: 170px; font-size: 12px; color: var(--fg2); }
    .amber-tx { color: var(--amber); }
    .msn-steer { display: flex; align-items: center; gap: 8px;
      margin: -4px 0 8px 36px; }
    .msn-steer .input { flex: 1; }
    .msn-steer__err { font-size: 11.5px; color: var(--red); }
```

Check `var(--mono-font)` against styles.css (the codebase uses a `.mono` class — if no mono CSS variable exists, set `font-family` to match what `.mono` uses).

- [ ] **Step 4: Build, lint, test, visual + behavior check**

`cd web && npx ng build && npx ng lint && npx ng test` — green.

Behavior check with the live stack: `make reset`, restart the API on :8001 (`SIM_INTERVAL=8`), open `/admin/mission` — REQ-2029 shows mid-build with a moving progress bar (steps advance every ~8s, no flash). Click Steer, send a note, watch "note queued" appear, and within a tick the run's `why` carries "honoring note" (visible later in trace; here the chip is enough). Steer a run, approve it at its gate quickly, and confirm the 409 path renders the calm error.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/admin/mission.ts
git commit -m "feat(web): mission in-flight band — live run rows with health and inline steer"
```

---

### Task 6: Stalled + Recent bands + all-clear hero

**Files:**
- Modify: `web/src/app/admin/mission.ts`

- [ ] **Step 1: Class additions**

```typescript
  retry(r: FactoryRequest) {
    this.api.retry(r.id, this.session.user().name).subscribe(() => this.poll.nudge());
  }
  openIssue(r: FactoryRequest) {
    this.router.navigateByUrl(`/admin/issue/${r.id}`);
  }
  allClear = computed(() => {
    const m = this.m();
    return !!m && m.gates.length === 0 && m.stalled.length === 0;
  });
  recentLine(r: FactoryRequest): string {
    if (r.status === 'done') return 'deployed to production';
    if (r.status === 'cancelled') return 'cancelled';
    return 'sent back · waiting on the submitter';
  }
```

Import `timeAgo` if not already imported; expose `timeAgo = timeAgo;` for the template.

- [ ] **Step 2: Markup** — after the in-flight band; the all-clear hero replaces the gates band header when empty (wrap the gates band in `@if (!allClear())` is WRONG — gates band should hide only when empty AND stalled empty; simplest faithful structure below):

At the TOP of the bands (before the gates bandhead), add:

```html
            @if (allClear()) {
              <div class="msn-hero">
                <sf-glyph type="check" [size]="22" color="var(--green)" [fill]="1" />
                <div>
                  <div class="msn-hero__title">Nothing needs you</div>
                  <div class="msn-hero__sub">Gates clear · no escalations. Runs continue below.</div>
                </div>
              </div>
            }
```

and wrap the gates bandhead + cards in `@if (!allClear()) { … }` (the `@for … @empty` "No gates waiting on you" message is then only reachable when stalled items exist but gates are empty — correct: the hero already covers the fully-clear case).

After the in-flight band, add:

```html
            <!-- STALLED — needs a human -->
            @if (m.stalled.length) {
              <div class="msn-bandhead">
                <sf-icon name="flag" [size]="13" color="var(--red)" />
                <span>Needs a human — stalled</span>
                <span class="msn-count">{{ m.stalled.length }}</span>
              </div>
              @for (r of m.stalled; track r.id) {
                <div class="msn-gate msn-gate--red">
                  <div class="msn-gate__top">
                    <sf-glyph type="flag" [size]="15" color="var(--red)" />
                    <span class="msn-gate__title">{{ r.title }}</span>
                    <span class="pill red-pill">NEEDS HUMAN</span>
                    <span class="msn-meta">{{ r.app_name }}</span>
                    <span class="mono msn-ref">{{ r.ref }}</span>
                    <span style="margin-left:auto"></span>
                    <button class="btn sm" (click)="retry(r)">Retry stage</button>
                    <button class="btn sm" (click)="openIssue(r)">Open issue</button>
                  </div>
                  @if (r.needs_human_reason) {
                    <div class="msn-escal">{{ r.needs_human_reason }}</div>
                  }
                </div>
              }
            }

            <!-- RECENTLY DONE & WITH SUBMITTER -->
            @if (m.recent.length) {
              <div class="msn-bandhead">
                <sf-glyph type="check" [size]="13" color="var(--green)" />
                <span>Recently done &amp; with submitter</span>
              </div>
              @for (r of m.recent; track r.id) {
                <div class="msn-done" (click)="openIssue(r)">
                  <sf-glyph
                    [type]="r.status === 'done' ? 'check' : r.status === 'cancelled' ? 'strike' : 'flag'"
                    [size]="13"
                    [color]="r.status === 'done' ? 'var(--green)' : r.status === 'cancelled' ? 'var(--faint)' : 'var(--amber)'"
                  />
                  <span
                    class="msn-done__title"
                    [style.text-decoration]="r.status === 'cancelled' ? 'line-through' : ''"
                    >{{ r.title }}</span
                  >
                  <span class="msn-meta">{{ recentLine(r) }}</span>
                  <span class="mono msn-ref" style="margin-left:auto">{{ timeAgo(r.updated_at) }}</span>
                </div>
              }
            }
```

Check `sf-glyph`'s accepted `type` values in kit.ts (`dotted/ring/check/strike/flag` per the design system) and the exact input names (`type`, `size`, `fill`, `color`).

- [ ] **Step 3: Styles** — append:

```css
    .msn-gate--red { border-color: var(--red-line, #e7aea7); }
    .red-pill { font-size: 9.5px; font-weight: 600; letter-spacing: 0.05em;
      color: var(--red); background: var(--red-bg); border: 1px solid var(--red-line, #e7aea7);
      border-radius: 4px; padding: 1.5px 6px; }
    .msn-escal { margin: 8px 0 0 24px; font-size: 12.5px; color: var(--red); }
    .msn-done { display: flex; align-items: center; gap: 10px; padding: 8px 16px;
      border-bottom: 1px solid var(--hairline, var(--border)); font-size: 12.5px;
      color: var(--muted); cursor: pointer; }
    .msn-done__title { color: var(--fg1); font-weight: 500; }
    .msn-hero { display: flex; align-items: center; gap: 14px; justify-content: center;
      padding: 30px 0 8px; }
    .msn-hero__title { font-size: 15px; font-weight: 600; }
    .msn-hero__sub { font-size: 12px; color: var(--muted); }
```

Check `var(--red-bg)`, `var(--red-line)`, `var(--hairline)` against styles.css; pipeline.ts hardcodes `#e7aea7` for the red border — match whatever the codebase actually does.

- [ ] **Step 4: Build, lint, test, visual check**

All green; `/admin/mission` shows stalled REQ-2043 with its reason and Retry/Open, recent tail rows, and (after approving/cancelling everything amber+red on a scratch DB) the all-clear hero.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/admin/mission.ts
git commit -m "feat(web): mission stalled + recent bands and the all-clear hero"
```

---

### Task 7: J/K traversal + action keys

Mirror `pipeline.ts`'s `@HostListener` pattern: J/K move a focus ring across actionable rows (gates, runs, stalled — in render order), Enter opens, A approves the focused gate, S send-backs, T steers a focused run.

**Files:**
- Modify: `web/src/app/admin/mission.ts`

- [ ] **Step 1: Focus model** — add to the class:

```typescript
  focusIdx = signal(0);

  /** J/K traversal list: every actionable row in render order. */
  focusables = computed<{ kind: 'gate' | 'run' | 'stalled'; r: FactoryRequest }[]>(() => {
    const m = this.m();
    if (!m) return [];
    return [
      ...m.gates.map((g) => ({ kind: 'gate' as const, r: g.request })),
      ...m.runs.map((x) => ({ kind: 'run' as const, r: x.request })),
      ...m.stalled.map((r) => ({ kind: 'stalled' as const, r })),
    ];
  });
  flatIdx(r: FactoryRequest) {
    return this.focusables().findIndex((x) => x.r.id === r.id);
  }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.metaKey || e.ctrlKey) return;
    if (this.confirming() || this.sendingBack()) return; // modals own the keyboard
    const k = e.key.toLowerCase();
    const cur = this.focusables()[this.focusIdx()];
    if (k === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.focusIdx.update((s) => Math.min(this.focusables().length - 1, s + 1));
    } else if (k === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.focusIdx.update((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter' && cur) {
      e.preventDefault();
      this.openIssue(cur.r);
    } else if (k === 'a' && cur?.kind === 'gate') {
      e.preventDefault();
      this.confirming.set(cur.r);
    } else if (k === 's' && cur?.kind === 'gate') {
      e.preventDefault();
      this.sendingBack.set(cur.r);
    } else if (k === 't' && cur?.kind === 'run') {
      e.preventDefault();
      this.openSteer(cur.r);
    }
  }
```

- [ ] **Step 2: Focus ring in markup** — on `.msn-gate` (both bands' cards) and `.msn-run` add:

```html
  [class.msn-focus]="flatIdx(g.request) === focusIdx()"
```

(adjusting the expression per band: `g.request`, `it.request`, `r`), plus `tabindex="0"` and `(focus)="focusIdx.set(flatIdx(…))"` to keep mouse and keyboard in sync. Add the style:

```css
    .msn-focus { box-shadow: inset 0 0 0 2px var(--a500); }
```

Also update the band hint: gates band `msn-hint` becomes `J/K move · ↵ open · A approve · S send back`; runs band hint becomes `J/K move · T steer`.

- [ ] **Step 3: Build, lint, test, behavior check**

All green. On `/admin/mission`: J/K walks gates → runs → stalled; A on a gate opens the confirm; S opens send-back; T on a run opens the steer composer; keys are inert while a modal or the steer input is open.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/admin/mission.ts
git commit -m "feat(web): mission keyboard grammar — J/K traversal, A/S gate actions, T steer"
```

---

### Task 8: Full verification + visual proof

**Files:** none new (fixes only if checks fail)

- [ ] **Step 1: `make verify`** from the repo root — lint + pytest + vitest + build + smoke all green.

- [ ] **Step 2: Visual proof** (light mode; dark is Plan 4). With the dev stack running (API :8001 fresh-seeded, web :4200):
  1. Screenshot `/admin/mission` at 1440×900 — bands populated (gates with evidence, REQ-2029 running, REQ-2043 stalled, recent tail).
  2. Screenshot at 390×844 — content reflows without horizontal scroll (admin mobile is deprioritized; sanity only, no pixel-perfection bar).
  3. Watch two consecutive sim ticks (~8s apart): the run row's step advances and NOTHING else flashes (no whole-band re-render).
  4. Approve one spec gate via `A` → confirm modal names side effects → optimistic removal; the item leaves the band on the next poll.

- [ ] **Step 3: Report** the screenshots and any deviations. Done = verify green + all four checks pass.

---

## Self-review notes (already applied)

- **Spec §6 coverage:** four bands ✓ (Tasks 4–6), one poll ✓ (Store.mission, Task 1), evidence strip + assumptions + side-effect line ✓ (Task 4), inline A/S with side-effect-naming confirms ✓ (Task 4, kit modals), run rows with step/label/elapsed/health ✓ (Task 5), steer inline no-modal ✓ (Task 5), 409 steer error path ✓ (Task 5), stalled with reason verbatim + Retry/Open ✓ (Task 6), recent 7-day tail ✓ (backend) rendered ✓ (Task 6), all-clear hero ✓ (Task 6), keyboard ✓ (Task 7). Deferred per spec: `D` view-diff key (needs the Gates evidence pane — Plan 3); dark mode (Plan 4); route default flip + Board/Pipeline deletion (Plan 5).
- **Placeholder scan:** every code step carries the actual code; the deliberate "check kit.ts/styles.css token names first" instructions are verification gates, not gaps — kit input names and CSS variable names must be confirmed against source by the implementer, and the queue/pipeline files are named as the exact mirrors.
- **Type consistency:** `MissionOut/MissionGate/MissionRun/RunState/Evidence` (Task 1) match Plan 1's Pydantic schemas field-for-field; `healthLine(run)` consumes `RunState` (Task 2) and is used in Task 5; `focusables()` consumes the same `m()` signal.
- **Known risk:** kit modal output names (`(approved)`, `(sent)` etc.) are asserted from queue.ts usage — implementers must mirror queue.ts, which is the source of truth.
