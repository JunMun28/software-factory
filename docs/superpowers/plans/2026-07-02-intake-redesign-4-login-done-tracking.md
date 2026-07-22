# Intake Redesign 4 Login Done Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved Login, Done, My requests, and Request detail screens with honest copy, one shared submitter status vocabulary, and keyboard-accessible light/dark UI.

**Architecture:** Put the five-label submitter status contract in `@sf/shared` so both tracking screens render the same label, tone, and glyph from one function. Keep the screen implementations inside the existing standalone Angular components with inline templates/styles, using existing global tokens and kit atoms instead of adding a new design layer. The Done screen clears `IntakeDraft` before starting a new request so the frontend never reopens or PATCHes the completed request.

**Tech Stack:** Angular 22 standalone components, signals, inline templates/styles, `@sf/shared` models/API/util exports, Vitest component/service tests through Angular `TestBed`, Taskfile verification.

## Global Constraints

- Calm confirmation: request reference, "A person will review it next — usually within two working days", buttons View my requests / Start another request.
- No email promise anywhere.
- "Start another request" clears the draft and creates a fresh request; it must not reopen or PATCH the previous one.
- Restyled to the light warm language (replaces dark gradient).
- "Contact IT" becomes a real link (mailto or the org's support URL — implementer picks whichever the org standard is; a mailto to the existing support alias is acceptable). No dead spans.
- My requests: calm list, most recent first.
- Status pills in plain language only: Waiting for review (submitted, not yet approved)
- Status pills in plain language only: Needs your answer (send-back)
- Status pills in plain language only: Being built (approved through deploy in progress)
- Status pills in plain language only: Ready to use (deployed/done)
- Status pills in plain language only: Not going ahead (rejected/cancelled — with a gentle explanation on detail)
- Exactly one "needs your answer" band at the top when ≥1 request needs input, with the count and a single "Answer now" action (first such request).
- Request detail: milestone story — Sent → Understood → Approved → Being built → Ready to use — with dates, a one-sentence plain status line, the original ask, and a "See what we understood" section showing the confirmed spec.
- Send-back replies get a labeled input (not placeholder-only).
- No logs, PRs, or internal vocabulary (load-bearing rule 5).
- Internal statuses map to the five labels above in one shared mapping function used by both tracking screens.
- Light warm near-white canvas, white cards, one purple accent `#BD03F7` used only for primary actions, active states, and "your answer" provenance.
- Amber reserved for assumptions/needs-input; green for done/confirmed; red for errors.
- Micron Basis for UI text (fallback Inter/system); JetBrains Mono only for request refs (REQ-142) and file sizes.
- Body text ≥16px everywhere, including hints and helper copy (audit found 12–13.5px guidance).
- Secondary text may be 14px minimum, never below.
- Interactive targets ≥44px tall.
- Generous spacing; one h1 per screen at a consistent size (28px) across the flow.
- Dark mode: the intake shell already has a theme toggle; every new surface and color must pass in both themes (verified by screenshots).
- App picker: ARIA combobox pattern, fully keyboard operable.
- Interview options: radiogroup semantics with visible + programmatic selected state.
- Progress: `role="progressbar"` with value text matching "Question N of about M".
- Understanding panel and chat updates: `aria-live="polite"`.
- All inputs labeled (visible label or aria-label) — no placeholder-only labels.
- Focus moves to the new question/step heading on transition.
- Full flow passes a keyboard-only run; visible focus states throughout.
- No silent failures: every subscribe error handler renders copy + a retry.
- Error copy pattern: what happened, whether data is safe (only when true), what to do next. Plain, unalarming tone.
- The interview can always be exited forward ("Skip ahead to check").
- Draft autosave means refresh never loses form work; server persistence means refresh after Describe never duplicates requests.

### Task 1: Shared submitter status contract and API shapes

**Files:**
- Modify: `packages/shared/src/lib/models.ts:31-131`
- Modify: `packages/shared/src/lib/api.service.ts:5-70`
- Modify: `packages/shared/src/lib/util.ts:54-72`
- Modify: `packages/shared/src/lib/util.spec.ts:3-116`

**Interfaces:**
- Consumes: `FactoryRequest.status`, `FactoryRequest.stage`, `FactoryRequest.gate`, `RequestDetail.spec_lines`, `InterviewState.skip_assumption`, `InterviewState.remaining_estimate`
- Produces: `SubmitterStatusLabel`, `SubmitterStatusView`, `submitterStatus(r: FactoryRequest): SubmitterStatusView`, `plainStage(r: FactoryRequest): SubmitterStatusView`, `Api.review(id)`, `Api.confirmSpecLine(id,lineId,actor)`, `Api.correctSpecLine(id,lineId,actor,text)`, `Api.submit(id,note,actor)`

- [ ] **Step 1: Write the failing shared util/API/model test**

Replace the existing `plainStage` describe block in `packages/shared/src/lib/util.spec.ts:88-116` with this complete block:

```ts
describe('submitterStatus — the five approved submitter labels', () => {
  it('maps every internal lifecycle state to one approved plain label', () => {
    expect(plainStage(req({ status: 'submitted', stage: 'intake' })).label).toBe(
      'Waiting for review',
    );
    expect(plainStage(req({ status: 'pending_approval', stage: 'spec' })).label).toBe(
      'Waiting for review',
    );
    expect(plainStage(req({ status: 'sent_back', stage: 'spec' })).label).toBe(
      'Needs your answer',
    );
    expect(plainStage(req({ status: 'approved', stage: 'architecture' })).label).toBe(
      'Being built',
    );
    expect(plainStage(req({ status: 'approved', stage: 'build' })).label).toBe('Being built');
    expect(plainStage(req({ status: 'approved', stage: 'review' })).label).toBe('Being built');
    expect(plainStage(req({ status: 'done', stage: 'done' })).label).toBe('Ready to use');
    expect(plainStage(req({ status: 'cancelled' })).label).toBe('Not going ahead');
  });

  it('exports the same function under submitterStatus for new submitter screens', () => {
    const r = req({ status: 'sent_back', stage: 'spec' });
    expect(submitterStatus(r)).toEqual(plainStage(r));
  });

  it('never leaks factory, GitHub, or old tracking vocabulary', () => {
    const cases: FactoryRequest[] = [
      req({ status: 'submitted', stage: 'intake' }),
      req({ status: 'pending_approval', stage: 'spec' }),
      req({ status: 'approved', stage: 'architecture' }),
      req({ status: 'approved', stage: 'build' }),
      req({ status: 'approved', stage: 'review' }),
      req({ status: 'sent_back', stage: 'spec' }),
      req({ status: 'done', stage: 'done' }),
      req({ status: 'cancelled' }),
    ];
    for (const item of cases) {
      const label = plainStage(item).label.toLowerCase();
      for (const word of [
        'factory',
        'github',
        'pull request',
        'pr',
        'spec',
        'gate',
        'merge',
        'deployed',
        'cancelled',
        'submitted',
        'in review',
        'input',
      ]) {
        expect(label).not.toContain(word);
      }
    }
  });
});
```

Update the import list at `packages/shared/src/lib/util.spec.ts:4-23` so it imports `submitterStatus`:

```ts
import {
  adminStateLine,
  boardGlyph,
  clock,
  confirmSteps,
  elapsedShort,
  evidenceBits,
  gateLabel,
  groupTrace,
  healthLine,
  inFlight,
  liveStatus,
  missionRowLabel,
  missionSubtitle,
  missionSummary,
  plainActivity,
  plainStage,
  submitterStatus,
  timeAgo,
  utc,
} from './util';
```

- [ ] **Step 2: Run the shared test to verify it fails**

Run: `npx ng test shared --include packages/shared/src/lib/util.spec.ts --watch=false`

Expected: FAIL with TypeScript error `Module '"./util"' has no exported member 'submitterStatus'` and old-label assertions such as expected `Waiting for review` but received `Submitted`.

- [ ] **Step 3: Write the minimal shared model/API/util implementation**

In `packages/shared/src/lib/models.ts`, replace `SpecLine` and `InterviewState`, and add `extra_detail` plus the status view types exactly as shown:

```ts
export interface SpecLine {
  id: number;
  order: number;
  text: string;
  prov: string | null;
  assume: boolean;
}

export type SubmitterStatusLabel =
  | 'Waiting for review'
  | 'Needs your answer'
  | 'Being built'
  | 'Ready to use'
  | 'Not going ahead';

export interface SubmitterStatusView {
  label: SubmitterStatusLabel;
  glyph: string;
  tone: 'neutral' | 'amber' | 'purple' | 'green' | 'red';
  fill?: number;
}
```

Add this field to `FactoryRequest` after `impact_value`:

```ts
  extra_detail: string | null;
```

Replace `InterviewState` with:

```ts
export interface InterviewState {
  done: boolean;
  asked: number;
  total: number;
  question: string | null;
  sub: string | null;
  options: { t: string; d: string }[] | null;
  final: boolean;
  skip_assumption: string | null;
  remaining_estimate: number;
  turns: Turn[];
}
```

In `packages/shared/src/lib/util.spec.ts`, add `extra_detail: null,` to the `req()` fixture immediately after `impact_value: null,`.

In `packages/shared/src/lib/util.ts`, add `SubmitterStatusView` to the model imports and replace `plainStage` with:

```ts
/** Submitter status vocabulary: exactly five labels from the approved intake redesign. */
export function submitterStatus(r: FactoryRequest): SubmitterStatusView {
  if (r.status === 'cancelled') {
    return { label: 'Not going ahead', glyph: 'strike', tone: 'red' };
  }
  if (r.status === 'sent_back') {
    return { label: 'Needs your answer', glyph: 'flag', tone: 'amber' };
  }
  if (r.status === 'done') {
    return { label: 'Ready to use', glyph: 'check', tone: 'green' };
  }
  if (r.status === 'approved') {
    return { label: 'Being built', glyph: 'ring', tone: 'purple', fill: 0.45 };
  }
  return { label: 'Waiting for review', glyph: 'dotted', tone: 'neutral' };
}

/** Back-compat alias for existing screens; submitter screens should prefer submitterStatus. */
export const plainStage = submitterStatus;
```

In `packages/shared/src/lib/api.service.ts`, change `answer()` and `submit()`, then add the review/spec-line methods:

```ts
  answer(id: number, body: { answer?: string | null; skip?: boolean }) {
    return this.http.post<InterviewState>(`${BASE}/requests/${id}/interview`, body);
  }
  review(id: number) {
    return this.http.get<RequestDetail>(`${BASE}/requests/${id}/review`);
  }
  confirmSpecLine(id: number, lineId: number, actor: string) {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/spec-lines/${lineId}/confirm`, {
      actor,
    });
  }
  correctSpecLine(id: number, lineId: number, actor: string, text: string) {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/spec-lines/${lineId}/correct`, {
      actor,
      text,
    });
  }
  submit(id: number, note = '', actor = '') {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/submit`, { note, actor });
  }
