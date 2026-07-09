# Intake Redesign 3 Interview And Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved Questions and Check screens so submitters can answer, skip, recover from failures, confirm assumptions, add final notes, and send the request to a reviewer without losing data.

**Architecture:** Extend the shared API contract first, then build one reusable understanding panel consumed by both screens. Keep screen state local to standalone Angular components with signals, inline templates, inline styles, and server persistence through `Api`.

**Tech Stack:** Angular 22 standalone components, signals, inline templates/styles, `@sf/shared` API service, RxJS Observables, Vitest through `npx ng test`, CSS variables from `web/src/styles.css` and existing global tokens.

## Global Constraints

- One input surface per question: option questions render 2–4 radio-semantics buttons with one-line explanations and a "Type my own answer instead" swap link; free-text questions render only the composer.
- Typed text can never silently override a visually selected option.
- Honest progress: "Question 2 of about 4" from the API's remaining-question estimate; thin bar reflects the same number.
- Skip is per-question and always visible, with its consequence: "Skip this question — we'll assume ⟨assumption⟩, and you can correct that on the next step."
- Understanding panel (new component, right column ≥861px, below the question on mobile): "What we understood so far" — items appear as answers land, each with a source line ("from your description" / "from your answer · question N"); skipped questions appear as amber "assumed" items; remaining questions show as a single muted "About N more questions" row.
- Panel is `aria-live="polite"`.
- Answer POST failure: inline "That didn't send — try again", answer preserved in the input; Retry re-sends.
- Interview load failure (the audit's worst finding): dedicated card with apology, "Try again", and "Skip ahead to check" which routes to `/submit/:id/review`.
- The route is never a dead end (load-bearing rule 3).
- The final "anything else?" free-text is saved to the request via API (not history.state), so refresh and edit round-trips keep it.
- End copy: "Thanks — that's everything I need. Next, check the summary before it goes to a reviewer."
- Renders the real draft spec (see Backend): a short list of requirement lines, each with a provenance chip — "your request" (gray) or "your answer · Q⟨n⟩" (purple).
- Assumption lines render on an amber tint with "assumed — nobody said this" and two actions: "That's right" (confirms, becomes a normal line) and "Not quite — fix it" (inline text field replaces the line's content, recorded as a submitter correction).
- Header shows type + app with an "Edit description" link back to Describe that reuses the same request (no duplicate creation — see Backend idempotency).
- Attachments uploaded earlier are listed.
- "Anything to add?" optional input persists to the request as the user types (debounced PATCH), replacing history.state.
- Submit: "Send to a reviewer" with honesty note "A person reviews this before anything gets built."
- Failure shows "Something went wrong sending your request — nothing was lost. Please try again."
- Light warm near-white canvas, white cards, one purple accent `#BD03F7` used only for primary actions, active states, and "your answer" provenance.
- Amber reserved for assumptions/needs-input; green for done/confirmed; red for errors.
- Micron Basis for UI text (fallback Inter/system); JetBrains Mono only for request refs (REQ-142) and file sizes.
- Body text ≥16px everywhere, including hints and helper copy (audit found 12–13.5px guidance).
- Secondary text may be 14px minimum, never below.
- Interactive targets ≥44px tall.
- Generous spacing; one h1 per screen at a consistent size (28px) across the flow.
- Dark mode: the intake shell already has a theme toggle; every new surface and color must pass in both themes (verified by screenshots).
- Interview options: radiogroup semantics with visible + programmatic selected state.
- Progress: `role="progressbar"` with value text matching "Question N of about M".
- Understanding panel and chat updates: `aria-live="polite"`.
- All inputs labeled (visible label or aria-label) — no placeholder-only labels.
- Focus moves to the new question/step heading on transition.
- Full flow passes a keyboard-only run; visible focus states throughout.
- No silent failures: every subscribe error handler renders copy + a retry.
- Error copy pattern: what happened, whether data is safe (only when true), what to do next.
- The interview can always be exited forward ("Skip ahead to check").
- Draft autosave means refresh never loses form work; server persistence means refresh after Describe never duplicates requests.

### Task 1: Shared API Contract For Interview And Review

**Execution-order note:** Plan 2 (Describe step) Task 1 also touches `packages/shared/src/lib/models.ts` and `api.service.ts` and may already have added `SpecLine`, `InterviewState`, and `Api.submit`. Before starting, check the current file state: keep whatever already exists and add ONLY what is missing from the Produces list below. Do not redefine or duplicate existing types/methods; if a type already exists with the same shape, skip its step and just run the tests.

**Files:**
- Modify: `packages/shared/src/lib/models.ts:31-35`
- Modify: `packages/shared/src/lib/models.ts:109-131`
- Modify: `packages/shared/src/lib/api.service.ts:42-71`
- Test: `packages/shared/src/lib/api.service.spec.ts`

**Interfaces:**
- Consumes: backend `RequestDetail`, `SpecLineOut`, `InterviewState` shapes from the pinned API contract.
- Produces: `SpecLine`, `RequestDetail.extra_detail`, `InterviewState.skip_assumption`, `InterviewState.remaining_estimate`, `Api.review(id)`, `Api.answer(id, body)`, `Api.confirmSpecLine(rid, lineId, actor)`, `Api.correctSpecLine(rid, lineId, actor, text)`, `Api.submit(id, note, actor)`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/lib/api.service.spec.ts`:

```ts
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Api } from './api.service';

describe('Api intake review contract', () => {
  let api: Api;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(Api);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  it('loads review detail from the review endpoint', () => {
    api.review(42).subscribe((r) => expect(r.id).toBe(42));

    const req = http.expectOne('/api/requests/42/review');
    expect(req.request.method).toBe('GET');
    req.flush({ id: 42, turns: [], spec_lines: [], comments: [], audit: [], duplicate: null });
  });

  it('posts interview answers with explicit answer and skip fields', () => {
    api.answer(42, { answer: null, skip: true }).subscribe((s) => expect(s.done).toBe(false));

    const req = http.expectOne('/api/requests/42/interview');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ answer: null, skip: true });
    req.flush({
      done: false,
      asked: 1,
      total: 4,
      question: 'Who is affected?',
      sub: null,
      options: null,
      final: false,
      skip_assumption: 'it affects your team only',
      remaining_estimate: 2,
      turns: [],
    });
  });

  it('confirms and corrects spec lines with submitter actor data', () => {
    api.confirmSpecLine(42, 9, 'Jordan D.').subscribe();
    let req = http.expectOne('/api/requests/42/spec-lines/9/confirm');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ actor: 'Jordan D.' });
    req.flush({ id: 42, turns: [], spec_lines: [], comments: [], audit: [], duplicate: null });

    api.correctSpecLine(42, 9, 'Jordan D.', 'Keep CSV and XLSX exports.').subscribe();
    req = http.expectOne('/api/requests/42/spec-lines/9/correct');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ actor: 'Jordan D.', text: 'Keep CSV and XLSX exports.' });
    req.flush({ id: 42, turns: [], spec_lines: [], comments: [], audit: [], duplicate: null });
  });

  it('submits with note and actor', () => {
    api.submit(42, 'Please handle before month end.', 'Jordan D.').subscribe();

    const req = http.expectOne('/api/requests/42/submit');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      note: 'Please handle before month end.',
      actor: 'Jordan D.',
    });
    req.flush({ id: 42, turns: [], spec_lines: [], comments: [], audit: [], duplicate: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test shared`

Expected: FAIL with TypeScript errors like `Property 'review' does not exist on type 'Api'`, `Property 'confirmSpecLine' does not exist on type 'Api'`, and `Property 'correctSpecLine' does not exist on type 'Api'`.

- [ ] **Step 3: Write minimal implementation**

In `packages/shared/src/lib/models.ts`, replace the `SpecLine`, `RequestDetail`, and `InterviewState` interfaces with:

```ts
export interface SpecLine {
  id: number;
  order: number;
  text: string;
  prov: string | null;
  assume: boolean;
}

export interface RequestDetail extends FactoryRequest {
  extra_detail: string | null;
  turns: Turn[];
  spec_lines: SpecLine[];
  comments: CommentItem[];
  audit: AuditItem[];
  duplicate: { ref: string; title: string; id: number } | null;
  /** Live run state — present only while a build is in-flight (Plan 1). */
  run: RunState | null;
  /** Gate evidence — present only while parked at a gate (Plan 1). */
  evidence: Evidence | null;
  attachments?: Attachment[];
}

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

In `packages/shared/src/lib/api.service.ts`, replace methods `request` through `submit` with:

```ts
  request(id: number) {
    return this.http.get<RequestDetail>(`${BASE}/requests/${id}`);
  }
  review(id: number) {
    return this.http.get<RequestDetail>(`${BASE}/requests/${id}/review`);
  }
  createRequest(body: object) {
    return this.http.post<RequestDetail>(`${BASE}/requests`, body);
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
  interview(id: number) {
    return this.http.get<InterviewState>(`${BASE}/requests/${id}/interview`);
  }
  answer(id: number, body: { answer: string | null; skip: boolean }) {
    return this.http.post<InterviewState>(`${BASE}/requests/${id}/interview`, body);
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
  submit(id: number, note = '', actor = 'submitter') {
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/submit`, { note, actor });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test shared`

Expected: PASS with `Api intake review contract` tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/lib/models.ts packages/shared/src/lib/api.service.ts packages/shared/src/lib/api.service.spec.ts
git commit -m "feat: add intake review api contract"
```

### Task 2: Reusable Understanding Panel

**Files:**
- Create: `apps/intake/src/app/submitter/understanding-panel.ts`
- Test: `apps/intake/src/app/submitter/understanding-panel.spec.ts`

**Interfaces:**
- Consumes: `UnderstandingItem[]` and `remaining:number`.
- Produces: standalone `UnderstandingPanel` component with selector `sf-understanding-panel`, exported `UnderstandingItem` type.

- [ ] **Step 1: Write the failing test**

Create `apps/intake/src/app/submitter/understanding-panel.spec.ts`:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { UnderstandingPanel } from './understanding-panel';

describe('UnderstandingPanel', () => {
  function render(items: any[], remaining = 0): ComponentFixture<UnderstandingPanel> {
    const fixture = TestBed.createComponent(UnderstandingPanel);
    fixture.componentRef.setInput('items', items);
    fixture.componentRef.setInput('remaining', remaining);
    fixture.detectChanges();
    return fixture;
  }

  it('renders answered, assumed, and remaining rows with polite live updates', () => {
    const fixture = render(
      [
        {
          text: 'Monthly expense export produces an empty file',
          source: 'from your description',
          tone: 'got',
        },
        {
          text: 'Affects your team only',
          source: 'skipped — confirm on next step',
          tone: 'assume',
        },
      ],
      2,
    );

    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('.understanding')?.getAttribute('aria-live')).toBe('polite');
    expect(root.textContent).toContain('What we understood so far');
    expect(root.textContent).toContain('Monthly expense export produces an empty file');
    expect(root.textContent).toContain('from your description');
    expect(root.textContent).toContain('Affects your team only');
    expect(root.textContent).toContain('assumed');
    expect(root.textContent).toContain('About 2 more questions');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test intake`

Expected: FAIL with `Cannot find module './understanding-panel'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/intake/src/app/submitter/understanding-panel.ts`:

```ts
import { Component, input } from '@angular/core';

export interface UnderstandingItem {
  text: string;
  source: string;
  tone: 'got' | 'assume';
}

@Component({
  selector: 'sf-understanding-panel',
  standalone: true,
  template: `
    <aside class="understanding" aria-live="polite" aria-label="What we understood so far">
      <h2>What we understood so far</h2>
      <p class="hint">Grows as you answer — you'll confirm it next</p>

      @for (item of items(); track item.source + item.text) {
        <div class="u-row" [class.assume]="item.tone === 'assume'">
          <span class="dot" aria-hidden="true">{{ item.tone === 'assume' ? '!' : '✓' }}</span>
          <div>
            <div class="u-text">
              {{ item.text }}
              @if (item.tone === 'assume') {
                <span class="assumed">assumed</span>
              }
            </div>
            <div class="src">{{ item.source }}</div>
          </div>
        </div>
      }

      @if (remaining() > 0) {
        <div class="u-row wait">
          <span class="dot" aria-hidden="true">○</span>
          <div>About {{ remaining() }} more question{{ remaining() === 1 ? '' : 's' }}</div>
        </div>
      }
    </aside>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .understanding {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 18px;
      color: var(--fg1);
      box-shadow: var(--shadow-soft);
    }
    h2 {
      margin: 0;
      font-size: 18px;
      line-height: 1.25;
      letter-spacing: 0;
    }
    .hint {
      margin: 6px 0 14px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.45;
    }
    .u-row {
      min-height: 44px;
      display: grid;
      grid-template-columns: 24px 1fr;
      gap: 10px;
      align-items: flex-start;
      padding: 11px 0;
      border-top: 1px solid var(--hairline);
      font-size: 16px;
      line-height: 1.45;
    }
    .dot {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: inline-grid;
      place-items: center;
      background: color-mix(in srgb, var(--good) 14%, transparent);
      color: var(--good);
      font-size: 13px;
      font-weight: 800;
      margin-top: 1px;
    }
    .assume {
      background: color-mix(in srgb, var(--warn) 11%, transparent);
      margin: 0 -8px;
      padding: 11px 8px;
      border-radius: 8px;
    }
    .assume .dot {
      background: color-mix(in srgb, var(--warn) 22%, transparent);
      color: var(--warn);
    }
    .u-text {
      color: var(--fg1);
    }
    .assumed {
      display: inline-block;
      margin-left: 8px;
      color: var(--warn);
      font-size: 14px;
      font-weight: 700;
    }
    .src {
      margin-top: 3px;
      color: var(--muted);
      font-size: 14px;
    }
    .wait {
      color: var(--muted);
    }
    .wait .dot {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border);
    }
  `,
})
export class UnderstandingPanel {
  items = input<UnderstandingItem[]>([]);
  remaining = input(0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test intake`

Expected: PASS with `UnderstandingPanel` tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/understanding-panel.ts apps/intake/src/app/submitter/understanding-panel.spec.ts
git commit -m "feat: add submitter understanding panel"
```

### Task 3: Submitter Shell Step Labels And Forward Lock

**Execution-order note:** Plan 2 (Describe step) Task 7 owns this same change to `sub-shell.ts` and creates `sub-shell.spec.ts`. If plan 2 has already been executed, verify its tests cover the behaviors below and SKIP this task's implementation steps (run the test suite only). Only implement here if plan 2 has not run yet — and then skip plan 2 Task 7 later.

**Files:**
- Modify: `apps/intake/src/app/submitter/sub-shell.ts:47-75`
- Modify: `apps/intake/src/app/submitter/sub-shell.ts:111-115`
- Test: `apps/intake/src/app/submitter/sub-shell.spec.ts`

**Interfaces:**
- Consumes: `SubShell.step`, `SubShell.reqId`.
- Produces: four step labels `Describe`, `Questions`, `Check`, `Done`; completed steps remain clickable only backward; forward steps remain disabled.

- [ ] **Step 1: Write the failing test**

Create `apps/intake/src/app/submitter/sub-shell.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { Avatar, Glyph, Icon, Mark, Theme } from '@sf/shared';
import { Session } from '../core/session.service';
import { SubShell } from './sub-shell';

describe('SubShell stepper', () => {
  function render(step = 2) {
    const router = { navigateByUrl: vi.fn() };
    TestBed.configureTestingModule({
      imports: [SubShell, Mark, Avatar, Glyph, Icon],
      providers: [
        { provide: Router, useValue: router },
        {
          provide: Theme,
          useValue: { resolved: () => 'light', set: vi.fn() },
        },
        {
          provide: Session,
          useValue: {
            user: () => ({
              name: 'Jordan D.',
              initials: 'JD',
              color: '#BD03F7',
              email: 'j@example.com',
              role: 'submitter',
            }),
          },
        },
      ],
    });

    const fixture = TestBed.createComponent(SubShell);
    fixture.componentRef.setInput('active', 'new');
    fixture.componentRef.setInput('step', step);
    fixture.componentRef.setInput('reqId', 42);
    fixture.detectChanges();
    return { fixture, router };
  }

  it('uses plain four-step labels and disables forward steps', () => {
    const { fixture } = render(1);
    const buttons = [...fixture.nativeElement.querySelectorAll('.step')] as HTMLButtonElement[];

    expect(buttons.map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '✓ Describe',
      '2 Questions',
      '3 Check',
      '4 Done',
    ]);
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[2].disabled).toBe(true);
    expect(buttons[3].disabled).toBe(true);
  });

  it('routes backward steps with the same request id', () => {
    const { fixture, router } = render(2);
    const buttons = [...fixture.nativeElement.querySelectorAll('.step')] as HTMLButtonElement[];

    buttons[1].click();

    expect(router.navigateByUrl).toHaveBeenCalledWith('/submit/42/interview');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test intake`

Expected: FAIL because the shell renders `Clarify` and `Review`, and there is no `Done` step.

- [ ] **Step 3: Write minimal implementation**

In `apps/intake/src/app/submitter/sub-shell.ts`, replace the `steps` array with:

```ts
  steps = [
    { label: 'Describe', path: () => '/submit/new' },
    { label: 'Questions', path: (id: number | null) => `/submit/${id}/interview` },
    { label: 'Check', path: (id: number | null) => `/submit/${id}/review` },
    { label: 'Done', path: (id: number | null) => `/submit/${id}/done` },
  ];
```

Keep the existing template disabling expression:

```html
[disabled]="i >= step()! || !backable()"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test intake`

Expected: PASS with `SubShell stepper` tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/sub-shell.ts apps/intake/src/app/submitter/sub-shell.spec.ts
git commit -m "feat: rename intake steps"
```

### Task 4: Interview Load, Honest Progress, Understanding Panel, And Failure Card

**Files:**
- Modify: `apps/intake/src/app/submitter/interview.ts:1-260`
- Test: `apps/intake/src/app/submitter/interview.spec.ts`

**Interfaces:**
- Consumes: `Api.request(id)`, `Api.interview(id)`, `InterviewState.remaining_estimate`, `RequestDetail.description`, `Turn[]`.
- Produces: `progressText()`, `progressPercent()`, `understandingItems()`, `retryLoad()`, `skipAhead()`, visible load failure card, focused question heading.

- [ ] **Step 1: Write the failing test**

Create `apps/intake/src/app/submitter/interview.spec.ts` with this initial test set:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Api, RequestDetail } from '@sf/shared';
import { IntakeDraft } from './intake-draft.service';
import { Interview } from './interview';

function req(overrides: Partial<RequestDetail> = {}): RequestDetail {
  return {
    id: 42,
    ref: 'REQ-42',
    title: 'Expense export broken',
    description: 'Monthly expense export produces an empty file',
    type: 'bug',
    urgency: 'normal',
    reach: null,
    impact_metric: null,
    impact_value: null,
    priority: 'normal',
    app_id: 7,
    app_name: 'Expense Tracker',
    app_key: null,
    repo: null,
    prospective_repo: null,
    new_app_name: null,
    stage: 'intake',
    status: 'draft',
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
    created_at: '',
    updated_at: '',
    stage_entered_at: null,
    last_event: null,
    extra_detail: null,
    turns: [
      {
        order: 1,
        question: 'How often does it happen?',
        sub: null,
        options: null,
        answer: 'Every time',
        skipped: false,
      },
    ],
    spec_lines: [],
    comments: [],
    audit: [],
    duplicate: null,
    run: null,
    evidence: null,
    attachments: [],
    ...overrides,
  };
}

describe('Interview screen load state', () => {
  let api: any;
  let router: any;
  let fixture: ComponentFixture<Interview>;

  beforeEach(() => {
    api = {
      request: vi.fn(() => of(req())),
      interview: vi.fn(() =>
        of({
          done: false,
          asked: 1,
          total: 4,
          question: 'Roughly how many people rely on this export every month?',
          sub: 'Pick the closest one — a rough idea is fine.',
          options: [
            { t: 'Just me', d: "I'm the only one who runs it" },
            { t: 'My team', d: 'Around 5–15 people' },
          ],
          final: false,
          skip_assumption: 'it affects your team only',
          remaining_estimate: 2,
          turns: req().turns,
        }),
      ),
      answer: vi.fn(),
      updateRequest: vi.fn(),
    };
    router = { navigateByUrl: vi.fn(), navigate: vi.fn() };

    TestBed.configureTestingModule({
      imports: [Interview],
      providers: [
        { provide: Api, useValue: api },
        { provide: Router, useValue: router },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: () => '42' } } },
        },
        { provide: IntakeDraft, useValue: { loadAttachments: vi.fn() } },
      ],
    });
  });

  it('shows honest progress and the understanding panel', () => {
    fixture = TestBed.createComponent(Interview);
    fixture.detectChanges();

    const root: HTMLElement = fixture.nativeElement;
    expect(root.textContent).toContain('Question 2 of about 4');
    expect(root.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext')).toBe(
      'Question 2 of about 4',
    );
    expect(root.textContent).toContain('What we understood so far');
    expect(root.textContent).toContain('Monthly expense export produces an empty file');
    expect(root.textContent).toContain('from your answer · question 1');
  });

  it('renders a recovery card when interview loading fails', () => {
    api.interview.mockReturnValue(throwError(() => new Error('offline')));

    fixture = TestBed.createComponent(Interview);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;

    expect(root.textContent).toContain("We couldn't load the follow-up questions");
    expect(root.textContent).toContain('Try again');
    expect(root.textContent).toContain('Skip ahead to check');
    root.querySelectorAll('button')[1].dispatchEvent(new MouseEvent('click'));
    expect(router.navigateByUrl).toHaveBeenCalledWith('/submit/42/review');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test intake`

Expected: FAIL because current `Interview` does not import `UnderstandingPanel`, uses hardcoded progress labels, and swallows load failures.

- [ ] **Step 3: Write minimal implementation**

In `apps/intake/src/app/submitter/interview.ts`, update imports:

```ts
import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { Api, Icon, InterviewState, Mark, RequestDetail, TypeChip } from '@sf/shared';
import { AttachField } from './attach-field';
import { IntakeDraft } from './intake-draft.service';
import { SubShell } from './sub-shell';
import { UnderstandingItem, UnderstandingPanel } from './understanding-panel';
```

Update the component imports array:

```ts
imports: [SubShell, Mark, Icon, TypeChip, FormsModule, AttachField, UnderstandingPanel],
```

Add these signals and computed values inside `export class Interview`:

```ts
  heading = viewChild<ElementRef<HTMLElement>>('questionHeading');
  loadError = signal(false);
  skippedAssumptions = signal<Record<number, string>>({});

  currentQuestionNumber = computed(() => {
    const s = this.st();
    if (!s) return 0;
    return s.done ? Math.max(s.asked, 1) : s.asked + 1;
  });
  estimatedTotal = computed(() => {
    const s = this.st();
    if (!s) return 1;
    if (s.done) return Math.max(s.total, s.asked, 1);
    return Math.max(s.total, s.asked + 1 + s.remaining_estimate, 1);
  });
  progress = computed(() => {
    const s = this.st();
    if (!s) return 0;
    if (s.done) return 100;
    return Math.round((this.currentQuestionNumber() / this.estimatedTotal()) * 100);
  });
  progressLabel = computed(() => {
    const s = this.st();
    if (!s) return 'Loading questions';
    if (s.done) return 'All done';
    return `Question ${this.currentQuestionNumber()} of about ${this.estimatedTotal()}`;
  });
  understandingItems = computed<UnderstandingItem[]>(() => {
    const items: UnderstandingItem[] = [];
    const r = this.req();
    if (r?.description) {
      items.push({ text: r.description, source: 'from your description', tone: 'got' });
    }
    const assumptions = this.skippedAssumptions();
    for (const t of this.st()?.turns ?? r?.turns ?? []) {
      if (t.skipped) {
        items.push({
          text: assumptions[t.order] ?? `Skipped: ${t.question}`,
          source: 'skipped — confirm on next step',
          tone: 'assume',
        });
      } else if (t.answer) {
        items.push({
          text: t.answer,
          source: `from your answer · question ${t.order}`,
          tone: 'got',
        });
      }
    }
    return items;
  });
  remainingQuestions = computed(() => {
    const s = this.st();
    return s && !s.done ? s.remaining_estimate : 0;
  });
```

Replace the existing constructor interview load block with:

```ts
  constructor() {
    this.draft.loadAttachments(this.id);
    this.api.request(this.id).subscribe((r) => this.req.set(r));
    this.retryLoad();
  }

  retryLoad() {
    this.busy.set(true);
    this.loadError.set(false);
    this.api.interview(this.id).subscribe({
      next: (s) => this.acceptState(s),
      error: () => {
        this.busy.set(false);
        this.loadError.set(true);
      },
    });
  }

  private acceptState(s: InterviewState) {
    this.st.set(s);
    this.busy.set(false);
    this.loadError.set(false);
    queueMicrotask(() => this.heading()?.nativeElement.focus());
  }

  skipAhead() {
    this.router.navigateByUrl(`/submit/${this.id}/review`);
  }
```

Replace the outer template body inside `<sub-shell>` with this grid shell and failure card. Keep the existing thread rendering below this block until Task 5 replaces the input surface:

```html
<div class="interview-grid fade-in">
  <section class="question-col">
    <div class="question-head">
      <div class="row" style="gap:9px;margin-bottom:12px">
        @if (req(); as r) {
          <sf-type-chip [t]="r.type" /><span class="request-title">{{ r.title }}</span>
        }
      </div>
      <h1 #questionHeading tabindex="-1">{{ st()?.done ? 'Questions complete' : 'Questions' }}</h1>
      <div
        class="qprog"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        [attr.aria-valuenow]="progress()"
        [attr.aria-valuetext]="progressLabel()"
      >
        <span class="qprog__lbl">{{ progressLabel() }}</span>
        <span class="qprog__track"><span class="qprog__fill" [style.width.%]="progress()"></span></span>
      </div>
    </div>

    @if (loadError()) {
      <div class="load-card" role="alert">
        <h2>We couldn't load the follow-up questions</h2>
        <p>Your request is safe. You can try again, or go straight to checking your request — the questions just make it sharper.</p>
        <div class="load-actions">
          <button class="btn ghost" type="button" (click)="retryLoad()">Try again</button>
          <button class="btn primary" type="button" (click)="skipAhead()">Skip ahead to check</button>
        </div>
      </div>
    } @else {
      <!-- existing thread and input panel stay here until Task 5 replaces them -->
    }
  </section>

  <sf-understanding-panel [items]="understandingItems()" [remaining]="remainingQuestions()" />
</div>
```

Add these styles to the component:

```ts
styles: `
  .interview-grid {
    max-width: 1120px;
    margin: 0 auto;
    padding: 26px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    gap: 24px;
  }
  .question-col {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .question-head {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 18px;
  }
  .request-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--fg1);
  }
  h1 {
    margin: 0 0 14px;
    font-size: 28px;
    line-height: 1.2;
    letter-spacing: 0;
    outline: none;
  }
  .qprog {
    display: grid;
    gap: 8px;
  }
  .qprog__lbl {
    font-size: 16px;
    color: var(--fg1);
  }
  .qprog__track {
    height: 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--border) 70%, transparent);
    overflow: hidden;
  }
  .qprog__fill {
    display: block;
    height: 100%;
    background: #BD03F7;
  }
  .load-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 22px;
    color: var(--fg1);
  }
  .load-card h2 {
    margin: 0 0 8px;
    font-size: 22px;
    letter-spacing: 0;
  }
  .load-card p {
    margin: 0;
    color: var(--muted);
    font-size: 16px;
    line-height: 1.55;
  }
  .load-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 18px;
  }
  .load-actions .btn {
    min-height: 44px;
  }
  @media (max-width: 860px) {
    .interview-grid {
      grid-template-columns: 1fr;
      padding: 18px;
    }
  }
`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test intake`

Expected: PASS for the two `Interview screen load state` tests.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/interview.ts apps/intake/src/app/submitter/interview.spec.ts
git commit -m "feat: add interview progress and recovery"
```

### Task 5: Interview Single Input Surface, Retry, Skip Consequence, And Final Extra Detail PATCH

**Files:**
- Modify: `apps/intake/src/app/submitter/interview.ts:95-260`
- Modify: `apps/intake/src/app/submitter/interview.spec.ts`

**Interfaces:**
- Consumes: `Api.answer(id, { answer:string|null, skip:boolean })`, `Api.updateRequest(id, { extra_detail:string })`.
- Produces: radio option surface, custom-answer swap mode, inline send error, retry action, per-question skip consequence copy, final extra detail server save.

- [ ] **Step 1: Add failing tests**

Append these tests inside `describe('Interview screen load state', ...)` in `apps/intake/src/app/submitter/interview.spec.ts`:

```ts
  it('keeps option answers separate from custom text answers', () => {
    api.answer.mockReturnValue(
      of({
        done: true,
        asked: 2,
        total: 2,
        question: null,
        sub: null,
        options: null,
        final: false,
        skip_assumption: null,
        remaining_estimate: 0,
        turns: [],
      }),
    );
    fixture = TestBed.createComponent(Interview);
    fixture.detectChanges();

    const root: HTMLElement = fixture.nativeElement;
    const firstOption = root.querySelector('[role="radio"]') as HTMLButtonElement;
    firstOption.click();
    fixture.detectChanges();
    expect(firstOption.getAttribute('aria-checked')).toBe('true');

    (root.querySelector('.continue-answer') as HTMLButtonElement).click();
    expect(api.answer).toHaveBeenCalledWith(42, { answer: 'Just me', skip: false });
  });

  it('uses a composer only after the custom answer swap link is clicked', () => {
    api.answer.mockReturnValue(
      of({
        done: true,
        asked: 2,
        total: 2,
        question: null,
        sub: null,
        options: null,
        final: false,
        skip_assumption: null,
        remaining_estimate: 0,
        turns: [],
      }),
    );
    fixture = TestBed.createComponent(Interview);
    fixture.detectChanges();

    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('input[name="answer"]')).toBeNull();

    (root.querySelector('.swap-answer') as HTMLButtonElement).click();
    fixture.detectChanges();
    const input = root.querySelector('input[name="answer"]') as HTMLInputElement;
    input.value = 'Finance team and payroll';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    (root.querySelector('.continue-answer') as HTMLButtonElement).click();
    expect(api.answer).toHaveBeenCalledWith(42, {
      answer: 'Finance team and payroll',
      skip: false,
    });
  });

  it('shows answer failure copy, preserves the answer, and retries the same body', () => {
    api.answer.mockReturnValueOnce(throwError(() => new Error('network')));
    fixture = TestBed.createComponent(Interview);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;

    (root.querySelector('[role="radio"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    (root.querySelector('.continue-answer') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(root.textContent).toContain("That didn't send — try again");
    expect((root.querySelector('[role="radio"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe(
      'true',
    );

    api.answer.mockReturnValueOnce(
      of({
        done: true,
        asked: 2,
        total: 2,
        question: null,
        sub: null,
        options: null,
        final: false,
        skip_assumption: null,
        remaining_estimate: 0,
        turns: [],
      }),
    );
    (root.querySelector('.retry-answer') as HTMLButtonElement).click();
    expect(api.answer).toHaveBeenLastCalledWith(42, { answer: 'Just me', skip: false });
  });

  it('patches final extra detail before routing to review', () => {
    api.interview.mockReturnValue(
      of({
        done: true,
        asked: 3,
        total: 3,
        question: null,
        sub: null,
        options: null,
        final: false,
        skip_assumption: null,
        remaining_estimate: 0,
        turns: [],
      }),
    );
    api.updateRequest.mockReturnValue(of(req({ extra_detail: 'Please handle before Friday.' })));
    fixture = TestBed.createComponent(Interview);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    const input = root.querySelector('input[name="extra_detail"]') as HTMLInputElement;
    input.value = 'Please handle before Friday.';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    (root.querySelector('.to-review') as HTMLButtonElement).click();

    expect(api.updateRequest).toHaveBeenCalledWith(42, {
      extra_detail: 'Please handle before Friday.',
    });
    expect(router.navigateByUrl).toHaveBeenCalledWith('/submit/42/review');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test intake`

Expected: FAIL because current interview shows options and composer at the same time, sends `this.msg().trim() || this.picked()`, has no retry button, and navigates with `history.state`.

- [ ] **Step 3: Write minimal implementation**

In `apps/intake/src/app/submitter/interview.ts`, add signals:

```ts
  customAnswer = signal(false);
  answerError = signal('');
  extraError = signal('');
  lastAnswerBody = signal<{ answer: string | null; skip: boolean } | null>(null);
```

Replace the current `push`, `sendPicked`, `skip`, `enter`, and `toReview` methods with:

```ts
  private push(body: { answer: string | null; skip: boolean }) {
    if (this.busy()) return;
    this.busy.set(true);
    this.answerError.set('');
    this.lastAnswerBody.set(body);
    this.api.answer(this.id, body).subscribe({
      next: (s) => {
        this.acceptState(s);
        this.picked.set(null);
        this.msg.set('');
        this.customAnswer.set(false);
        this.lastAnswerBody.set(null);
      },
      error: () => {
        this.busy.set(false);
        this.answerError.set("That didn't send — try again");
      },
    });
  }

  chooseOption(answer: string) {
    this.picked.set(answer);
    this.msg.set('');
  }

  useCustomAnswer() {
    this.customAnswer.set(true);
    this.picked.set(null);
    this.msg.set('');
  }

  sendAnswer() {
    const s = this.st();
    if (!s || s.done) return;
    const answer = this.customAnswer() || !s.options ? this.msg().trim() : this.picked();
    if (answer) this.push({ answer, skip: false });
  }

  retryAnswer() {
    const body = this.lastAnswerBody();
    if (body) this.push(body);
  }

  skip() {
    const s = this.st();
    if (s?.skip_assumption) {
      const order = s.asked + 1;
      this.skippedAssumptions.update((m) => ({ ...m, [order]: s.skip_assumption! }));
    }
    this.push({ answer: null, skip: true });
  }

  toReview() {
    const extra = this.msg().trim();
    this.extraError.set('');
    if (!extra) {
      this.router.navigateByUrl(`/submit/${this.id}/review`);
      return;
    }
    this.busy.set(true);
    this.api.updateRequest(this.id, { extra_detail: extra }).subscribe({
      next: () => {
        this.busy.set(false);
        this.router.navigateByUrl(`/submit/${this.id}/review`);
      },
      error: () => {
        this.busy.set(false);
        this.extraError.set("That didn't save — try again");
      },
    });
  }
```

Inside the non-error branch of the template from Task 4, render this input surface:

```html
<div class="question-card">
  <div class="sr-only" role="status" aria-live="polite">{{ liveQuestion() }}</div>

  @if (st(); as s) {
    @if (!s.done && s.question) {
      <h2 class="question-text">{{ s.question }}</h2>
      @if (s.sub) {
        <p class="question-sub">{{ s.sub }}</p>
      }

      @if (s.options && !customAnswer()) {
        <div class="options" role="radiogroup" [attr.aria-label]="s.question">
          @for (o of s.options; track o.t) {
            <button
              type="button"
              role="radio"
              class="option"
              [class.selected]="picked() === o.t"
              [attr.aria-checked]="picked() === o.t"
              (click)="chooseOption(o.t)"
            >
              <span class="radio-dot" aria-hidden="true"></span>
              <span>
                <span class="option-title">{{ o.t }}</span>
                @if (o.d) {
                  <span class="option-desc">{{ o.d }}</span>
                }
              </span>
            </button>
          }
        </div>
        <button class="swap-answer" type="button" (click)="useCustomAnswer()">
          Type my own answer instead
        </button>
      } @else {
        <label class="answer-label" for="answer">Your answer</label>
        <input
          id="answer"
          name="answer"
          class="answer-input"
          [ngModel]="msg()"
          (ngModelChange)="msg.set($event)"
          (keydown.enter)="sendAnswer()"
        />
      }

      @if (s.skip_assumption) {
        <button class="skip-note" type="button" (click)="skip()">
          Skip this question — we'll assume {{ s.skip_assumption }}, and you can correct that on the next step.
        </button>
      }

      @if (answerError()) {
        <div class="inline-error" role="alert">
          {{ answerError() }}
          <button class="retry-answer" type="button" (click)="retryAnswer()">Retry</button>
        </div>
      }

      <div class="answer-actions">
        <button
          class="btn primary continue-answer"
          type="button"
          [disabled]="busy() || (!(customAnswer() || !s.options) && !picked()) || ((customAnswer() || !s.options) && !msg().trim())"
          (click)="sendAnswer()"
        >
          Continue
        </button>
      </div>
    }

    @if (s.done) {
      <div class="done-card">
        <h2>Thanks — that's everything I need.</h2>
        <p>Next, check the summary before it goes to a reviewer.</p>
        <label class="answer-label" for="extra-detail">Anything else?</label>
        <input
          id="extra-detail"
          name="extra_detail"
          class="answer-input"
          [ngModel]="msg()"
          (ngModelChange)="msg.set($event)"
        />
        @if (extraError()) {
          <div class="inline-error" role="alert">{{ extraError() }}</div>
        }
        <button class="btn primary to-review" type="button" [disabled]="busy()" (click)="toReview()">
          Check the summary
        </button>
      </div>
    }
  }
</div>
```

Add these styles to the existing `styles` string:

```css
.question-card,
.done-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 22px;
}
.question-text,
.done-card h2 {
  margin: 0;
  font-size: 22px;
  line-height: 1.3;
  letter-spacing: 0;
}
.question-sub,
.done-card p {
  margin: 8px 0 18px;
  color: var(--muted);
  font-size: 16px;
  line-height: 1.5;
}
.options {
  display: grid;
  gap: 10px;
}
.option {
  min-height: 56px;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: var(--fg1);
  display: grid;
  grid-template-columns: 22px 1fr;
  gap: 12px;
  align-items: flex-start;
  padding: 13px 14px;
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.option.selected {
  border-color: #BD03F7;
  box-shadow: 0 0 0 3px color-mix(in srgb, #BD03F7 18%, transparent);
}
.radio-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--border);
  margin-top: 2px;
}
.selected .radio-dot {
  border-color: #BD03F7;
  background: radial-gradient(circle, #BD03F7 0 42%, transparent 44%);
}
.option-title,
.option-desc {
  display: block;
}
.option-title {
  font-size: 16px;
  font-weight: 700;
}
.option-desc {
  margin-top: 3px;
  font-size: 14px;
  color: var(--muted);
}
.swap-answer,
.skip-note {
  min-height: 44px;
  border: 0;
  background: transparent;
  color: var(--accent-link);
  font: inherit;
  font-size: 16px;
  padding: 10px 0;
  cursor: pointer;
  text-align: left;
}
.skip-note {
  color: var(--muted);
}
.answer-label {
  display: block;
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 8px;
}
.answer-input {
  width: 100%;
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: var(--fg1);
  font: inherit;
  font-size: 16px;
  padding: 10px 12px;
}
.inline-error {
  margin-top: 12px;
  color: var(--danger);
  font-size: 16px;
  line-height: 1.45;
}
.inline-error button {
  min-height: 44px;
  margin-left: 8px;
}
.answer-actions {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
.continue-answer,
.to-review {
  min-height: 44px;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test intake`

Expected: PASS with all `Interview screen load state` tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/interview.ts apps/intake/src/app/submitter/interview.spec.ts
git commit -m "feat: make interview answers recoverable"
```

### Task 6: Check Screen Real Draft Spec, Provenance, Attachments, And Focus

**Files:**
- Modify: `apps/intake/src/app/submitter/review.ts:1-209`
- Test: `apps/intake/src/app/submitter/review.spec.ts`

**Interfaces:**
- Consumes: `Api.review(id)`, `RequestDetail.spec_lines`, `RequestDetail.attachments`, `RequestDetail.type`, `RequestDetail.app_name`, `RequestDetail.new_app_name`.
- Produces: focused `h1`, spec lines with provenance chips, attachment list, understanding panel usage, honest submit label and note.

- [ ] **Step 1: Write the failing test**

Create `apps/intake/src/app/submitter/review.spec.ts`:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Api, RequestDetail } from '@sf/shared';
import { Session } from '../core/session.service';
import { IntakeDraft } from './intake-draft.service';
import { Review } from './review';

function detail(overrides: Partial<RequestDetail> = {}): RequestDetail {
  return {
    id: 42,
    ref: 'REQ-42',
    title: 'Expense export broken',
    description: 'Monthly expense export produces an empty file',
    type: 'bug',
    urgency: 'normal',
    reach: null,
    impact_metric: null,
    impact_value: null,
    priority: 'normal',
    app_id: 7,
    app_name: 'Expense Tracker',
    app_key: null,
    repo: null,
    prospective_repo: null,
    new_app_name: null,
    stage: 'intake',
    status: 'draft',
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
    created_at: '',
    updated_at: '',
    stage_entered_at: null,
    last_event: null,
    extra_detail: 'Please handle before Friday.',
    turns: [],
    spec_lines: [
      { id: 1, order: 1, text: 'Expense export produces an empty file.', prov: 'description', assume: false },
      { id: 2, order: 2, text: 'The failure happens every time.', prov: 'Q1', assume: false },
      { id: 3, order: 3, text: 'The CSV format should stay the same.', prov: null, assume: true },
    ],
    comments: [],
    audit: [],
    duplicate: null,
    run: null,
    evidence: null,
    attachments: [
      {
        id: 8,
        filename: 'export-error.png',
        mime: 'image/png',
        kind: 'image',
        size: 245760,
        source: 'describe',
        created_at: '',
      },
    ],
    ...overrides,
  };
}

describe('Review screen draft spec', () => {
  let api: any;
  let router: any;
  let fixture: ComponentFixture<Review>;

  beforeEach(() => {
    api = {
      review: vi.fn(() => of(detail())),
      updateRequest: vi.fn(() => of(detail())),
      confirmSpecLine: vi.fn(),
      correctSpecLine: vi.fn(),
      submit: vi.fn(() => of(detail())),
    };
    router = { navigateByUrl: vi.fn() };

    TestBed.configureTestingModule({
      imports: [Review],
      providers: [
        { provide: Api, useValue: api },
        { provide: Router, useValue: router },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => '42' } } } },
        {
          provide: Session,
          useValue: {
            user: () => ({
              name: 'Jordan D.',
              initials: 'JD',
              color: '#BD03F7',
              email: 'j@example.com',
              role: 'submitter',
            }),
          },
        },
        { provide: IntakeDraft, useValue: { reset: vi.fn(), loadAttachments: vi.fn() } },
      ],
    });
  });

  it('loads review detail and renders real spec lines with provenance', () => {
    fixture = TestBed.createComponent(Review);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;

    expect(api.review).toHaveBeenCalledWith(42);
    expect(root.textContent).toContain('Did we get this right?');
    expect(root.textContent).toContain('Bug fix · Expense Tracker');
    expect(root.textContent).toContain('Expense export produces an empty file.');
    expect(root.textContent).toContain('your request');
    expect(root.textContent).toContain('The failure happens every time.');
    expect(root.textContent).toContain('your answer · Q1');
    expect(root.textContent).toContain('The CSV format should stay the same.');
    expect(root.textContent).toContain('assumed — nobody said this');
    expect(root.textContent).toContain('export-error.png');
    expect(root.textContent).toContain('240 KB');
    expect(root.textContent).toContain('A person reviews this before anything gets built.');
    expect(root.textContent).toContain('What we understood so far');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test intake`

Expected: FAIL because current Review calls `api.request`, renders raw summary rows, does not render `spec_lines`, does not list attachments, and does not use the understanding panel.

- [ ] **Step 3: Write minimal implementation**

In `apps/intake/src/app/submitter/review.ts`, update imports:

```ts
import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { Api, Icon, RequestDetail, SpecLine, TypeChip } from '@sf/shared';
import { Session } from '../core/session.service';
import { IntakeDraft } from './intake-draft.service';
import { SubShell } from './sub-shell';
import { UnderstandingItem, UnderstandingPanel } from './understanding-panel';
```

Update the component imports array:

```ts
imports: [SubShell, Icon, TypeChip, FormsModule, UnderstandingPanel],
```

Replace the class body up to `submit()` with:

```ts
  private api = inject(Api);
  private router = inject(Router);
  private draft = inject(IntakeDraft);
  session = inject(Session);
  id = Number(inject(ActivatedRoute).snapshot.paramMap.get('id'));
  heading = viewChild<ElementRef<HTMLElement>>('checkHeading');

  req = signal<RequestDetail | null>(null);
  submitting = signal(false);
  submitError = signal('');
  extra = signal('');

  understandingItems = computed<UnderstandingItem[]>(() => {
    return (this.req()?.spec_lines ?? []).map((line) => ({
      text: line.text,
      source: this.provenance(line),
      tone: line.assume ? 'assume' : 'got',
    }));
  });

  constructor() {
    this.draft.loadAttachments(this.id);
    this.api.review(this.id).subscribe((r) => {
      this.req.set(r);
      this.extra.set(r.extra_detail ?? '');
      queueMicrotask(() => this.heading()?.nativeElement.focus());
    });
  }

  appLabel(r: RequestDetail) {
    return r.type === 'new' ? r.new_app_name || r.app_name : r.app_name;
  }

  typeLabel(t: RequestDetail['type']) {
    return { bug: 'Bug fix', enh: 'Enhancement', new: 'New app', other: 'Other request' }[t];
  }

  provenance(line: SpecLine) {
    if (line.assume) return 'assumed — nobody said this';
    if (!line.prov || line.prov === 'description') return 'your request';
    if (/^Q\\d+$/i.test(line.prov)) return `your answer · ${line.prov.toUpperCase()}`;
    if (line.prov === 'submitter-confirmed') return 'confirmed by you';
    if (line.prov === 'submitter-corrected') return 'corrected by you';
    return 'your request';
  }

  chipClass(line: SpecLine) {
    if (line.assume) return 'assume';
    return /^Q\\d+$/i.test(line.prov ?? '') ? 'ans' : 'req';
  }

  fileSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    const kb = Math.round(bytes / 1024);
    if (kb < 1024) return `${kb} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
  }

  editDescription() {
    this.router.navigateByUrl(`/submit/new?requestId=${this.id}`);
  }
```

Replace the template with:

```html
<sub-shell active="new" [step]="2" [reqId]="id">
  <div class="review-grid fade-in">
    <section class="check-col">
      <h1 #checkHeading tabindex="-1">Did we get this right?</h1>
      <p class="lede">Here's what we heard. Fix anything that looks off before it goes to a reviewer.</p>

      @if (req(); as r) {
        <section class="spec-card" aria-label="Draft spec">
          <div class="spec-head">
            <div>
              <sf-type-chip [t]="r.type" />
              <strong>{{ typeLabel(r.type) }} · {{ appLabel(r) }}</strong>
            </div>
            <button class="edit-description" type="button" (click)="editDescription()">
              <sf-icon name="edit" [size]="16" /> Edit description
            </button>
          </div>

          @for (line of r.spec_lines; track line.id) {
            <div class="spec-line" [class.assumption]="line.assume">
              <span class="line-icon" aria-hidden="true">{{ line.assume ? '!' : '✓' }}</span>
              <div class="line-main">
                <span>{{ line.text }}</span>
                <span class="prov" [class]="chipClass(line)">{{ provenance(line) }}</span>
              </div>
            </div>
          }
        </section>

        <section class="attachments" aria-label="Attachments">
          <h2>Attached</h2>
          @if ((r.attachments ?? []).length) {
            @for (a of r.attachments ?? []; track a.id) {
              <div class="attachment-row">
                <span>{{ a.filename }}</span>
                <span class="file-size">{{ fileSize(a.size) }}</span>
              </div>
            }
          } @else {
            <p>No attachments added.</p>
          }
        </section>
      }
    </section>

    <sf-understanding-panel [items]="understandingItems()" [remaining]="0" />
  </div>
</sub-shell>
```

Add this styles string:

```ts
styles: `
  .review-grid {
    max-width: 1120px;
    margin: 0 auto;
    padding: 26px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    gap: 24px;
  }
  .check-col {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  h1 {
    margin: 0;
    font-size: 28px;
    line-height: 1.2;
    letter-spacing: 0;
    outline: none;
  }
  .lede {
    margin: -8px 0 2px;
    color: var(--muted);
    font-size: 16px;
    line-height: 1.55;
  }
  .spec-card,
  .attachments {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 18px;
  }
  .spec-head {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    align-items: center;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--hairline);
  }
  .spec-head > div {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    font-size: 16px;
  }
  .edit-description {
    min-height: 44px;
    border: 0;
    background: transparent;
    color: var(--accent-link);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    font-size: 16px;
    cursor: pointer;
  }
  .spec-line {
    display: grid;
    grid-template-columns: 24px 1fr;
    gap: 10px;
    align-items: flex-start;
    padding: 14px 0;
    border-bottom: 1px solid var(--hairline);
    font-size: 16px;
    line-height: 1.5;
  }
  .spec-line:last-child {
    border-bottom: 0;
  }
  .spec-line.assumption {
    background: color-mix(in srgb, var(--warn) 11%, transparent);
    margin: 0 -8px;
    padding: 14px 8px;
    border-radius: 8px;
  }
  .line-icon {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: inline-grid;
    place-items: center;
    background: color-mix(in srgb, var(--good) 14%, transparent);
    color: var(--good);
    font-size: 13px;
    font-weight: 800;
    margin-top: 1px;
  }
  .assumption .line-icon {
    background: color-mix(in srgb, var(--warn) 22%, transparent);
    color: var(--warn);
  }
  .line-main {
    min-width: 0;
  }
  .prov {
    display: inline-block;
    margin-left: 8px;
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 14px;
    font-weight: 700;
    background: color-mix(in srgb, var(--muted) 14%, transparent);
    color: var(--muted);
  }
  .prov.ans {
    background: color-mix(in srgb, #BD03F7 14%, transparent);
    color: #BD03F7;
  }
  .prov.assume {
    background: color-mix(in srgb, var(--warn) 18%, transparent);
    color: var(--warn);
  }
  .attachments h2 {
    margin: 0 0 10px;
    font-size: 18px;
    letter-spacing: 0;
  }
  .attachments p,
  .attachment-row {
    font-size: 16px;
    color: var(--fg1);
  }
  .attachment-row {
    min-height: 44px;
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    border-top: 1px solid var(--hairline);
  }
  .file-size {
    font-family: var(--mono);
    color: var(--muted);
  }
  @media (max-width: 860px) {
    .review-grid {
      grid-template-columns: 1fr;
      padding: 18px;
    }
    .spec-head {
      align-items: flex-start;
      flex-direction: column;
    }
  }
`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test intake`

Expected: PASS with `Review screen draft spec` tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/review.ts apps/intake/src/app/submitter/review.spec.ts
git commit -m "feat: render draft spec on check screen"
```

### Task 7: Check Screen Assumption Confirm And Correction Actions

**Files:**
- Modify: `apps/intake/src/app/submitter/review.ts:1-260`
- Modify: `apps/intake/src/app/submitter/review.spec.ts`

**Interfaces:**
- Consumes: `Api.confirmSpecLine(id, lineId, actor)`, `Api.correctSpecLine(id, lineId, actor, text)`, `Session.user().name`.
- Produces: `confirmLine(line)`, `startCorrection(line)`, `saveCorrection(line)`, per-line inline error state, inline correction text field.

- [ ] **Step 1: Add failing tests**

Append these tests inside `describe('Review screen draft spec', ...)`:

```ts
  it('confirms an assumption line and refreshes the request detail', () => {
    api.confirmSpecLine.mockReturnValue(
      of(
        detail({
          spec_lines: [
            {
              id: 3,
              order: 3,
              text: 'The CSV format should stay the same.',
              prov: 'submitter-confirmed',
              assume: false,
            },
          ],
        }),
      ),
    );
    fixture = TestBed.createComponent(Review);
    fixture.detectChanges();

    const root: HTMLElement = fixture.nativeElement;
    (root.querySelector('.confirm-line') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(api.confirmSpecLine).toHaveBeenCalledWith(42, 3, 'Jordan D.');
    expect(root.textContent).toContain('confirmed by you');
  });

  it('corrects an assumption line with inline text', () => {
    api.correctSpecLine.mockReturnValue(
      of(
        detail({
          spec_lines: [
            {
              id: 3,
              order: 3,
              text: 'Keep CSV and XLSX export formats.',
              prov: 'submitter-corrected',
              assume: false,
            },
          ],
        }),
      ),
    );
    fixture = TestBed.createComponent(Review);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;

    (root.querySelector('.correct-line') as HTMLButtonElement).click();
    fixture.detectChanges();
    const input = root.querySelector('input[name="line-correction"]') as HTMLInputElement;
    input.value = 'Keep CSV and XLSX export formats.';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (root.querySelector('.save-correction') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(api.correctSpecLine).toHaveBeenCalledWith(
      42,
      3,
      'Jordan D.',
      'Keep CSV and XLSX export formats.',
    );
    expect(root.textContent).toContain('corrected by you');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test intake`

Expected: FAIL because assumption lines currently have no confirm or correction controls.

- [ ] **Step 3: Write minimal implementation**

Add signals and methods to `Review`:

```ts
  correctingLineId = signal<number | null>(null);
  correctionText = signal('');
  lineError = signal<Record<number, string>>({});

  actor() {
    return this.session.user().name;
  }

  confirmLine(line: SpecLine) {
    this.lineError.set({});
    this.api.confirmSpecLine(this.id, line.id, this.actor()).subscribe({
      next: (r) => this.req.set(r),
      error: () =>
        this.lineError.update((e) => ({
          ...e,
          [line.id]: "That didn't save — try again.",
        })),
    });
  }

  startCorrection(line: SpecLine) {
    this.correctingLineId.set(line.id);
    this.correctionText.set(line.text);
  }

  saveCorrection(line: SpecLine) {
    const text = this.correctionText().trim();
    if (!text) {
      this.lineError.update((e) => ({ ...e, [line.id]: 'Type the correction first.' }));
      return;
    }
    this.lineError.set({});
    this.api.correctSpecLine(this.id, line.id, this.actor(), text).subscribe({
      next: (r) => {
        this.req.set(r);
        this.correctingLineId.set(null);
        this.correctionText.set('');
      },
      error: () =>
        this.lineError.update((e) => ({
          ...e,
          [line.id]: "That didn't save — try again.",
        })),
    });
  }
```

Inside the `@for (line of r.spec_lines; track line.id)` block, after the provenance chip, add:

```html
@if (line.assume) {
  <div class="assumption-actions">
    <button class="assume-btn confirm-line" type="button" (click)="confirmLine(line)">
      That's right
    </button>
    <button class="assume-btn correct-line" type="button" (click)="startCorrection(line)">
      Not quite — fix it
    </button>
  </div>
}
@if (correctingLineId() === line.id) {
  <div class="correction-row">
    <label class="sr-only" for="line-correction-{{ line.id }}">Correction</label>
    <input
      id="line-correction-{{ line.id }}"
      name="line-correction"
      [ngModel]="correctionText()"
      (ngModelChange)="correctionText.set($event)"
    />
    <button class="save-correction" type="button" (click)="saveCorrection(line)">Save</button>
  </div>
}
@if (lineError()[line.id]) {
  <div class="inline-error" role="alert">{{ lineError()[line.id] }}</div>
}
```

Add styles:

```css
.assumption-actions,
.correction-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.assume-btn,
.save-correction {
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: var(--fg1);
  font: inherit;
  font-size: 16px;
  padding: 9px 12px;
  cursor: pointer;
}
.confirm-line {
  border-color: color-mix(in srgb, var(--good) 34%, var(--border));
}
.correct-line {
  border-color: color-mix(in srgb, var(--warn) 34%, var(--border));
}
.correction-row input {
  min-height: 44px;
  flex: 1 1 240px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: var(--fg1);
  font: inherit;
  font-size: 16px;
  padding: 10px 12px;
}
.inline-error {
  color: var(--danger);
  font-size: 16px;
  margin-top: 8px;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test intake`

Expected: PASS with assumption confirm and correction tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/review.ts apps/intake/src/app/submitter/review.spec.ts
git commit -m "feat: let submitters resolve assumptions"
```

### Task 8: Check Screen Debounced Extra Detail PATCH, Submit Actor, And Failure Recovery

**Files:**
- Modify: `apps/intake/src/app/submitter/review.ts:1-320`
- Modify: `apps/intake/src/app/submitter/review.spec.ts`

**Interfaces:**
- Consumes: `Api.updateRequest(id, { extra_detail:string })`, `Api.submit(id, note, actor)`, `Session.user().name`.
- Produces: debounced `onExtraChange(text)`, visible submit failure copy, `Send to a reviewer` action, note text, done routing.

- [ ] **Step 1: Add failing tests**

Append these tests inside `describe('Review screen draft spec', ...)`:

```ts
  it('debounces extra detail PATCH as the submitter types', () => {
    vi.useFakeTimers();
    api.updateRequest.mockReturnValue(of(detail({ extra_detail: 'Please handle before Friday.' })));
    fixture = TestBed.createComponent(Review);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;

    const input = root.querySelector('input[name="extra_detail"]') as HTMLInputElement;
    input.value = 'Please handle before Friday.';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(api.updateRequest).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(api.updateRequest).toHaveBeenCalledWith(42, {
      extra_detail: 'Please handle before Friday.',
    });
    vi.useRealTimers();
  });

  it('submits to a reviewer with actor and shows recoverable failure copy', () => {
    api.submit.mockReturnValueOnce({
      subscribe: ({ error }: any) => error(new Error('bad gateway')),
    });
    fixture = TestBed.createComponent(Review);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;

    (root.querySelector('.send-reviewer') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(api.submit).toHaveBeenCalledWith(42, 'Please handle before Friday.', 'Jordan D.');
    expect(root.textContent).toContain(
      'Something went wrong sending your request — nothing was lost. Please try again.',
    );

    api.submit.mockReturnValueOnce(of(detail()));
    (root.querySelector('.send-reviewer') as HTMLButtonElement).click();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/submit/42/done');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test intake`

Expected: FAIL because current Review reads `extra` from `history.state`, has no debounced PATCH, labels the button `Submit request`, omits actor, and swallows submit errors.

- [ ] **Step 3: Write minimal implementation**

Add a timer field:

```ts
  private extraTimer: ReturnType<typeof setTimeout> | null = null;
```

Add this method:

```ts
  onExtraChange(text: string) {
    this.extra.set(text);
    if (this.extraTimer) clearTimeout(this.extraTimer);
    this.extraTimer = setTimeout(() => {
      this.api.updateRequest(this.id, { extra_detail: this.extra() }).subscribe({
        next: (r) => this.req.set(r),
        error: () => {
          this.submitError.set("That didn't save — try again.");
        },
      });
    }, 500);
  }
```

Replace the existing submit method with:

```ts
  submit() {
    this.submitting.set(true);
    this.submitError.set('');
    this.api.submit(this.id, this.extra(), this.actor()).subscribe({
      next: () => {
        this.draft.reset();
        this.router.navigateByUrl(`/submit/${this.id}/done`);
      },
      error: () => {
        this.submitting.set(false);
        this.submitError.set(
          'Something went wrong sending your request — nothing was lost. Please try again.',
        );
      },
    });
  }
```

Add this section below the attachments section in the template:

```html
<section class="extra-card">
  <label for="extra-detail">Anything to add? <span>(optional — saved as you type)</span></label>
  <input
    id="extra-detail"
    name="extra_detail"
    [ngModel]="extra()"
    (ngModelChange)="onExtraChange($event)"
  />
</section>

<div class="submit-row">
  <button class="btn primary send-reviewer" type="button" [disabled]="submitting()" (click)="submit()">
    {{ submitting() ? 'Sending…' : 'Send to a reviewer' }}
  </button>
  <span class="honest-note">A person reviews this before anything gets built.</span>
</div>

@if (submitError()) {
  <div class="submit-error" role="alert">{{ submitError() }}</div>
}
```

Add styles:

```css
.extra-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 18px;
}
.extra-card label {
  display: block;
  color: var(--fg1);
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 8px;
}
.extra-card label span {
  color: var(--muted);
  font-weight: 400;
}
.extra-card input {
  width: 100%;
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: var(--fg1);
  font: inherit;
  font-size: 16px;
  padding: 10px 12px;
}
.submit-row {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  align-items: center;
}
.send-reviewer {
  min-height: 44px;
}
.honest-note {
  color: var(--muted);
  font-size: 16px;
}
.submit-error {
  color: var(--danger);
  font-size: 16px;
  line-height: 1.45;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test intake`

Expected: PASS with debounced extra detail and submit failure tests green.

- [ ] **Step 5: Run focused verification for this plan**

Run: `npx ng test shared`

Expected: PASS.

Run: `npx ng test intake`

Expected: PASS.

Run: `task build`

Expected: Angular production build succeeds for both apps.

- [ ] **Step 6: Commit**

```bash
git add apps/intake/src/app/submitter/review.ts apps/intake/src/app/submitter/review.spec.ts
git commit -m "feat: persist check notes and submit safely"
```

## Scope Note

The plan makes the Check screen's "Edit description" control route to `/submit/new?requestId=:id`, but fully rehydrating Describe from that query needs a small follow-up in `apps/intake/src/app/submitter/new-request.ts` and `apps/intake/src/app/submitter/intake-draft.service.ts`. That follow-up is outside this Questions + Check screen plan and should be handled by the Describe plan so the same request id is patched instead of creating a duplicate.