```

- [ ] **Step 4: Run the shared test to verify it passes**

Run: `npx ng test shared --include packages/shared/src/lib/util.spec.ts --watch=false`

Expected: PASS with all `submitterStatus — the five approved submitter labels` assertions green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/lib/models.ts packages/shared/src/lib/api.service.ts packages/shared/src/lib/util.ts packages/shared/src/lib/util.spec.ts
git commit -m "feat(intake): add submitter status contract"
```

### Task 2: Login screen warm restyle and real Contact IT link

**Files:**
- Modify: `apps/intake/src/app/submitter/login.ts:7-91`
- Create: `apps/intake/src/app/submitter/login.spec.ts`

**Interfaces:**
- Consumes: `Session.signIn('submitter')`, `Router.navigateByUrl('/submit/new')`
- Produces: warm light login UI, accessible real mailto link `mailto:software-factory-support@micron.com`, 44px+ sign-in target, no dark gradient

- [ ] **Step 1: Write the failing component test**

Create `apps/intake/src/app/submitter/login.spec.ts` with:

```ts
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Session } from '../core/session.service';
import { Login } from './login';

function mockSession() {
  return { signIn: vi.fn() };
}

function mockRouter() {
  return { navigateByUrl: vi.fn() };
}

describe('Login', () => {
  let fixture: ComponentFixture<Login>;
  let session: ReturnType<typeof mockSession>;
  let router: ReturnType<typeof mockRouter>;

  beforeEach(() => {
    session = mockSession();
    router = mockRouter();
    TestBed.configureTestingModule({
      imports: [Login],
      providers: [
        { provide: Session, useValue: session },
        { provide: Router, useValue: router },
      ],
    });
    fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
  });

  it('uses the warm light canvas instead of the old dark hero gradient', () => {
    const host = fixture.nativeElement as HTMLElement;
    const page = host.querySelector('[data-testid="login-page"]') as HTMLElement;
    expect(page).toBeTruthy();
    expect(page.getAttribute('style') ?? '').toContain('background:var(--bg)');
    expect(host.textContent).toContain('Tell us what you need built.');
    expect(host.innerHTML).not.toContain('hero-waves.jpg');
    expect(host.innerHTML).not.toContain('background:#0A0512');
  });

  it('renders Contact IT as a real mailto link', () => {
    const link = fixture.nativeElement.querySelector(
      'a[href="mailto:software-factory-support@micron.com"]',
    ) as HTMLAnchorElement | null;
    expect(link).toBeTruthy();
    expect(link?.textContent?.trim()).toBe('Contact IT');
  });

  it('signs in as submitter and navigates to the new request flow', fakeAsync(() => {
    const button = fixture.nativeElement.querySelector('button[type="button"]') as HTMLButtonElement;
    button.click();
    tick(900);
    expect(session.signIn).toHaveBeenCalledWith('submitter');
    expect(router.navigateByUrl).toHaveBeenCalledWith('/submit/new');
  }));
});
```

- [ ] **Step 2: Run the login test to verify it fails**

Run: `npx ng test intake --include apps/intake/src/app/submitter/login.spec.ts --watch=false`

Expected: FAIL because `[data-testid="login-page"]` and the mailto link do not exist, while `hero-waves.jpg` and `background:#0A0512` still exist.

- [ ] **Step 3: Replace the login component with the minimal warm implementation**

Replace all of `apps/intake/src/app/submitter/login.ts` with:

```ts
import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { Mark } from '@sf/shared';
import { Session } from '../core/session.service';

/** S0 — Login / SSO front door in the approved warm intake language. */
@Component({
  selector: 'sf-login',
  imports: [Mark],
  template: `
    <div
      data-testid="login-page"
      style="min-height:100%;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:28px"
    >
      <main
        class="card fade-in"
        style="width:min(100%,420px);padding:34px 32px;display:flex;flex-direction:column;gap:20px;text-align:center;border-radius:10px"
      >
        <div style="display:flex;justify-content:center">
          <sf-mark [size]="34" />
        </div>
        <div>
          <h1 style="font-size:28px">AIRES</h1>
          <p style="font-size:16px;color:var(--muted);margin:8px 0 0">
            Tell us what you need built.
          </p>
        </div>
        <button
          type="button"
          class="btn primary lg block focusable"
          style="min-height:48px"
          (click)="signIn()"
          [style.opacity]="loading() ? 0.92 : 1"
          autofocus
        >
          @if (loading()) {
            <span
              style="width:15px;height:15px;border-radius:50%;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;display:inline-block"
              class="spin"
              aria-hidden="true"
            ></span>
            Opening Microsoft...
          } @else {
            <svg width="18" height="18" viewBox="0 0 18 18" style="flex:0 0 auto" aria-hidden="true">
              <rect x="0" y="0" width="8.25" height="8.25" fill="#F25022" />
              <rect x="9.75" y="0" width="8.25" height="8.25" fill="#7FBA00" />
              <rect x="0" y="9.75" width="8.25" height="8.25" fill="#00A4EF" />
              <rect x="9.75" y="9.75" width="8.25" height="8.25" fill="#FFB900" />
            </svg>
            Sign in with Microsoft
          }
        </button>
        <p style="font-size:16px;color:var(--muted);margin:0">
          No new password — use your Micron account.
        </p>
        <p style="font-size:16px;color:var(--muted);margin:0">
          Trouble signing in?
          <a
            class="focusable"
            href="mailto:software-factory-support@micron.com"
            style="color:var(--accent-link);font-weight:600;text-decoration:underline;text-underline-offset:3px"
            >Contact IT</a
          >
        </p>
      </main>
    </div>
  `,
})
export class Login {
  private session = inject(Session);
  private router = inject(Router);
  loading = signal(false);

  signIn() {
    if (this.loading()) return;
    this.loading.set(true);
    setTimeout(() => {
      this.session.signIn('submitter');
      this.router.navigateByUrl('/submit/new');
    }, 900);
  }
}
```

- [ ] **Step 4: Run the login test to verify it passes**

Run: `npx ng test intake --include apps/intake/src/app/submitter/login.spec.ts --watch=false`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/login.ts apps/intake/src/app/submitter/login.spec.ts
git commit -m "feat(intake): restyle login"
```

### Task 3: Done screen honest confirmation and fresh-start action

**Files:**
- Modify: `apps/intake/src/app/submitter/confirm.ts:1-105`
- Create: `apps/intake/src/app/submitter/confirm.spec.ts`

**Interfaces:**
- Consumes: `Api.request(id): Observable<RequestDetail>`, `IntakeDraft.reset()`, route param `id`
- Produces: Done confirmation copy with request ref in `.mono`, buttons `View my requests` and `Start another request`, `another()` clears draft before navigating to `/submit/new`

- [ ] **Step 1: Write the failing component test**

Create `apps/intake/src/app/submitter/confirm.spec.ts` with:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { Api, RequestDetail } from '@sf/shared';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Session } from '../core/session.service';
import { IntakeDraft } from './intake-draft.service';
import { Confirm } from './confirm';

const detail = {
  id: 42,
  ref: 'REQ-142',
  title: 'Expense export comes out empty',
  description: 'The export opens with no rows.',
  type: 'bug',
  urgency: 'normal',
  reach: null,
  impact_metric: null,
  impact_value: null,
  extra_detail: null,
  priority: 'Normal',
  app_id: 1,
  app_name: 'Expense Tool',
  app_key: 'expense',
  repo: null,
  prospective_repo: null,
  new_app_name: null,
  stage: 'intake',
  status: 'submitted',
  gate: null,
  needs_human: false,
  needs_human_reason: null,
  reporter: 'Jordan D.',
  reporter_initials: 'JD',
  labels: null,
  send_back_question: null,
  send_back_response: null,
  send_back_rounds: 0,
  repo_ready: false,
  spec_pr_open: false,
  stage2_fired: false,
  spec_open_note: null,
  created_at: '2026-07-02T01:00:00Z',
  updated_at: '2026-07-02T01:00:00Z',
  stage_entered_at: null,
  last_event: null,
  turns: [],
  spec_lines: [],
  comments: [],
  audit: [],
  duplicate: null,
  run: null,
  evidence: null,
} satisfies RequestDetail;

function mockSession() {
  return {
    user: () => ({
      name: 'Jordan D.',
      initials: 'JD',
      color: '#7A',
      email: 'j@example.com',
      role: 'submitter',
    }),
  };
}

describe('Confirm', () => {
  let fixture: ComponentFixture<Confirm>;
  let router: { navigateByUrl: ReturnType<typeof vi.fn> };
  let draft: { reset: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    router = { navigateByUrl: vi.fn() };
    draft = { reset: vi.fn() };
    TestBed.configureTestingModule({
      imports: [Confirm],
      providers: [
        { provide: Api, useValue: { request: vi.fn(() => of(detail)) } },
        { provide: Router, useValue: router },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: new Map([['id', '42']]) } } },
        { provide: Session, useValue: mockSession() },
        { provide: IntakeDraft, useValue: draft },
      ],
    });
    fixture = TestBed.createComponent(Confirm);
    fixture.detectChanges();
  });

  it('shows the approved honest done copy and no email promise', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain("It's in.");
    expect(text).toContain('REQ-142');
    expect(text).toContain('A person will review it next — usually within two working days.');
    expect(text).toContain('View my requests');
    expect(text).toContain('Start another request');
    expect(text.toLowerCase()).not.toContain('email');
    const ref = fixture.nativeElement.querySelector('.mono') as HTMLElement | null;
    expect(ref?.textContent?.trim()).toBe('REQ-142');
  });

  it('tracks through the list and starts another request from a cleared draft', () => {
    fixture.componentInstance.track();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/requests');
    fixture.componentInstance.another();
    expect(draft.reset).toHaveBeenCalledOnce();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/submit/new');
  });
});
```

- [ ] **Step 2: Run the Done test to verify it fails**

Run: `npx ng test intake --include apps/intake/src/app/submitter/confirm.spec.ts --watch=false`

Expected: FAIL because the current screen says `We'll email you when it's been reviewed.`, uses `Track this request` / `File another`, and `Confirm` does not inject or reset `IntakeDraft`.

- [ ] **Step 3: Replace the Done component with the minimal approved implementation**

Replace all of `apps/intake/src/app/submitter/confirm.ts` with:

```ts
import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { Api, Glyph, RequestDetail, TypeChip } from '@sf/shared';
import { IntakeDraft } from './intake-draft.service';
import { SubShell } from './sub-shell';

/** S4 — Submission confirmation: honest close, no notification promise. */
@Component({
  selector: 'sf-confirm',
  imports: [SubShell, Glyph, TypeChip],
  template: `
    <sub-shell active="new" [step]="3">
      <div
        class="sub-col narrow fade-in"
        style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:20px;padding-top:44px"
      >
        <span
          style="width:60px;height:60px;border-radius:50%;background:var(--green-bg);display:flex;align-items:center;justify-content:center"
          aria-hidden="true"
        >
          <sf-glyph type="check" [size]="34" color="var(--green)" />
        </span>
        @if (req(); as r) {
          <div>
            <h1 style="font-size:28px">
              It's in. <span class="mono" style="font-size:.75em;color:var(--fg2)">{{ r.ref }}</span>
            </h1>
            <p style="color:var(--muted);margin:10px auto 0;font-size:16px;max-width:430px">
              A person will review it next — usually within two working days. You can watch its
              progress any time in My requests.
            </p>
          </div>
          <div
            class="card"
            style="width:100%;padding:16px 18px;display:flex;align-items:center;gap:14px;text-align:left"
          >
            <div style="flex:1;min-width:0">
              <div style="font-size:16px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                {{ r.title }}
              </div>
              <div class="row" style="gap:8px;margin-top:8px">
                <sf-type-chip [t]="r.type" />
                <span style="font-size:14px;color:var(--muted)">{{ r.app_name }}</span>
              </div>
            </div>
            <span
              class="mono"
              style="font-size:14px;color:var(--fg2);background:var(--surface-2);padding:5px 10px;border-radius:6px"
              >{{ r.ref }}</span
            >
          </div>
        } @else {
          <h1 style="font-size:28px">It's in.</h1>
        }
        <div class="row" style="gap:10px;width:100%;margin-top:4px">
          <button type="button" class="btn primary lg" style="flex:1;min-height:48px" (click)="track()">
            View my requests
          </button>
          <button type="button" class="btn lg" style="flex:1;min-height:48px" (click)="another()">
            Start another request
          </button>
        </div>
      </div>
    </sub-shell>
  `,
})
export class Confirm {
  private api = inject(Api);
  private router = inject(Router);
  private draft = inject(IntakeDraft);
  id = Number(inject(ActivatedRoute).snapshot.paramMap.get('id'));
  req = signal<RequestDetail | null>(null);

  constructor() {
    this.api.request(this.id).subscribe((r) => this.req.set(r));
  }

  track() {
    this.router.navigateByUrl('/requests');
  }
  another() {
    this.draft.reset();
    this.router.navigateByUrl('/submit/new');
  }
}
```

- [ ] **Step 4: Run the Done test to verify it passes**

Run: `npx ng test intake --include apps/intake/src/app/submitter/confirm.spec.ts --watch=false`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/confirm.ts apps/intake/src/app/submitter/confirm.spec.ts
git commit -m "feat(intake): make done screen honest"
```

### Task 4: My requests list with one needs-answer band and five-label pills

**Files:**
- Modify: `apps/intake/src/app/submitter/my-requests.ts:1-143`
- Create: `apps/intake/src/app/submitter/my-requests.spec.ts`

**Interfaces:**
- Consumes: `Api.requests(): Observable<FactoryRequest[]>`, `Session.user().name`, `submitterStatus(r)`
- Produces: most-recent-first list, exactly one amber band when `sent_back` count is at least 1, `Answer now` targets first sent-back request, status pills from the five shared labels

- [ ] **Step 1: Write the failing component test**

Create `apps/intake/src/app/submitter/my-requests.spec.ts` with:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Api, FactoryRequest, Poll } from '@sf/shared';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Session } from '../core/session.service';
import { MyRequests } from './my-requests';

function request(over: Partial<FactoryRequest>): FactoryRequest {
  return {
    id: 1,
    ref: 'REQ-1',
    title: 'Request',
    description: '',
    type: 'enh',
    urgency: 'normal',
    reach: null,
    impact_metric: null,
    impact_value: null,
    extra_detail: null,
    priority: 'Normal',
    app_id: 1,
    app_name: 'App',
    app_key: 'app',
    repo: null,
    prospective_repo: null,
    new_app_name: null,
    stage: 'intake',
    status: 'submitted',
    gate: null,
    needs_human: false,
    needs_human_reason: null,
    reporter: 'Jordan D.',
    reporter_initials: 'JD',
    labels: null,
    send_back_question: null,
    send_back_response: null,
    send_back_rounds: 0,
    repo_ready: false,
    spec_pr_open: false,
    stage2_fired: false,
    spec_open_note: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    stage_entered_at: null,
    last_event: null,
    ...over,
  };
}

function mockSession() {
  return {
    user: () => ({
      name: 'Jordan D.',
      initials: 'JD',
      color: '#7A',
      email: 'j@example.com',
      role: 'submitter',
    }),
  };
}

describe('MyRequests', () => {
  let fixture: ComponentFixture<MyRequests>;
  let router: { navigateByUrl: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    router = { navigateByUrl: vi.fn() };
    const rows = [
      request({
        id: 9,
        ref: 'REQ-009',
        title: 'Older answer',
        status: 'sent_back',
        stage: 'spec',
        created_at: '2026-06-20T00:00:00Z',
      }),
      request({
        id: 10,
        ref: 'REQ-010',
        title: 'First answer needed',
        status: 'sent_back',
        stage: 'spec',
        created_at: '2026-07-01T00:00:00Z',
      }),
      request({
        id: 12,
        ref: 'REQ-012',
        title: 'Newest waiting',
        status: 'pending_approval',
        stage: 'spec',
        created_at: '2026-07-02T00:00:00Z',
      }),
      request({
        id: 7,
        ref: 'REQ-007',
        title: 'Ready request',
        status: 'done',
        stage: 'done',
        created_at: '2026-06-01T00:00:00Z',
      }),
    ];
    TestBed.configureTestingModule({
      imports: [MyRequests],
      providers: [
        { provide: Api, useValue: { requests: vi.fn(() => of(rows)) } },
        { provide: Poll, useValue: { start: vi.fn(), version: vi.fn(() => 1) } },
        { provide: Router, useValue: router },
        { provide: Session, useValue: mockSession() },
      ],
    });
    fixture = TestBed.createComponent(MyRequests);
    fixture.detectChanges();
  });

  it('renders exactly one needs-answer band with a count and one Answer now action', () => {
    const bands = fixture.nativeElement.querySelectorAll('[data-testid="needs-answer-band"]');
    expect(bands.length).toBe(1);
    expect(bands[0].textContent).toContain('2 requests need your answer before they can move on.');
    const actions = bands[0].querySelectorAll('button');
    expect(actions.length).toBe(1);
    expect(actions[0].textContent).toContain('Answer now');
    actions[0].click();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/requests/10');
  });

  it('sorts all visible requests most recent first and uses the five shared labels', () => {
    const rows = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="request-row"]'),
    ) as HTMLElement[];
    expect(rows.map((row) => row.querySelector('.reqrow__title')?.textContent?.trim())).toEqual([
      'Newest waiting',
      'First answer needed',
      'Older answer',
    ]);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Waiting for review');
    expect(text).toContain('Needs your answer');
    expect(text).not.toContain('Needs your input');
    expect(text).not.toContain('Spec drafted');
    expect(text).not.toContain('Submitted');
  });
});
```

- [ ] **Step 2: Run the My requests test to verify it fails**

Run: `npx ng test intake --include apps/intake/src/app/submitter/my-requests.spec.ts --watch=false`

Expected: FAIL because the current template renders one `.attn` band per sent-back row, does not include `[data-testid]` markers, removes sent-back rows from `rows()`, and uses old labels.

- [ ] **Step 3: Replace the My requests component with the minimal approved implementation**

Replace all of `apps/intake/src/app/submitter/my-requests.ts` with:

```ts
import { Component, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { Api, FactoryRequest, Icon, Pill, Poll, TypeChip, submitterStatus, timeAgo } from '@sf/shared';
import { Session } from '../core/session.service';
import { SubShell } from './sub-shell';

/** S4 — My Requests: calm tracking list with exactly one needs-answer band. */
@Component({
  selector: 'sf-my-requests',
  imports: [SubShell, Icon, Pill, TypeChip],
  template: `
    <sub-shell active="list">
      <div class="sub-col fade-in">
        <div class="row" style="justify-content:space-between;align-items:flex-end;margin-bottom:18px">
          <h1 style="font-size:28px">My requests</h1>
          <button type="button" class="btn primary" style="min-height:44px" (click)="go('/submit/new')">
            <sf-icon name="plus" [size]="16" /> New request
          </button>
        </div>

        @if (firstNeedsAnswer(); as first) {
          <div
            data-testid="needs-answer-band"
            class="attn lift fade-in"
            style="display:flex;align-items:center;gap:14px;margin-bottom:16px"
          >
            <sf-icon name="help" [size]="20" />
            <div style="flex:1;font-size:16px;font-weight:600;color:var(--amber-tx)">
              {{ needsAnswerCount() }} request{{ needsAnswerCount() === 1 ? '' : 's' }} need your
              answer before {{ needsAnswerCount() === 1 ? 'it' : 'they' }} can move on.
            </div>
            <button type="button" class="btn primary" style="min-height:44px" (click)="go('/requests/' + first.id)">
              Answer now
            </button>
          </div>
        }

        <div style="display:flex;flex-direction:column;gap:11px">
          @for (r of rows(); track r.id) {
            <button
              data-testid="request-row"
              type="button"
              class="reqrow focusable"
              style="width:100%;text-align:left;font-family:inherit;min-height:72px"
              (click)="go('/requests/' + r.id)"
            >
              <div class="reqrow__main">
                <div class="reqrow__title" [class.strike]="r.status === 'cancelled'">
                  {{ r.title }}
                </div>
                <div class="reqrow__meta">
                  <sf-type-chip [t]="r.type" /><span
                    ><span class="mono">{{ r.ref }}</span> · {{ r.app_name }} · sent {{ age(r.created_at) }}</span
                  >
                </div>
              </div>
              <sf-pill [tone]="status(r).tone" [glyph]="status(r).glyph" [fill]="status(r).fill ?? 0.45">{{
                status(r).label
              }}</sf-pill>
            </button>
          } @empty {
            <div style="text-align:center;padding:30px;color:var(--faint);font-size:16px">
              Nothing here yet — start your first request.
            </div>
          }
        </div>
      </div>
    </sub-shell>
  `,
})
export class MyRequests {
  private router = inject(Router);
  private session = inject(Session);
  private poll = inject(Poll);
  private api = inject(Api);

  private requests = signal<FactoryRequest[]>([]);

  all = computed(() => this.requests().filter((r) => r.reporter === this.session.user().name));
  rows = computed(() =>
    [...this.all()]
      .filter((r) => r.status !== 'cancelled' && r.status !== 'done')
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
  );
  needsAnswer = computed(() =>
    this.rows().filter((r) => r.status === 'sent_back').sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
  );
  firstNeedsAnswer = computed(() => this.needsAnswer()[0] ?? null);
  needsAnswerCount = computed(() => this.needsAnswer().length);

  constructor() {
    this.poll.start();
    effect(() => {
      this.poll.version();
      this.api.requests().subscribe((v) => this.requests.set(v));
    });
  }

  status = submitterStatus;
  age = timeAgo;
  go(url: string) {
    this.router.navigateByUrl(url);
  }
}
```

- [ ] **Step 4: Run the My requests test to verify it passes**

Run: `npx ng test intake --include apps/intake/src/app/submitter/my-requests.spec.ts --watch=false`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/my-requests.ts apps/intake/src/app/submitter/my-requests.spec.ts
git commit -m "feat(intake): simplify request tracking list"
```

### Task 5: Request detail milestone story, original ask, understood spec, and labeled reply

**Files:**
- Modify: `apps/intake/src/app/submitter/request-detail.ts:1-272`
- Create: `apps/intake/src/app/submitter/request-detail.spec.ts`

**Interfaces:**
- Consumes: `Api.request(id): Observable<RequestDetail>`, `Api.respond(id,note,actor): Observable<RequestDetail>`, `Session.user().name`, `submitterStatus(r)`, `RequestDetail.spec_lines`, `RequestDetail.description`, `RequestDetail.spec_open_note`, `RequestDetail.send_back_question`
- Produces: milestone story labels `Sent`, `Understood`, `Approved`, `Being built`, `Ready to use`; `statusLine(r)` plain sentence; visible `label for="send-back-reply"`; `See what we understood` section with confirmed spec lines; gentle `Not going ahead` explanation; no email promise

- [ ] **Step 1: Write the failing component test**

Create `apps/intake/src/app/submitter/request-detail.spec.ts` with:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { Api, Poll, RequestDetail } from '@sf/shared';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Session } from '../core/session.service';
import { SubRequestDetail } from './request-detail';

function detail(over: Partial<RequestDetail> = {}): RequestDetail {
  return {
    id: 42,
    ref: 'REQ-142',
    title: 'Faster search in the parts catalog',
    description:
      'Searching the parts catalog takes 30+ seconds and people give up. Can it be instant, like normal search?',
    type: 'enh',
    urgency: 'normal',
    reach: 'team',
    impact_metric: null,
    impact_value: null,
    extra_detail: null,
    priority: 'Normal',
    app_id: 1,
    app_name: 'Parts Catalog',
    app_key: 'parts',
    repo: null,
    prospective_repo: null,
    new_app_name: null,
    stage: 'build',
    status: 'approved',
    gate: null,
    needs_human: false,
    needs_human_reason: null,
    reporter: 'Jordan D.',
    reporter_initials: 'JD',
    labels: null,
    send_back_question: null,
    send_back_response: null,
    send_back_rounds: 0,
    repo_ready: false,
    spec_pr_open: false,
    stage2_fired: true,
    spec_open_note: null,
    created_at: '2026-05-28T00:00:00Z',
    updated_at: '2026-06-02T00:00:00Z',
    stage_entered_at: '2026-06-02T00:00:00Z',
    last_event: null,
    turns: [],
    spec_lines: [
      {
        id: 1,
        order: 1,
        text: 'Search results should return quickly enough that users stay in flow.',
        prov: 'submitter-confirmed',
        assume: false,
      },
      {
        id: 2,
        order: 2,
        text: 'The first release should focus on the parts catalog search path.',
        prov: 'submitter-corrected',
        assume: false,
      },
    ],
    comments: [],
    audit: [],
    duplicate: null,
    run: null,
    evidence: null,
    ...over,
  };
}

function mockSession() {
  return {
    user: () => ({
      name: 'Jordan D.',
      initials: 'JD',
      color: '#7A',
      email: 'j@example.com',
      role: 'submitter',
    }),
  };
}

describe('SubRequestDetail', () => {
  let fixture: ComponentFixture<SubRequestDetail>;
  let api: { request: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };

  function render(d: RequestDetail) {
    api = {
      request: vi.fn(() => of(d)),
      respond: vi.fn(() => of({ ...d, status: 'pending_approval', send_back_response: 'Answer' })),
    };
    TestBed.configureTestingModule({
      imports: [SubRequestDetail],
      providers: [
        { provide: Api, useValue: api },
        { provide: Poll, useValue: { start: vi.fn(), version: vi.fn(() => 1), nudge: vi.fn() } },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: new Map([['id', '42']]) } } },
        { provide: Session, useValue: mockSession() },
      ],
    });
    fixture = TestBed.createComponent(SubRequestDetail);
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the plain milestone story, original ask, and understood spec lines', () => {
    render(detail());
    const text = fixture.nativeElement.textContent as string;
    for (const label of ['Sent', 'Understood', 'Approved', 'Being built', 'Ready to use']) {
      expect(text).toContain(label);
    }
    expect(text).toContain("It's being built now");
    expect(text).toContain('What you asked for');
    expect(text).toContain('Searching the parts catalog takes 30+ seconds');
    expect(text).toContain('See what we understood');
    expect(text).toContain('Search results should return quickly enough');
    expect(text).not.toContain('Spec drafted');
    expect(text).not.toContain('In review');
    expect(text).not.toContain('Deployed');
    expect(text.toLowerCase()).not.toContain('email');
  });

  it('uses a visible label for send-back replies and the approved needs-answer wording', () => {
    render(
      detail({
        status: 'sent_back',
        stage: 'spec',
        send_back_question: 'Which team needs this first?',
      }),
    );
    const label = fixture.nativeElement.querySelector('label[for="send-back-reply"]') as HTMLLabelElement;
    const textarea = fixture.nativeElement.querySelector('#send-back-reply') as HTMLTextAreaElement;
    const text = fixture.nativeElement.textContent as string;
    expect(label?.textContent).toContain('Your answer');
    expect(textarea).toBeTruthy();
    expect(text).toContain('Needs your answer');
    expect(text).not.toContain('placeholder');
  });

  it('shows a gentle not-going-ahead explanation for cancelled requests', () => {
    render(detail({ status: 'cancelled', stage: 'spec', spec_open_note: 'Not enough team impact yet.' }));
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Not going ahead');
    expect(text).toContain('This request is not moving forward right now.');
    expect(text).toContain('Not enough team impact yet.');
  });
});
```

- [ ] **Step 2: Run the Request detail test to verify it fails**

Run: `npx ng test intake --include apps/intake/src/app/submitter/request-detail.spec.ts --watch=false`

Expected: FAIL because the current screen uses `Spec drafted`, `In review`, `Deployed`, placeholder-only reply text, no original ask/spec sections, and an email promise after send-back.

- [ ] **Step 3: Replace the Request detail component with the minimal approved implementation**

Replace all of `apps/intake/src/app/submitter/request-detail.ts` with:

```ts
import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import {
  Api,
  Glyph,
  Icon,
  Pill,
  Poll,
  RequestDetail,
  TypeChip,
  clock,
  submitterStatus,
  timeAgo,
} from '@sf/shared';
import { Session } from '../core/session.service';
import { SubShell } from './sub-shell';

interface Milestone {
  title: 'Sent' | 'Understood' | 'Approved' | 'Being built' | 'Ready to use';
  meta: string;
  state: 'done' | 'active' | 'future';
}

/** S5 — Request detail as a plain milestone story for the submitter. */
@Component({
  selector: 'sf-sub-detail',
  imports: [SubShell, Glyph, Icon, Pill, TypeChip, FormsModule],
  template: `
    <sub-shell active="list">
      <div class="sub-col fade-in">
        <button
          type="button"
          class="btn ghost sm"
          style="margin-bottom:8px;margin-left:-8px;color:var(--muted);min-height:44px"
          (click)="go('/requests')"
        >
          <sf-icon name="back" [size]="15" /> My requests
        </button>
        @if (req(); as r) {
          <div class="sr-only" role="status" aria-live="polite">{{ statusLine(r) }}</div>
          <div class="row" style="justify-content:space-between;align-items:flex-start;gap:14px">
            <div>
              <div style="font-size:14px;color:var(--muted);margin-bottom:6px">
                <span class="mono">{{ r.ref }}</span> · {{ typeLabel(r.type) }} · {{ r.app_name }}
              </div>
              <h1 style="font-size:28px">{{ r.title }}</h1>
            </div>
            <sf-pill [tone]="status(r).tone" [glyph]="status(r).glyph" [fill]="status(r).fill ?? 0.45">{{
              status(r).label
            }}</sf-pill>
          </div>

          @if (r.status === 'sent_back' && !sent()) {
            <div class="attn lift fade-in" style="margin-top:20px">
              <div style="font-size:16px;font-weight:700;color:var(--amber-tx);margin-bottom:8px">
                Needs your answer
              </div>
              <div class="attn__q">"{{ r.send_back_question }}"</div>
              <label
                for="send-back-reply"
                style="display:block;font-size:16px;font-weight:600;color:var(--amber-tx);margin:12px 0 6px"
                >Your answer</label
              >
              <textarea
                id="send-back-reply"
                class="input area"
                style="background:var(--surface);font-size:16px"
                [(ngModel)]="reply"
              ></textarea>
              <div style="margin-top:12px">
                <button
                  type="button"
                  class="btn primary"
                  style="min-height:44px"
                  [disabled]="!reply.trim()"
                  (click)="respond(r)"
                >
                  Send answer <sf-icon name="arrowRight" [size]="16" />
                </button>
              </div>
            </div>
          }
          @if (sent()) {
            <div
              class="card fade-in"
              style="margin-top:20px;padding:14px 16px;display:flex;align-items:center;gap:10px;background:var(--green-bg);border-color:var(--green-line)"
            >
              <sf-glyph type="check" [size]="18" color="var(--green)" />
              <span style="font-size:16px;color:var(--green-tx)">
                Thanks — your answer is back with the reviewer.
              </span>
            </div>
          }
          @if (r.status === 'cancelled') {
            <div
              class="card fade-in"
              style="margin-top:20px;padding:14px 16px;display:flex;align-items:flex-start;gap:10px"
            >
              <sf-glyph type="strike" [size]="18" color="var(--red)" />
              <span style="font-size:16px;color:var(--muted)">
                This request is not moving forward right now.
                @if (r.spec_open_note) {
                  {{ r.spec_open_note }}
                } @else {
                  You can start a new request if the need changes.
                }
              </span>
            </div>
          }

          <div class="detail-milestones" aria-label="Request milestones">
            @for (m of milestones(); track m.title) {
              <div class="detail-milestone" [class.done]="m.state === 'done'" [class.active]="m.state === 'active'">
                <div class="detail-milestone__title">{{ m.title }}</div>
                <div class="detail-milestone__meta">{{ m.meta }}</div>
              </div>
            }
          </div>

          <p style="font-size:16px;color:var(--fg2);margin:18px 0 0">{{ statusLine(r) }}</p>

          <section class="card" style="margin-top:20px;padding:18px">
            <h2 style="font-size:18px">What you asked for</h2>
            <p style="font-size:16px;color:var(--muted);font-style:italic;margin:10px 0 0">
              "{{ r.description }}"
            </p>
          </section>

          <section class="card" style="margin-top:14px;padding:18px" aria-live="polite">
            <h2 style="font-size:18px">See what we understood</h2>
            @if (confirmedSpecLines(r).length) {
              <ul style="display:flex;flex-direction:column;gap:10px;margin:12px 0 0;padding:0;list-style:none">
                @for (line of confirmedSpecLines(r); track line.id) {
                  <li style="display:flex;gap:10px;font-size:16px;color:var(--fg2)">
                    <sf-glyph type="check" [size]="17" color="var(--green)" />
                    <span>{{ line.text }}</span>
                  </li>
                }
              </ul>
            } @else {
              <p style="font-size:16px;color:var(--muted);margin:10px 0 0">
                The reviewer will write up what they understood after reading your request.
              </p>
            }
          </section>
        }
      </div>
    </sub-shell>
  `,
  styles: `
    .detail-milestones {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 8px;
      margin-top: 22px;
    }
    .detail-milestone {
      border: 1px solid var(--border);
      background: var(--surface);
      border-radius: var(--r);
      padding: 11px 10px;
      min-height: 68px;
    }
    .detail-milestone.done {
      border-color: var(--green-line);
      background: var(--green-bg);
    }
    .detail-milestone.active {
      border-color: var(--accent-tint-bd);
      background: var(--a50);
    }
    .detail-milestone__title {
      font-size: 16px;
      font-weight: 700;
      color: var(--fg1);
    }
    .detail-milestone__meta {
      font-size: 14px;
      color: var(--muted);
      margin-top: 3px;
    }
    @media (max-width: 700px) {
      .detail-milestones {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class SubRequestDetail {
  private api = inject(Api);
  private router = inject(Router);
  private session = inject(Session);
  private poll = inject(Poll);
  id = Number(inject(ActivatedRoute).snapshot.paramMap.get('id'));

  req = signal<RequestDetail | null>(null);
  sent = signal(false);
  reply = '';

  constructor() {
    this.poll.start();
    effect(() => {
      this.poll.version();
      this.api.request(this.id).subscribe((r) => this.req.set(r));
    });
  }

  status = submitterStatus;
  age = timeAgo;

  go(url: string) {
    this.router.navigateByUrl(url);
  }

  respond(r: RequestDetail) {
    this.api.respond(r.id, this.reply.trim(), this.session.user().name).subscribe((d) => {
      this.req.set(d as RequestDetail);
      this.reply = '';
      this.sent.set(true);
      this.poll.nudge();
    });
  }

  confirmedSpecLines(r: RequestDetail) {
    return [...r.spec_lines].filter((line) => !line.assume).sort((a, b) => a.order - b.order);
  }

  milestones = computed<Milestone[]>(() => {
    const r = this.req();
    if (!r) return [];
    const created = this.dateLabel(r.created_at);
    const updated = this.dateLabel(r.updated_at);
    const understoodDone = r.status !== 'submitted';
    const approvedDone = r.status === 'approved' || r.status === 'done';
    const buildingActive = r.status === 'approved' && r.stage !== 'done';
    const readyDone = r.status === 'done';
    return [
      { title: 'Sent', meta: created, state: 'done' },
      {
        title: 'Understood',
        meta: understoodDone ? updated : 'next',
        state: understoodDone ? 'done' : 'active',
      },
      {
        title: 'Approved',
        meta: approvedDone ? updated : 'after review',
        state: approvedDone ? 'done' : r.status === 'pending_approval' ? 'active' : 'future',
      },
      {
        title: 'Being built',
        meta: readyDone ? 'done' : buildingActive ? 'now' : 'after approval',
        state: readyDone ? 'done' : buildingActive ? 'active' : 'future',
      },
      {
        title: 'Ready to use',
        meta: readyDone ? updated : '—',
        state: readyDone ? 'done' : 'future',
      },
    ];
  });

  statusLine(r: RequestDetail): string {
    if (r.status === 'sent_back') return 'A reviewer has a question before this can move on.';
    if (r.status === 'cancelled') return 'This request is not moving forward right now.';
    if (r.status === 'done') return 'This is ready to use.';
    if (r.status === 'approved') return "A reviewer approved this. It's being built now.";
    if (r.status === 'pending_approval') return 'A person is reviewing what we understood.';
    return 'A person will review it next — usually within two working days.';
  }

  typeLabel(t: RequestDetail['type']) {
    if (t === 'bug') return 'Bug fix';
    if (t === 'enh') return 'Enhancement';
    if (t === 'new') return 'New app';
    return 'Other';
  }

  private dateLabel(iso: string) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return clock(iso);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}
```

- [ ] **Step 4: Run the Request detail test to verify it passes**

Run: `npx ng test intake --include apps/intake/src/app/submitter/request-detail.spec.ts --watch=false`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/request-detail.ts apps/intake/src/app/submitter/request-detail.spec.ts
git commit -m "feat(intake): rebuild request detail story"
```

### Task 6: Final screen-level accessibility, copy, and theme verification

**Files:**
- Inspect: `apps/intake/src/app/submitter/login.ts`
- Inspect: `apps/intake/src/app/submitter/confirm.ts`
- Inspect: `apps/intake/src/app/submitter/my-requests.ts`
- Inspect: `apps/intake/src/app/submitter/request-detail.ts`
- Inspect: `packages/shared/src/lib/util.ts:54-75`

**Interfaces:**
- Consumes: all previous tasks
- Produces: no forbidden wording, no undersized body copy/targets introduced in these screens, passing targeted unit tests, passing intake build, passing repo verify

- [ ] **Step 1: Run copy and vocabulary checks**

Run:

```bash
rg -n "We'll email|you'll hear|email you|Needs your input|Spec drafted|Submitted|In review|Deployed|Cancelled|Track this request|File another|Contact IT</span|hero-waves|background:#0A0512|GitHub|pull request|\\bPR\\b|merge" apps/intake/src/app/submitter/login.ts apps/intake/src/app/submitter/confirm.ts apps/intake/src/app/submitter/my-requests.ts apps/intake/src/app/submitter/request-detail.ts
sed -n '54,75p' packages/shared/src/lib/util.ts | rg -n "Submitted|Spec drafted|Needs your input|Building|In review|Deployed|Cancelled|GitHub|pull request|\\bPR\\b|merge"
```

Expected: exit code 1 with no matches. If there is a match, replace it with the approved wording from this plan before continuing.

- [ ] **Step 2: Run target and tiny-text checks**

Run:

```bash
rg -n "font-size:(10|11|12|12\\.5|13|13\\.5)px|placeholder=|min-height:(3[0-9]|4[0-3])px" apps/intake/src/app/submitter/login.ts apps/intake/src/app/submitter/confirm.ts apps/intake/src/app/submitter/my-requests.ts apps/intake/src/app/submitter/request-detail.ts
```

Expected: exit code 1 with no matches. If there is a match, change helper/body text to at least `font-size:16px`, secondary metadata to at least `font-size:14px`, and button/input targets to at least `min-height:44px`.

- [ ] **Step 3: Run all targeted frontend tests**

Run:

```bash
npx ng test shared --include packages/shared/src/lib/util.spec.ts --watch=false
npx ng test intake --include apps/intake/src/app/submitter/login.spec.ts --watch=false
npx ng test intake --include apps/intake/src/app/submitter/confirm.spec.ts --watch=false
npx ng test intake --include apps/intake/src/app/submitter/my-requests.spec.ts --watch=false
npx ng test intake --include apps/intake/src/app/submitter/request-detail.spec.ts --watch=false
```

Expected: each command exits 0 and reports PASS.

- [ ] **Step 4: Run build and full verification**

Run:

```bash
npx ng build intake
task verify
```

Expected: Angular build succeeds and `task verify` ends with `✓ VERIFY PASSED`.

- [ ] **Step 5: Commit verification-only fixes**

If Step 1 or Step 2 required edits, commit them:

```bash
git add apps/intake/src/app/submitter/login.ts apps/intake/src/app/submitter/confirm.ts apps/intake/src/app/submitter/my-requests.ts apps/intake/src/app/submitter/request-detail.ts packages/shared/src/lib/util.ts
git commit -m "fix(intake): polish tracking accessibility"
```

If Step 1 and Step 2 required no edits, do not create an empty commit. Record the passing commands in the PR description instead.
