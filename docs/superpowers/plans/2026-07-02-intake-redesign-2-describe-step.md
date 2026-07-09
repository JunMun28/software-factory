# Intake Redesign 2 Describe Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Describe step into the approved slim form with accessible app picking, visible validation, autosaved drafts, recoverable attachments, honest save errors, and matching shell/visual polish.

**Architecture:** Keep the existing standalone Angular components and root `IntakeDraft` service, but make `IntakeDraft` the single typed state owner for the slim Describe form and local draft persistence. `NewRequest` becomes validation and interaction glue over that store, while `AttachField` renders attachment recovery state and `SubShell` owns the renamed four-step progress indicator. The shared `Api` client consumes the backend plan's pinned request/response shapes without adding a second client layer.

**Tech Stack:** Angular 22 standalone components, signals, inline templates/styles, Vitest through `npx ng test intake`, shared TypeScript API models under `packages/shared`.

## Global Constraints

- Type-first progressive disclosure stays: three selectable cards (Bug fix / Enhancement / New app) with one-line plain descriptions; relevant fields appear after selection.
- Bug fix: app picker, "What's going wrong?" description, optional attachments.
- Enhancement: app picker, "What should be better?" description, optional attachments.
- New app: "What should we call it?" name, description, optional attachments.
- Bug context fields (where seen / frequency) move to the interview, which asks only when useful. Reach / impact metric / impact value / urgency are removed from the form entirely.
- App picker: accessible combobox (ARIA combobox pattern), keyboard operable (arrows + Enter), filters as you type, hint text "Start typing — then pick one from the list." A typed-but-unpicked value produces a visible inline message on Continue, never a silently disabled button.
- Continue button is always enabled; pressing it with missing fields scrolls to and announces the first inline error (fixes disabled-button mystery + a11y finding).
- Draft autosave: form state persists to localStorage on change (debounced), keyed per user; restored on load with a quiet "Draft saved" indicator. Cleared on successful submit. Fixes refresh-loses-everything.
- Attachments: staged files that fail to upload stay visible with a retry affordance; navigation proceeds only when the user chooses to continue without them (explicit "continue without this file" action, not silent dropping).
- Save/continue failure shows: "Something went wrong saving your request — try again." (No claim that data is safe on first save — it is not yet on the server.)
- Step labels rename to plain verbs: **Describe → Questions → Check → Done**.
- The shared shell (`sub-shell.ts`) keeps the stepper; completed steps get checkmarks; forward steps stay non-clickable (sequence is load-bearing rule 1).
- Light warm near-white canvas, white cards, one purple accent `#BD03F7` used only for primary actions, active states, and "your answer" provenance. Amber reserved for assumptions/needs-input; green for done/confirmed; red for errors.
- Micron Basis for UI text (fallback Inter/system); JetBrains Mono only for request refs (REQ-142) and file sizes.
- Body text ≥16px everywhere, including hints and helper copy (audit found 12–13.5px guidance). Secondary text may be 14px minimum, never below.
- Interactive targets ≥44px tall. Generous spacing; one h1 per screen at a consistent size (28px) across the flow.
- Dark mode: the intake shell already has a theme toggle; every new surface and color must pass in both themes (verified by screenshots).
- App picker: ARIA combobox pattern, fully keyboard operable.
- All inputs labeled (visible label or aria-label) — no placeholder-only labels.
- Focus moves to the new question/step heading on transition.
- Full flow passes a keyboard-only run; visible focus states throughout.
- No silent failures: every subscribe error handler renders copy + a retry.
- Error copy pattern: what happened, whether data is safe (only when true), what to do next. Plain, unalarming tone.
- Draft autosave means refresh never loses form work; server persistence means refresh after Describe never duplicates requests.

### Task 1: Shared API Contract For The New Describe Flow

**Files:**
- Modify: `packages/shared/src/lib/models.ts:22-131`
- Modify: `packages/shared/src/lib/api.service.ts:5-70`
- Test: `packages/shared/src/lib/describe-api-contract.spec.ts`

**Interfaces:**
- Consumes: backend `POST /api/requests`, `PATCH /api/requests/{rid}`, `POST /api/requests/{rid}/submit`, `GET /api/requests/{rid}/interview`
- Produces: `RequestWrite`, `SubmitRequestBody`, `SpecLine`, `InterviewState`, typed `Api.createRequest(body: RequestWrite)`, `Api.updateRequest(id: number, body: Partial<RequestWrite>)`, `Api.submit(id: number, note: string, actor: string)`

- [ ] **Step 1: Write the failing contract test**

Create `packages/shared/src/lib/describe-api-contract.spec.ts` with this complete file:

```ts
import { HttpClient } from '@angular/common/http';
import { describe, expect, it, vi } from 'vitest';

import { Api } from './api.service';
import { InterviewState, RequestWrite, SpecLine } from './models';

function apiWithHttp() {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const http = {
    post: vi.fn((url: string, body: unknown) => {
      calls.push({ method: 'POST', url, body });
      return { subscribe: vi.fn() };
    }),
    patch: vi.fn((url: string, body: unknown) => {
      calls.push({ method: 'PATCH', url, body });
      return { subscribe: vi.fn() };
    }),
    get: vi.fn((url: string) => {
      calls.push({ method: 'GET', url });
      return { subscribe: vi.fn() };
    }),
  } as unknown as HttpClient;
  return { api: new Api(http), calls };
}

describe('Describe API contract', () => {
  it('createRequest accepts the backend plan request shape', () => {
    const { api, calls } = apiWithHttp();
    const body: RequestWrite = {
      type: 'enh',
      title: 'Improve expense export',
      description: 'The export needs a month filter.',
      app_id: 12,
      new_app_name: null,
      bug_where: null,
      urgency: 'normal',
      reach: null,
      impact_metric: null,
      impact_value: null,
      reporter: 'Jordan D.',
      reporter_initials: 'JD',
    };

    api.createRequest(body);

    expect(calls[0]).toEqual({ method: 'POST', url: '/api/requests', body });
  });

  it('updateRequest accepts a partial request write body', () => {
    const { api, calls } = apiWithHttp();

    api.updateRequest(42, { description: 'New wording', app_id: 9 });

    expect(calls[0]).toEqual({
      method: 'PATCH',
      url: '/api/requests/42',
      body: { description: 'New wording', app_id: 9 },
    });
  });

  it('submit sends actor with the optional note', () => {
    const { api, calls } = apiWithHttp();

    api.submit(42, 'Ready to review', 'Jordan D.');

    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/requests/42/submit',
      body: { note: 'Ready to review', actor: 'Jordan D.' },
    });
  });

  it('models the new interview and spec-line response fields', () => {
    const line: SpecLine = {
      id: 7,
      order: 1,
      text: 'Expense export keeps the selected month.',
      prov: 'Q1',
      assume: false,
    };
    const state: InterviewState = {
      done: false,
      asked: 1,
      total: 4,
      question: 'Who uses this?',
      sub: null,
      options: null,
      final: false,
      skip_assumption: 'Only your team needs it.',
      remaining_estimate: 3,
      turns: [],
    };

    expect(line.id).toBe(7);
    expect(state.skip_assumption).toContain('team');
    expect(state.remaining_estimate).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx ng test shared --watch=false`

Expected: FAIL because `Api` cannot be constructed with an injected `HttpClient`, `RequestWrite` is not exported, `SpecLine` lacks `id/order`, `InterviewState` lacks `skip_assumption/remaining_estimate`, and `submit()` only sends `{ note }`.

- [ ] **Step 3: Write the minimal implementation**

In `packages/shared/src/lib/models.ts`, replace the `Turn`, `SpecLine`, `FactoryRequest`, `RequestDetail`, and `InterviewState` type blocks at lines 22-131 with this complete code:

```ts
export interface Turn {
  order: number;
  question: string;
  sub: string | null;
  options: { t: string; d: string }[] | null;
  answer: string | null;
  skipped: boolean;
}

export interface SpecLine {
  id: number;
  order: number;
  text: string;
  prov: string | null;
  assume: boolean;
}

export interface RequestWrite {
  type: 'bug' | 'enh' | 'new';
  title: string;
  description: string;
  app_id: number | null;
  new_app_name: string | null;
  bug_where: string | null;
  urgency: string;
  reach: string | null;
  impact_metric: 'hours' | 'cost' | 'other' | null;
  impact_value: string | null;
  reporter: string;
  reporter_initials: string;
  extra_detail?: string | null;
}

export interface SubmitRequestBody {
  note?: string;
  actor: string;
}

export interface FactoryRequest {
  id: number;
  ref: string;
  title: string;
  description: string;
  type: 'bug' | 'enh' | 'new' | 'other';
  urgency: string;
  reach: string | null;
  impact_metric: 'hours' | 'cost' | 'other' | null;
  impact_value: string | null;
  priority: string;
  app_id: number | null;
  app_name: string;
  app_key: string | null;
  repo: string | null;
  prospective_repo: string | null;
  new_app_name: string | null;
  stage: 'intake' | 'spec' | 'architecture' | 'build' | 'review' | 'done';
  status: 'draft' | 'submitted' | 'pending_approval' | 'approved' | 'sent_back' | 'cancelled' | 'done';
  gate: 'approve_spec' | 'approve_merge' | null;
  needs_human: boolean;
  needs_human_reason: string | null;
  reporter: string;
  reporter_initials: string;
  labels: { name: string; color: string }[] | null;
  send_back_question: string | null;
  send_back_response: string | null;
  send_back_rounds: number;
  repo_ready: boolean;
  spec_pr_open: boolean;
  stage2_fired: boolean;
  spec_open_note: string | null;
  extra_detail: string | null;
  created_at: string;
  updated_at: string;
  stage_entered_at: string | null;
  last_event: string | null;
}

export interface Attachment {
  id: number;
  filename: string;
  mime: string;
  kind: 'image' | 'doc';
  size: number;
  source: 'describe' | 'interview';
  created_at: string;
}

export interface RequestDetail extends FactoryRequest {
  turns: Turn[];
  spec_lines: SpecLine[];
  comments: CommentItem[];
  audit: AuditItem[];
  duplicate: { ref: string; title: string; id: number } | null;
  run: RunState | null;
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

In `packages/shared/src/lib/api.service.ts`, update the imports and constructor, then replace `createRequest`, `updateRequest`, and `submit` with this complete code:

```ts
import {
  AppEntry,
  Attachment,
  CommentItem,
  FactoryRequest,
  InterviewState,
  MissionOut,
  ProgressEvent,
  RequestDetail,
  RequestWrite,
  SubmitRequestBody,
} from './models';

@Injectable({ providedIn: 'root' })
export class Api {
  constructor(private http: HttpClient) {}

  createRequest(body: RequestWrite): Observable<RequestDetail> {
    return this.http.post<RequestDetail>(`${BASE}/requests`, body);
  }

  updateRequest(id: number, body: Partial<RequestWrite>): Observable<RequestDetail> {
    return this.http.patch<RequestDetail>(`${BASE}/requests/${id}`, body);
  }

  submit(id: number, note = '', actor: string): Observable<RequestDetail> {
    const body: SubmitRequestBody = note ? { note, actor } : { actor };
    return this.http.post<RequestDetail>(`${BASE}/requests/${id}/submit`, body);
  }
}
```

Keep every other `Api` method exactly as it is today inside the same class.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx ng test shared --watch=false`

Expected: PASS for the new shared contract test and existing shared specs.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/lib/models.ts packages/shared/src/lib/api.service.ts packages/shared/src/lib/describe-api-contract.spec.ts
git commit -m "feat(shared): type describe request api contract"
```

### Task 2: Slim `IntakeDraft` Save Body And Per-User Autosave

**Files:**
- Modify: `apps/intake/src/app/submitter/intake-draft.service.ts:1-156`
- Modify: `apps/intake/src/app/submitter/intake-draft.service.spec.ts:1-194`
- Test: `apps/intake/src/app/submitter/intake-draft.service.spec.ts`

**Interfaces:**
- Consumes: `Session.user(): User`, `Api.createRequest(body: RequestWrite)`, `Api.updateRequest(id, body)`, browser `localStorage`
- Produces: `DescribeDraftSnapshot`, `IntakeDraft.scheduleAutosave()`, `IntakeDraft.restoreFromAutosave()`, `IntakeDraft.clearAutosave()`, `IntakeDraft.savedLabel = signal('Draft saved')`

- [ ] **Step 1: Write the failing tests**

Remove these obsolete tests from `apps/intake/src/app/submitter/intake-draft.service.spec.ts` because their fields moved out of Describe: `bug type sends reach:null and impact fields as null even when set`, `free-text reach wins over chip value`, and `impact is null when impactValue is blank (incomplete pair)`.

Append these complete tests to the `describe('IntakeDraft', () => { ... })` block in `apps/intake/src/app/submitter/intake-draft.service.spec.ts`:

```ts
  it('save() sends the slim Describe fields and nulls moved interview fields', async () => {
    draft.type = 'bug';
    draft.desc = 'The export is empty.';
    draft.appId = 4;
    draft.appName = 'Expense Tracker';
    draft.newName = 'Should not send for bug';

    await draft.save();

    const body = (api.createRequest.mock.calls as any[][])[0][0];
    expect(body).toMatchObject({
      type: 'bug',
      title: 'The export is empty',
      description: 'The export is empty.',
      app_id: 4,
      new_app_name: null,
      bug_where: null,
      urgency: 'normal',
      reach: null,
      impact_metric: null,
      impact_value: null,
      reporter: 'Jordan D.',
      reporter_initials: 'JD',
    });
    expect('bugFreq' in body).toBe(false);
    expect('reachText' in body).toBe(false);
  });

  it('save() sends new app name only for new app requests', async () => {
    draft.type = 'new';
    draft.newName = 'Quarterly staffing planner';
    draft.desc = 'Plan staffing by quarter.';

    await draft.save();

    const body = (api.createRequest.mock.calls as any[][])[0][0];
    expect(body.app_id).toBeNull();
    expect(body.new_app_name).toBe('Quarterly staffing planner');
  });

  it('autosaves and restores a per-user slim draft from localStorage', () => {
    draft.type = 'enh';
    draft.desc = 'Add CSV export.';
    draft.appId = 8;
    draft.appName = 'Expense Tracker';
    draft.markDirtyForAutosave();

    const restored = TestBed.inject(IntakeDraft);
    restored.reset();
    restored.restoreFromAutosave();

    expect(restored.type).toBe('enh');
    expect(restored.desc).toBe('Add CSV export.');
    expect(restored.appId).toBe(8);
    expect(restored.appName).toBe('Expense Tracker');
    expect(restored.savedLabel()).toBe('Draft saved');
  });

  it('clearAutosave removes the per-user draft after successful handoff', () => {
    draft.type = 'new';
    draft.newName = 'Plant floor checklist';
    draft.desc = 'Checklist for operators.';
    draft.markDirtyForAutosave();

    draft.clearAutosave();
    draft.reset();
    draft.restoreFromAutosave();

    expect(draft.type).toBeNull();
    expect(draft.desc).toBe('');
    expect(draft.newName).toBe('');
  });
```

Add this `beforeEach` line before `TestBed.configureTestingModule(...)` in the same spec:

```ts
vi.stubGlobal('localStorage', makeLocalStorageMock());
```

Add this helper near the top of the same spec, after `mockApi()`:

```ts
function makeLocalStorageMock() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => Object.keys(store).forEach((k) => delete store[k]),
  };
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ng test intake --watch=false`

Expected: FAIL because `markDirtyForAutosave`, `restoreFromAutosave`, `clearAutosave`, and `savedLabel` do not exist, and `save()` still carries moved form fields into the body.

- [ ] **Step 3: Write the minimal implementation**

In `apps/intake/src/app/submitter/intake-draft.service.ts`, add this type after imports:

```ts
type DescribeType = 'bug' | 'enh' | 'new';

export interface DescribeDraftSnapshot {
  requestId: number | null;
  type: DescribeType | null;
  title: string;
  desc: string;
  newName: string;
  appId: number | null;
  appName: string;
}
```

Replace the field declarations at lines 13-27 with this complete block:

```ts
  requestId: number | null = null;
  type: DescribeType | null = null;
  title = '';
  desc = '';
  newName = '';
  appId: number | null = null;
  appName = '';
  extra = '';
  savedLabel = signal('');
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
```

Add these methods before `reset()`:

```ts
  private autosaveKey(): string {
    return `sf-intake-draft:${this.session.user().email}`;
  }

  private snapshot(): DescribeDraftSnapshot {
    return {
      requestId: this.requestId,
      type: this.type,
      title: this.title,
      desc: this.desc,
      newName: this.newName,
      appId: this.appId,
      appName: this.appName,
    };
  }

  markDirtyForAutosave(): void {
    this.writeAutosave();
  }

  scheduleAutosave(delayMs = 400): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => this.writeAutosave(), delayMs);
  }

  private writeAutosave(): void {
    try {
      localStorage.setItem(this.autosaveKey(), JSON.stringify(this.snapshot()));
      this.savedLabel.set('Draft saved');
    } catch {
      this.savedLabel.set('');
    }
  }

  restoreFromAutosave(): void {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(this.autosaveKey());
    } catch {
      raw = null;
    }
    if (!raw) return;
    try {
      const s = JSON.parse(raw) as Partial<DescribeDraftSnapshot>;
      this.requestId = typeof s.requestId === 'number' ? s.requestId : null;
      this.type = s.type === 'bug' || s.type === 'enh' || s.type === 'new' ? s.type : null;
      this.title = typeof s.title === 'string' ? s.title : '';
      this.desc = typeof s.desc === 'string' ? s.desc : '';
      this.newName = typeof s.newName === 'string' ? s.newName : '';
      this.appId = typeof s.appId === 'number' ? s.appId : null;
      this.appName = typeof s.appName === 'string' ? s.appName : '';
      this.savedLabel.set('Draft saved');
    } catch {
      this.clearAutosave();
    }
  }

  clearAutosave(): void {
    try {
      localStorage.removeItem(this.autosaveKey());
    } catch {
      return;
    }
  }
```

Replace `reset()` with this complete method:

```ts
  reset() {
    this.requestId = null;
    this.type = null;
    this.title = this.desc = this.newName = this.extra = '';
    this.appId = null;
    this.appName = '';
    this.attachments.set([]);
    this.pending.set([]);
    this.failedUploads.set([]);
    this.lastError.set('');
    this.savedLabel.set('');
  }
```

Replace `save()` with this complete method:

```ts
  async save(): Promise<number> {
    if (this.type == null) throw new Error('Choose a request type.');
    const u = this.session.user();
    const isAppReq = this.type === 'bug' || this.type === 'enh';
    const body = {
      type: this.type,
      title: this.title || this.autoTitle(),
      description: this.desc,
      app_id: isAppReq ? this.appId : null,
      new_app_name: this.type === 'new' ? this.newName.trim() || null : null,
      bug_where: null,
      urgency: 'normal',
      reach: null,
      impact_metric: null,
      impact_value: null,
      reporter: u.name,
      reporter_initials: u.initials,
    };
    if (this.requestId == null) {
      const r = await firstValueFrom(this.api.createRequest(body));
      this.requestId = r.id;
    } else {
      await firstValueFrom(this.api.updateRequest(this.requestId, body));
    }
    return this.requestId;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ng test intake --watch=false`

Expected: PASS for `IntakeDraft`; no test asserts Describe-owned reach, impact, or bug-frequency fields.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/intake-draft.service.ts apps/intake/src/app/submitter/intake-draft.service.spec.ts
git commit -m "feat(intake): autosave slim describe draft"
```

### Task 3: Attachment Failure State With Retry And Explicit Continue

**Files:**
- Modify: `apps/intake/src/app/submitter/intake-draft.service.ts:29-76`
- Modify: `apps/intake/src/app/submitter/intake-draft.service.spec.ts`
- Test: `apps/intake/src/app/submitter/intake-draft.service.spec.ts`

**Interfaces:**
- Consumes: `Api.uploadAttachment(rid, file, source)`
- Produces: `FailedUpload`, `IntakeDraft.failedUploads`, `IntakeDraft.retryFailedUpload(index)`, `IntakeDraft.continueWithoutFailedUpload(index)`, `IntakeDraft.hasBlockingUploadFailures()`

- [ ] **Step 1: Write the failing tests**

Append these complete tests to `apps/intake/src/app/submitter/intake-draft.service.spec.ts`:

```ts
  it('keeps failed pending uploads visible and blocks handoff until resolved', async () => {
    api.uploadAttachment.mockReturnValue(throwError(() => new Error('network')));
    const file = new File(['x'], 'evidence.png', { type: 'image/png' });

    draft.pending.set([file]);
    await draft.uploadPending(42);

    expect(draft.pending()).toEqual([]);
    expect(draft.failedUploads().map((f) => f.file.name)).toEqual(['evidence.png']);
    expect(draft.hasBlockingUploadFailures()).toBe(true);
  });

  it('retryFailedUpload uploads the same file and removes the failure on success', async () => {
    const file = new File(['x'], 'evidence.png', { type: 'image/png' });
    draft.failedUploads.set([{ file, source: 'describe', message: 'Upload failed' }]);
    api.uploadAttachment.mockReturnValue(
      of({
        id: 9,
        filename: 'evidence.png',
        mime: 'image/png',
        kind: 'image',
        size: 1,
        source: 'describe',
        created_at: '',
      } as Attachment),
    );

    await draft.retryFailedUpload(0, 42);

    expect(draft.failedUploads()).toEqual([]);
    expect(draft.attachments()[0].filename).toBe('evidence.png');
    expect(draft.hasBlockingUploadFailures()).toBe(false);
  });

  it('continueWithoutFailedUpload removes only the chosen failed file', () => {
    const a = new File(['a'], 'a.png', { type: 'image/png' });
    const b = new File(['b'], 'b.png', { type: 'image/png' });
    draft.failedUploads.set([
      { file: a, source: 'describe', message: 'Upload failed' },
      { file: b, source: 'describe', message: 'Upload failed' },
    ]);

    draft.continueWithoutFailedUpload(0);

    expect(draft.failedUploads().map((f) => f.file.name)).toEqual(['b.png']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ng test intake --watch=false`

Expected: FAIL because `failedUploads`, retry, continue-without, and blocking checks do not exist.

- [ ] **Step 3: Write the minimal implementation**

In `apps/intake/src/app/submitter/intake-draft.service.ts`, add this exported interface below `DescribeDraftSnapshot`:

```ts
export interface FailedUpload {
  file: File;
  source: 'describe' | 'interview';
  message: string;
}
```

Add this signal next to `pending` and `lastError`:

```ts
  failedUploads = signal<FailedUpload[]>([]);
```

Replace `uploadOne` and `uploadPending` with these complete methods:

```ts
  private async uploadOne(
    rid: number,
    f: File,
    source: 'describe' | 'interview',
  ): Promise<boolean> {
    try {
      const att = await firstValueFrom(this.api.uploadAttachment(rid, f, source));
      this.attachments.update((a) => [...a, att]);
      return true;
    } catch {
      this.failedUploads.update((items) => [
        ...items,
        { file: f, source, message: 'Upload failed' },
      ]);
      this.lastError.set(`${f.name}: upload failed`);
      return false;
    }
  }

  async uploadPending(rid: number): Promise<void> {
    const staged = this.pending();
    this.pending.set([]);
    for (const f of staged) await this.uploadOne(rid, f, 'describe');
  }
```

Add these methods after `uploadPending`:

```ts
  hasBlockingUploadFailures(): boolean {
    return this.failedUploads().length > 0;
  }

  async retryFailedUpload(index: number, rid = this.requestId): Promise<void> {
    if (rid == null) return;
    const item = this.failedUploads()[index];
    if (!item) return;
    this.failedUploads.update((items) => items.filter((_, i) => i !== index));
    const ok = await this.uploadOne(rid, item.file, item.source);
    if (!ok) {
      this.failedUploads.update((items) => {
        const next = [...items];
        next.splice(index, 0, item);
        return next;
      });
    }
  }

  continueWithoutFailedUpload(index: number): void {
    this.failedUploads.update((items) => items.filter((_, i) => i !== index));
    if (!this.failedUploads().length) this.lastError.set('');
  }
```

Update `addFiles` line 58 so immediate uploads use the new boolean-returning helper:

```ts
        await this.uploadOne(this.requestId, f, source);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ng test intake --watch=false`

Expected: PASS for the new attachment failure tests and previous `IntakeDraft` tests.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/intake-draft.service.ts apps/intake/src/app/submitter/intake-draft.service.spec.ts
git commit -m "feat(intake): keep failed uploads recoverable"
```

### Task 4: Attachment Field Recovery UI

**Files:**
- Modify: `apps/intake/src/app/submitter/attach-field.ts:1-94`
- Create: `apps/intake/src/app/submitter/attach-field.spec.ts`
- Test: `apps/intake/src/app/submitter/attach-field.spec.ts`

**Interfaces:**
- Consumes: `IntakeDraft.failedUploads()`, `IntakeDraft.retryFailedUpload(index)`, `IntakeDraft.continueWithoutFailedUpload(index)`
- Produces: visible failed-file row with Retry and "Continue without this file" actions

- [ ] **Step 1: Write the failing component test**

Create `apps/intake/src/app/submitter/attach-field.spec.ts` with this complete file:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { Api } from '@sf/shared';
import { IntakeDraft } from './intake-draft.service';
import { AttachField } from './attach-field';

function draftStub() {
  const file = new File(['x'], 'failed.png', { type: 'image/png' });
  return {
    attachments: () => [],
    pending: () => [],
    failedUploads: () => [{ file, source: 'describe', message: 'Upload failed' }],
    lastError: () => '',
    addFiles: vi.fn(),
    removeAttachment: vi.fn(),
    removePending: vi.fn(),
    retryFailedUpload: vi.fn(),
    continueWithoutFailedUpload: vi.fn(),
  };
}

describe('AttachField', () => {
  it('renders failed uploads with retry and explicit continue-without actions', () => {
    const draft = draftStub();
    TestBed.configureTestingModule({
      imports: [AttachField],
      providers: [
        { provide: IntakeDraft, useValue: draft },
        { provide: Api, useValue: { attachmentRawUrl: vi.fn() } },
      ],
    });
    const fixture: ComponentFixture<AttachField> = TestBed.createComponent(AttachField);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('failed.png');
    expect(text).toContain('Upload failed');
    expect(text).toContain('Retry');
    expect(text).toContain('Continue without this file');

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    buttons.find((b) => b.textContent?.includes('Retry'))!.click();
    buttons.find((b) => b.textContent?.includes('Continue without this file'))!.click();

    expect(draft.retryFailedUpload).toHaveBeenCalledWith(0);
    expect(draft.continueWithoutFailedUpload).toHaveBeenCalledWith(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx ng test intake --watch=false`

Expected: FAIL because failed uploads are not rendered.

- [ ] **Step 3: Write the minimal implementation**

In `apps/intake/src/app/submitter/attach-field.ts`, inside the `.attach__chips` block after the pending loop, add this complete template block:

```html
          @for (f of draft.failedUploads(); track $index) {
            <span class="attach__chip attach__chip--failed">
              <sf-icon name="warn" [size]="13" color="var(--red-tx)" />
              <span class="attach__name">{{ f.file.name }}</span>
              <span class="attach__fail">{{ f.message }}</span>
              <button type="button" class="attach__link" (click)="draft.retryFailedUpload($index)">
                Retry
              </button>
              <button
                type="button"
                class="attach__link attach__link--quiet"
                (click)="draft.continueWithoutFailedUpload($index)"
              >
                Continue without this file
              </button>
            </span>
          }
```

Change the conditional at line 32 to include failures:

```html
      @if (draft.attachments().length || draft.pending().length || draft.failedUploads().length) {
```

Add these inline component styles to the `@Component` metadata:

```ts
  styles: `
    .attach__chip--failed {
      border-color: var(--red-line);
      background: var(--red-bg);
      color: var(--red-tx);
    }
    .attach__fail {
      font-size: 14px;
      color: var(--red-tx);
    }
    .attach__link {
      min-height: 32px;
      border: 0;
      background: transparent;
      color: var(--accent-link);
      font: inherit;
      font-size: 14px;
      text-decoration: underline;
      text-underline-offset: 3px;
      cursor: pointer;
    }
    .attach__link--quiet {
      color: var(--muted);
    }
  `,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx ng test intake --watch=false`

Expected: PASS for `AttachField` and the intake suite.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/attach-field.ts apps/intake/src/app/submitter/attach-field.spec.ts
git commit -m "feat(intake): show attachment upload recovery actions"
```

### Task 5: Slim Form Rendering, Always-Enabled Continue, Inline Errors, And Save Failure Copy

**Files:**
- Modify: `apps/intake/src/app/submitter/new-request.ts:14-493`
- Create: `apps/intake/src/app/submitter/new-request.spec.ts`
- Test: `apps/intake/src/app/submitter/new-request.spec.ts`

**Interfaces:**
- Consumes: `IntakeDraft.type`, `IntakeDraft.desc`, `IntakeDraft.newName`, `IntakeDraft.appId`, `IntakeDraft.appName`, `IntakeDraft.savedLabel()`, `IntakeDraft.hasBlockingUploadFailures()`, `IntakeDraft.save()`
- Produces: `NewRequest.errors`, `NewRequest.formError`, `NewRequest.firstErrorId`, `NewRequest.continue_()`, visible aria-live validation and save failure copy

- [ ] **Step 1: Write the failing component tests**

Create `apps/intake/src/app/submitter/new-request.spec.ts` with this complete file:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { Api } from '@sf/shared';
import { NewRequest } from './new-request';
import { IntakeDraft } from './intake-draft.service';

function draftStub() {
  return {
    requestId: null,
    type: null as 'bug' | 'enh' | 'new' | null,
    title: '',
    desc: '',
    newName: '',
    appId: null as number | null,
    appName: '',
    savedLabel: () => 'Draft saved',
    restoreFromAutosave: vi.fn(),
    scheduleAutosave: vi.fn(),
    clearAutosave: vi.fn(),
    hasBlockingUploadFailures: vi.fn(() => false),
    save: vi.fn(async () => 42),
    uploadPending: vi.fn(async () => undefined),
  };
}

function setup() {
  const draft = draftStub();
  TestBed.configureTestingModule({
    imports: [NewRequest],
    providers: [
      provideRouter([]),
      { provide: IntakeDraft, useValue: draft },
      { provide: Api, useValue: { apps: vi.fn(() => of([{ id: 1, name: 'Expense Tracker', muted: false }])) } },
    ],
  });
  const router = TestBed.inject(Router);
  vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  const fixture: ComponentFixture<NewRequest> = TestBed.createComponent(NewRequest);
  return { fixture, component: fixture.componentInstance, draft, router };
}

describe('NewRequest slim Describe form', () => {
  it('renders only the three approved request types', () => {
    const { component } = setup();
    expect(component.types.map((t) => t.title)).toEqual(['Bug fix', 'Enhancement', 'New app']);
  });

  it('keeps Continue enabled and reports the first missing field inline', async () => {
    const { fixture, component, draft } = setup();
    draft.type = 'enh';
    fixture.detectChanges();

    await component.continue_();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Pick an app from the list.');
    expect(component.formError()).toBe('Pick an app from the list.');
  });

  it('does not render reach, impact, urgency, bug where, or frequency fields', () => {
    const { fixture, draft } = setup();
    draft.type = 'bug';
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;

    expect(text).not.toContain("Who's affected?");
    expect(text).not.toContain("What's the impact?");
    expect(text).not.toContain('How urgent is it?');
    expect(text).not.toContain('Where did you see it?');
    expect(text).not.toContain('How often?');
  });

  it('shows the required save failure copy', async () => {
    const { fixture, component, draft } = setup();
    draft.type = 'new';
    draft.newName = 'Plant floor checklist';
    draft.desc = 'A checklist app.';
    draft.save.mockRejectedValue(new Error('network'));

    await component.continue_();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Something went wrong saving your request — try again.',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ng test intake --watch=false`

Expected: FAIL because the form still has four request types, removed fields are still present, Continue is disabled by `canContinue()`, and save failures have no visible copy.

- [ ] **Step 3: Write the minimal implementation**

In `apps/intake/src/app/submitter/new-request.ts`, replace the `types` array with:

```ts
  types = [
    { t: 'bug' as const, icon: 'bug', title: 'Bug fix', help: "Something's broken in an app you use" },
    { t: 'enh' as const, icon: 'spark', title: 'Enhancement', help: 'Improve an app that already exists' },
    { t: 'new' as const, icon: 'app', title: 'New app', help: "Build something that doesn't exist yet" },
  ];
```

Delete the template blocks currently rendering bug context fields, reach, impact, and urgency at lines 144-267.

Replace the Continue footer at lines 268-277 with this complete template:

```html
            <div class="formfoot">
              @if (draft.savedLabel()) {
                <span class="saved"><sf-icon name="check" [size]="14" /> {{ draft.savedLabel() }}</span>
              }
              <span class="spacer"></span>
              <button class="btn primary lg" [disabled]="saving()" (click)="continue_()">
                {{ saving() ? 'Saving…' : 'Continue to questions' }}
                <sf-icon name="arrowRight" [size]="16" />
              </button>
            </div>
            @if (formError()) {
              <p class="inline-err" role="alert" aria-live="assertive" [id]="firstErrorId()">
                {{ formError() }}
              </p>
            }
```

In the component class, add these signals after `saving`:

```ts
  formError = signal('');
  firstErrorId = signal('nr-form-error');
```

Replace `canContinue()` and `continue_()` with:

```ts
  private validate(): string {
    if (!this.draft.type) return 'Choose a request type.';
    if ((this.draft.type === 'bug' || this.draft.type === 'enh') && !this.draft.appId) {
      return 'Pick an app from the list.';
    }
    if (this.draft.type === 'new' && !this.draft.newName.trim()) {
      return 'Tell us what to call the new app.';
    }
    if (!this.draft.desc.trim()) return 'Describe what you need.';
    if (this.draft.hasBlockingUploadFailures()) {
      return 'Retry the failed upload or choose continue without this file.';
    }
    return '';
  }

  private announceError(message: string): void {
    this.formError.set(message);
    queueMicrotask(() => {
      document.getElementById(this.firstErrorId())?.scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      });
    });
  }

  async continue_() {
    const validation = this.validate();
    if (validation) {
      this.announceError(validation);
      return;
    }
    this.saving.set(true);
    this.formError.set('');
    try {
      const id = await this.draft.save();
      await this.draft.uploadPending(id);
      if (this.draft.hasBlockingUploadFailures()) {
        this.announceError('Retry the failed upload or choose continue without this file.');
        return;
      }
      this.draft.clearAutosave();
      this.router.navigateByUrl(`/submit/${id}/interview`);
    } catch {
      this.formError.set('Something went wrong saving your request — try again.');
    } finally {
      this.saving.set(false);
    }
  }
```

Add this method and wire it to every user-editing `ngModelChange`/type click:

```ts
  markDraftChanged(): void {
    this.formError.set('');
    this.draft.scheduleAutosave();
  }
```

In the constructor, call restore first:

```ts
    this.draft.restoreFromAutosave();
```

Add these component styles:

```ts
    .formfoot {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-top: 4px;
    }
    .spacer {
      flex: 1;
    }
    .saved {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 44px;
      color: var(--muted);
      font-size: 14px;
    }
    .inline-err {
      margin: 14px 0 0;
      padding: 12px 14px;
      border: 1px solid var(--red-line);
      border-radius: 10px;
      background: var(--red-bg);
      color: var(--red-tx);
      font-size: 14px;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ng test intake --watch=false`

Expected: PASS for the slim form tests.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/new-request.ts apps/intake/src/app/submitter/new-request.spec.ts
git commit -m "feat(intake): slim describe form with visible validation"
```

### Task 6: ARIA Combobox Keyboard Behavior And Typed-Unpicked Error

**Files:**
- Modify: `apps/intake/src/app/submitter/new-request.ts:49-108, 341-447`
- Modify: `apps/intake/src/app/submitter/new-request.spec.ts`
- Test: `apps/intake/src/app/submitter/new-request.spec.ts`

**Interfaces:**
- Consumes: `AppEntry[]`, `KeyboardEvent.key`, `appQuery()`
- Produces: `activeAppIndex`, `activeAppId()`, `onAppKeydown(event)`, `onAppFocusOut(event)`, typed-but-unpicked inline error

- [ ] **Step 1: Write the failing tests**

Append these tests to `apps/intake/src/app/submitter/new-request.spec.ts`:

```ts
  it('selects a filtered app with ArrowDown and Enter', () => {
    const { component, draft } = setup();
    component.apps.set([
      { id: 1, key: 'exp', name: 'Expense Tracker', owner: '', repo: '', provisioning: '', muted: false, open_requests: 0, unread: false },
      { id: 2, key: 'ops', name: 'Ops Board', owner: '', repo: '', provisioning: '', muted: false, open_requests: 0, unread: false },
    ]);

    component.onAppInput('exp');
    component.onAppKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    component.onAppKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(draft.appId).toBe(1);
    expect(draft.appName).toBe('Expense Tracker');
  });

  it('keeps typed-but-unpicked app text invalid on Continue', async () => {
    const { component, draft } = setup();
    draft.type = 'enh';
    draft.desc = 'Add a PDF export.';

    component.onAppInput('expense');
    await component.continue_();

    expect(component.formError()).toBe('Start typing — then pick one from the list.');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ng test intake --watch=false`

Expected: FAIL because `onAppKeydown` does not exist and typed-but-unpicked app text produces the generic pick-app error.

- [ ] **Step 3: Write the minimal implementation**

In `new-request.ts`, update the app input template at lines 52-68 to include active descendant, hint, focusout, and keydown:

```html
                  <input
                    id="nr-app-dd"
                    class="input"
                    role="combobox"
                    autocomplete="off"
                    aria-autocomplete="list"
                    aria-labelledby="nr-app-lbl"
                    aria-describedby="nr-app-hint"
                    aria-controls="nr-app-list"
                    [attr.aria-expanded]="appsMenuOpen()"
                    [attr.aria-activedescendant]="activeAppId()"
                    maxlength="120"
                    placeholder="Search apps"
                    [ngModel]="appQuery()"
                    (ngModelChange)="onAppInput($event); markDraftChanged()"
                    (focus)="openApps()"
                    (focusout)="onAppFocusOut($event)"
                    (keydown)="onAppKeydown($event)"
                  />
                  <span id="nr-app-hint" class="field-help">Start typing — then pick one from the list.</span>
```

Update each app option button in the listbox to have a stable id and click handler:

```html
                        <button
                          class="pop__opt"
                          type="button"
                          role="option"
                          [id]="'nr-app-opt-' + a.id"
                          [attr.aria-selected]="draft.appId === a.id"
                          [class.on]="activeAppId() === 'nr-app-opt-' + a.id || draft.appId === a.id"
                          (click)="pickApp(a); markDraftChanged()"
                          (mousedown)="$event.preventDefault()"
                        >
                          <span class="dd__hash">#</span>{{ a.name }}
                        </button>
```

Add these members to the component class:

```ts
  activeAppIndex = signal(0);

  activeAppId = computed(() => {
    const app = this.filteredApps()[this.activeAppIndex()];
    return app ? `nr-app-opt-${app.id}` : null;
  });
```

Replace `openApps`, `onAppInput`, and `pickApp` with:

```ts
  openApps() {
    this.appsMenuOpen.set(true);
    this.activeAppIndex.set(0);
  }

  onAppInput(text: string) {
    this.appQuery.set(text);
    this.draft.appId = null;
    this.draft.appName = '';
    this.activeAppIndex.set(0);
    this.appsMenuOpen.set(true);
  }

  pickApp(a: AppEntry) {
    this.draft.appId = a.id;
    this.draft.appName = a.name;
    this.appQuery.set(a.name);
    this.appsMenuOpen.set(false);
    this.formError.set('');
  }
```

Add these methods:

```ts
  onAppKeydown(event: KeyboardEvent): void {
    const matches = this.filteredApps();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.appsMenuOpen.set(true);
      this.activeAppIndex.set(Math.min(this.activeAppIndex() + 1, Math.max(matches.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeAppIndex.set(Math.max(this.activeAppIndex() - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      const app = matches[this.activeAppIndex()];
      if (app) {
        event.preventDefault();
        this.pickApp(app);
        this.markDraftChanged();
      }
      return;
    }
    if (event.key === 'Escape') {
      this.appsMenuOpen.set(false);
    }
  }

  onAppFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    const wrap = event.currentTarget instanceof HTMLElement ? event.currentTarget.closest('.dd-wrap') : null;
    if (wrap && next && wrap.contains(next)) return;
    this.appsMenuOpen.set(false);
  }
```

Change the app validation branch in `validate()` to distinguish typed-but-unpicked text:

```ts
    if (this.draft.type === 'bug' || this.draft.type === 'enh') {
      if (!this.draft.appId && this.appQuery().trim()) {
        return 'Start typing — then pick one from the list.';
      }
      if (!this.draft.appId) return 'Pick an app from the list.';
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ng test intake --watch=false`

Expected: PASS for combobox tests and existing form tests.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/new-request.ts apps/intake/src/app/submitter/new-request.spec.ts
git commit -m "feat(intake): keyboard accessible app picker"
```

### Task 7: Shell Stepper Labels, Checkmarks, And Forward Lock

**Files:**
- Modify: `apps/intake/src/app/submitter/sub-shell.ts:47-125`
- Create: `apps/intake/src/app/submitter/sub-shell.spec.ts`
- Test: `apps/intake/src/app/submitter/sub-shell.spec.ts`

**Interfaces:**
- Consumes: `SubShell.step`, `SubShell.reqId`
- Produces: `steps = Describe / Questions / Check / Done`, completed checkmarks, disabled forward steps

- [ ] **Step 1: Write the failing component test**

Create `apps/intake/src/app/submitter/sub-shell.spec.ts` with this complete file:

```ts
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { Session } from '../core/session.service';
import { SubShell } from './sub-shell';

@Component({
  imports: [SubShell],
  template: `<sub-shell [step]="1" [reqId]="42"><p>Body</p></sub-shell>`,
})
class HostComponent {}

describe('SubShell stepper', () => {
  it('uses approved labels, checkmarks completed steps, and keeps forward steps disabled', () => {
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideRouter([]),
        {
          provide: Session,
          useValue: {
            user: () => ({ name: 'Jordan', initials: 'JD', email: 'j@example.com', color: '#7A', role: 'submitter' }),
          },
        },
      ],
    });
    const fixture: ComponentFixture<HostComponent> = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button.step')) as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Describe',
      '2 Questions',
      '3 Check',
      '4 Done',
    ]);
    expect(buttons[0].classList.contains('done')).toBe(true);
    expect(buttons[2].disabled).toBe(true);
    expect(buttons[3].disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx ng test intake --watch=false`

Expected: FAIL because labels are still `Clarify` and `Review`, and there is no `Done` step.

- [ ] **Step 3: Write the minimal implementation**

In `apps/intake/src/app/submitter/sub-shell.ts`, replace the `steps` array with:

```ts
  steps = [
    { label: 'Describe', path: () => '/submit/new' },
    { label: 'Questions', path: (id: number | null) => `/submit/${id}/interview` },
    { label: 'Check', path: (id: number | null) => `/submit/${id}/review` },
    { label: 'Done', path: (id: number | null) => `/submit/${id}/done` },
  ];
```

Replace `backable()` with:

```ts
  backable() {
    return this.step()! <= 3;
  }
```

Keep the existing `[disabled]="i >= step()! || !backable()"` binding unchanged; that is the forward-lock requirement.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx ng test intake --watch=false`

Expected: PASS for the stepper test and the intake suite.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/app/submitter/sub-shell.ts apps/intake/src/app/submitter/sub-shell.spec.ts
git commit -m "feat(intake): rename submitter stepper"
```

### Task 8: Approved Visual System For Describe

**Files:**
- Modify: `apps/intake/src/styles.css:45-169, 560-849`
- Modify: `apps/intake/src/app/submitter/new-request.ts:16-334`
- Create: `apps/intake/src/app/submitter/describe-visual-contract.spec.ts`
- Test: `apps/intake/src/app/submitter/describe-visual-contract.spec.ts`

**Interfaces:**
- Consumes: existing CSS tokens (`--bg`, `--surface`, `--accent`, `--red-*`, `--green-*`, dark theme `[data-theme='dark']`)
- Produces: warm light canvas, accent `#BD03F7`, h1 28px, helper text at least 14px, interactive targets at least 44px

- [ ] **Step 1: Write the failing visual contract test**

Create `apps/intake/src/app/submitter/describe-visual-contract.spec.ts` with this complete file:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync('apps/intake/src/styles.css', 'utf8');
const newRequest = readFileSync('apps/intake/src/app/submitter/new-request.ts', 'utf8');

describe('Describe visual contract', () => {
  it('uses the approved warm canvas and purple accent tokens in light and dark mode', () => {
    expect(styles).toContain('--bg: #faf8f5;');
    expect(styles).toContain('--accent: #bd03f7;');
    expect(styles).toContain('--accent-link: #8a02b5;');
    expect(styles).toContain('[data-theme=\"dark\"]');
    expect(styles).toContain('--bg: #16121b;');
  });

  it('keeps Describe typography and targets within the approved sizes', () => {
    expect(newRequest).toContain('<h1>What kind of request is this?</h1>');
    expect(newRequest).toContain('font-size: 28px;');
    expect(styles).toContain('.field-help');
    expect(styles).toContain('font-size: 14px;');
    expect(styles).toContain('min-height: 44px;');
  });

  it('does not use sub-14px helper text in Describe-owned styles', () => {
    expect(newRequest).not.toMatch(/font-size:\s*(1[0-3](?:\.\d+)?px)/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx ng test intake --watch=false`

Expected: FAIL because current tokens use cooler `#faf9fb`/`#a402dc`, Describe h1 is inline 30px, and helper/type-card text includes 12-13px sizes.

- [ ] **Step 3: Write the minimal implementation**

In `apps/intake/src/styles.css`, update the light token block:

```css
  --bg: #faf8f5;
  --surface: #ffffff;
  --surface-2: #f5f2ed;
  --surface-3: #ece7df;
  --accent: #bd03f7;
  --accent-hover: #a402dc;
  --accent-active: #8a02b5;
  --accent-link: #8a02b5;
  --accent-tint: rgba(189, 3, 247, 0.07);
  --accent-tint-bd: rgba(189, 3, 247, 0.35);
```

In the dark token block, set:

```css
  --bg: #16121b;
  --surface: #1f1a26;
  --surface-2: #282230;
  --surface-3: #30283a;
```

Update shared helper and type-card sizes:

```css
.field-help {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.5;
}

.typecard {
  min-height: 116px;
  padding: 18px;
}

.typecard__t {
  font-size: 16px;
}

.typecard__h {
  font-size: 14px;
  line-height: 1.5;
}
```

In `new-request.ts`, replace the top copy at lines 16-20 with:

```html
      <div class="sub-col describe-page pop-in">
        <h1>What kind of request is this?</h1>
        <p class="describe-lede">
          A sentence or two is plenty — we'll ask a few follow-up questions next.
        </p>
```

Add these component styles:

```ts
    .describe-page h1 {
      margin: 0;
      color: var(--fg);
      font-size: 28px;
      line-height: 1.2;
      font-weight: 650;
    }
    .describe-lede {
      margin: 8px 0 24px;
      color: var(--muted);
      font-size: 16px;
      line-height: 1.55;
    }
    .typecard,
    .pop__opt,
    .btn,
    input.input {
      min-height: 44px;
    }
```

- [ ] **Step 4: Run tests and build verification**

Run: `npx ng test intake --watch=false`

Expected: PASS for visual contract and intake tests.

Run: `npx ng build intake`

Expected: production build succeeds and no component style budget error is introduced.

- [ ] **Step 5: Commit**

```bash
git add apps/intake/src/styles.css apps/intake/src/app/submitter/new-request.ts apps/intake/src/app/submitter/describe-visual-contract.spec.ts
git commit -m "feat(intake): apply describe visual system"
```

### Task 9: Edit An Existing Request From Check (Rehydrate The Form)

**Files:**
- Modify: `apps/intake/src/app/submitter/intake-draft.service.ts:1-180`
- Modify: `apps/intake/src/app/submitter/intake-draft.service.spec.ts:1-260`
- Modify: `apps/intake/src/app/submitter/new-request.ts:1-520`
- Modify: `apps/intake/src/app/submitter/new-request.spec.ts:1-220`

**Interfaces:**
- Consumes:
  - Check screen link from Plan 3 Task 6: `/submit/new?requestId=:id`
  - `Api.request(id) -> RequestDetail`
  - `Api.updateRequest(id, body) -> RequestDetail`
  - `IntakeDraft.restoreFromAutosave()`
  - `IntakeDraft.save()`
  - `RequestDetail.attachments`
- Produces:
  - `IntakeDraft.hydrateFromRequest(r: RequestDetail) -> void`
  - `NewRequest.editMode = signal(false)`
  - `NewRequest.loadingEdit = signal(false)`
  - `NewRequest.editLoadError = signal('')`
  - `NewRequest.loadEditRequest(id: number) -> void`
  - `NewRequest.retryLoadEdit() -> void`
  - edit-mode load failure copy: `We couldn't load your request — try again.`
  - edit mode bypasses autosave restore, shows existing attachments read-only, PATCHes the existing request, and navigates to `/submit/:id/review`

- [ ] **Step 1: Write the failing tests**

In `apps/intake/src/app/submitter/intake-draft.service.spec.ts`, update the shared import from `@sf/shared`:

```ts
import { Api, Attachment, RequestDetail } from '@sf/shared';
```

Append this complete helper below `mockApi()`:

```ts
function requestDetail(overrides: Partial<RequestDetail> = {}): RequestDetail {
  return {
    id: 42,
    ref: 'REQ-42',
    title: 'Improve expense export',
    description: 'Add a month filter to the expense export.',
    type: 'enh',
    urgency: 'normal',
    reach: null,
    impact_metric: null,
    impact_value: null,
    priority: 'normal',
    app_id: 7,
    app_name: 'Expense Tracker',
    app_key: 'expense',
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
    turns: [],
    spec_lines: [],
    comments: [],
    audit: [],
    duplicate: null,
    run: null,
    evidence: null,
    attachments: [
      {
        id: 9,
        filename: 'current-export.png',
        mime: 'image/png',
        kind: 'image',
        size: 2048,
        source: 'describe',
        created_at: '',
      },
    ],
    ...overrides,
  };
}
```

Append this complete test inside `describe('IntakeDraft', () => { ... })`:

```ts
  it('hydrates an existing request and save() PATCHes it without creating a duplicate', async () => {
    draft.hydrateFromRequest(requestDetail());
    draft.desc = 'Add a month and department filter to the expense export.';

    await draft.save();

    expect(api.createRequest).not.toHaveBeenCalled();
    expect(api.updateRequest).toHaveBeenCalledOnce();
    expect((api.updateRequest.mock.calls as any[][])[0][0]).toBe(42);
    expect((api.updateRequest.mock.calls as any[][])[0][1]).toMatchObject({
      type: 'enh',
      title: 'Improve expense export',
      description: 'Add a month and department filter to the expense export.',
      app_id: 7,
      new_app_name: null,
    });
    expect(draft.attachments().map((a) => a.filename)).toEqual(['current-export.png']);
  });
```

In `apps/intake/src/app/submitter/new-request.spec.ts`, replace the imports at the top with this complete import block:

```ts
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { Api, RequestDetail } from '@sf/shared';
import { NewRequest } from './new-request';
import { IntakeDraft } from './intake-draft.service';
```

Replace the existing `draftStub()` and `setup()` helpers in `apps/intake/src/app/submitter/new-request.spec.ts` with this complete helper block:

```ts
function requestDetail(overrides: Partial<RequestDetail> = {}): RequestDetail {
  return {
    id: 42,
    ref: 'REQ-42',
    title: 'Improve expense export',
    description: 'Add a month filter to the expense export.',
    type: 'enh',
    urgency: 'normal',
    reach: null,
    impact_metric: null,
    impact_value: null,
    priority: 'normal',
    app_id: 7,
    app_name: 'Expense Tracker',
    app_key: 'expense',
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
    turns: [],
    spec_lines: [],
    comments: [],
    audit: [],
    duplicate: null,
    run: null,
    evidence: null,
    attachments: [
      {
        id: 9,
        filename: 'current-export.png',
        mime: 'image/png',
        kind: 'image',
        size: 2048,
        source: 'describe',
        created_at: '',
      },
    ],
    ...overrides,
  };
}

function queryParamMap(requestId: string | null) {
  return {
    get: (key: string) => (key === 'requestId' ? requestId : null),
  };
}

function draftStub() {
  const draft = {
    requestId: null as number | null,
    type: null as 'bug' | 'enh' | 'new' | null,
    title: '',
    desc: '',
    newName: '',
    appId: null as number | null,
    appName: '',
    attachments: signal<RequestDetail['attachments']>([]),
    savedLabel: () => 'Draft saved',
    restoreFromAutosave: vi.fn(),
    scheduleAutosave: vi.fn(),
    clearAutosave: vi.fn(),
    hasBlockingUploadFailures: vi.fn(() => false),
    hydrateFromRequest: vi.fn((r: RequestDetail) => {
      draft.requestId = r.id;
      draft.type = r.type === 'bug' || r.type === 'enh' || r.type === 'new' ? r.type : null;
      draft.title = r.title;
      draft.desc = r.description;
      draft.newName = r.new_app_name ?? '';
      draft.appId = r.app_id;
      draft.appName = r.app_name;
      draft.attachments.set(r.attachments ?? []);
    }),
    save: vi.fn(async () => 42),
    uploadPending: vi.fn(async () => undefined),
  };
  return draft;
}

function setup(requestId: string | null = null, apiOverrides: Partial<Record<string, unknown>> = {}) {
  const draft = draftStub();
  const api = {
    apps: vi.fn(() => of([{ id: 7, name: 'Expense Tracker', muted: false }])),
    request: vi.fn(() => of(requestDetail())),
    ...apiOverrides,
  };
  TestBed.configureTestingModule({
    imports: [NewRequest],
    providers: [
      provideRouter([]),
      { provide: IntakeDraft, useValue: draft },
      { provide: Api, useValue: api },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: queryParamMap(requestId) } } },
    ],
  });
  const router = TestBed.inject(Router);
  vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  const fixture: ComponentFixture<NewRequest> = TestBed.createComponent(NewRequest);
  return { fixture, component: fixture.componentInstance, draft, router, api };
}
```

Append these complete tests inside `describe('NewRequest slim Describe form', () => { ... })`:

```ts
  it('loads requestId query param from Check, hydrates the form, and bypasses autosave restore', () => {
    const { fixture, draft, api } = setup('42');

    fixture.detectChanges();

    expect(api.request).toHaveBeenCalledWith(42);
    expect(draft.hydrateFromRequest).toHaveBeenCalledOnce();
    expect(draft.restoreFromAutosave).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Existing attachments');
    expect(fixture.nativeElement.textContent).toContain('current-export.png');
  });

  it('shows edit-load failure copy and retries the same request', () => {
    const apiRequest = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('network')))
      .mockReturnValueOnce(of(requestDetail({ description: 'Loaded on retry.' })));
    const { fixture, component, api } = setup('42', { request: apiRequest });

    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("We couldn't load your request — try again.");

    component.retryLoadEdit();
    fixture.detectChanges();

    expect(api.request).toHaveBeenCalledTimes(2);
    expect(fixture.nativeElement.textContent).not.toContain("We couldn't load your request — try again.");
  });

  it('continues an edited request to Check instead of creating a new interview path', async () => {
    const { component, draft, router } = setup('42');
    draft.type = 'enh';
    draft.appId = 7;
    draft.desc = 'Add a better export filter.';

    await component.continue_();

    expect(draft.save).toHaveBeenCalledOnce();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/submit/42/review');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ng test intake --watch=false`

Expected: FAIL because `IntakeDraft.hydrateFromRequest` does not exist, `NewRequest` does not read `requestId` from the query string, edit mode does not bypass autosave restore, and edit-mode Continue still routes to `/submit/42/interview`.

- [ ] **Step 3: Write the minimal implementation**

In `apps/intake/src/app/submitter/intake-draft.service.ts`, update the shared import:

```ts
import { Api, Attachment, RequestDetail } from '@sf/shared';
```

Add this method before `reset()`:

```ts
  hydrateFromRequest(r: RequestDetail): void {
    this.requestId = r.id;
    this.type = r.type === 'bug' || r.type === 'enh' || r.type === 'new' ? r.type : null;
    this.title = r.title;
    this.desc = r.description;
    this.newName = r.type === 'new' ? r.new_app_name || r.app_name : '';
    this.appId = r.type === 'bug' || r.type === 'enh' ? r.app_id : null;
    this.appName = r.type === 'bug' || r.type === 'enh' ? r.app_name : '';
    this.extra = r.extra_detail ?? '';
    this.attachments.set(r.attachments ?? []);
    this.pending.set([]);
    this.failedUploads.set([]);
    this.lastError.set('');
    this.savedLabel.set('');
  }
```

In `apps/intake/src/app/submitter/new-request.ts`, replace the router import:

```ts
import { ActivatedRoute, Router } from '@angular/router';
```

Add these fields after the existing `private router = inject(Router);` line:

```ts
  private route = inject(ActivatedRoute);
  editMode = signal(false);
  loadingEdit = signal(false);
  editLoadError = signal('');
  private editRequestId: number | null = null;
```

Replace the start of the template under the `h1`/lede copy with this complete failure block:

```html
        @if (editLoadError()) {
          <section class="edit-load-error" role="alert" aria-live="assertive">
            <p>We couldn't load your request — try again.</p>
            <button class="btn secondary" type="button" (click)="retryLoadEdit()">Retry</button>
          </section>
        }
```

Replace the attachments field block with this complete edit-aware block:

```html
            @if (editMode()) {
              <section class="readonly-attachments" aria-label="Existing attachments">
                <label class="field-label">Existing attachments</label>
                @for (a of draft.attachments(); track a.id) {
                  <div class="readonly-attachment">
                    <sf-icon name="paperclip" [size]="16" />
                    <span>{{ a.filename }}</span>
                    <small>{{ fileSize(a.size) }}</small>
                  </div>
                } @empty {
                  <p class="readonly-empty">No attachments added yet.</p>
                }
              </section>
            } @else {
              <div>
                <label class="field-label"
                  >Attachments
                  <span style="font-weight:400;color:var(--faint)">(optional)</span></label
                >
                <span class="field-help"
                  >Screenshots, logs, or docs help the AI understand faster.</span
                >
                <sf-attach-field source="describe" />
              </div>
            }
```

Replace the constructor with this complete constructor:

```ts
  constructor() {
    const rawEditId = this.route.snapshot.queryParamMap.get('requestId');
    const editId = rawEditId ? Number(rawEditId) : NaN;
    if (Number.isInteger(editId) && editId > 0) {
      this.editMode.set(true);
      this.editRequestId = editId;
      this.loadEditRequest(editId);
    } else {
      this.draft.restoreFromAutosave();
      this.syncAppQueryFromDraft();
    }
    this.api.apps().subscribe((a) => {
      this.apps.set(a.filter((x) => !x.muted));
      if (!this.appQuery() && this.draft.appId != null) {
        const m = this.apps().find((x) => x.id === this.draft.appId);
        if (m) {
          this.appQuery.set(m.name);
          this.draft.appName = m.name;
        }
      }
    });
  }
```

Add these methods before `openApps()`:

```ts
  private syncAppQueryFromDraft(): void {
    this.appQuery.set(this.draft.appName);
    this.customApp.set(!!this.draft.appName && this.draft.appId == null);
  }

  loadEditRequest(id: number): void {
    this.loadingEdit.set(true);
    this.editLoadError.set('');
    this.api.request(id).subscribe({
      next: (r) => {
        this.draft.hydrateFromRequest(r);
        this.syncAppQueryFromDraft();
        this.loadingEdit.set(false);
      },
      error: () => {
        this.loadingEdit.set(false);
        this.editLoadError.set("We couldn't load your request — try again.");
      },
    });
  }

  retryLoadEdit(): void {
    if (this.editRequestId != null) {
      this.loadEditRequest(this.editRequestId);
    }
  }

  fileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = Math.round(bytes / 1024);
    if (kb < 1024) return `${kb} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
  }
```

Replace the success navigation in `continue_()` with:

```ts
      this.draft.clearAutosave();
      const next = this.editMode() ? `/submit/${id}/review` : `/submit/${id}/interview`;
      this.router.navigateByUrl(next);
```

Add these component styles:

```ts
    .edit-load-error {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin: 18px 0;
      padding: 14px 16px;
      border: 1px solid var(--red-line);
      border-radius: 10px;
      background: var(--red-bg);
      color: var(--red-tx);
    }
    .edit-load-error p {
      margin: 0;
      font-size: 14px;
    }
    .readonly-attachments {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .readonly-attachment {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 44px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-2);
      color: var(--fg);
      font-size: 14px;
    }
    .readonly-attachment small {
      margin-left: auto;
      color: var(--muted);
      font-size: 14px;
    }
    .readonly-empty {
      margin: 0;
      min-height: 44px;
      padding: 10px 12px;
      border: 1px dashed var(--border);
      border-radius: 8px;
      color: var(--muted);
      font-size: 14px;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ng test intake --watch=false`

Expected: PASS for the new edit-mode tests and existing Describe tests.

- [ ] **Step 5: Build verification**

Run: `npx ng build intake`

Expected: production build succeeds with no TypeScript errors from `ActivatedRoute`, `RequestDetail`, `hydrateFromRequest`, or readonly attachment rendering.

- [ ] **Step 6: Commit**

```bash
git add apps/intake/src/app/submitter/intake-draft.service.ts apps/intake/src/app/submitter/intake-draft.service.spec.ts apps/intake/src/app/submitter/new-request.ts apps/intake/src/app/submitter/new-request.spec.ts
git commit -m "feat(intake): edit existing requests from check"
```

## Final Verification

- [ ] Run `npx ng test intake --watch=false` and expect PASS.
- [ ] Run `npx ng test shared --watch=false` and expect PASS.
- [ ] Run `npx ng build intake` and expect success.
- [ ] Run `task verify-intake` and expect the Intake lint/test/build/smoke gate to pass.
- [ ] Keyboard check `/submit/new`: Tab reaches type cards, app input, app options, attachments, and Continue; ArrowDown/ArrowUp/Enter selects an app; typed-but-unpicked text shows "Start typing — then pick one from the list."
- [ ] Failure check `/submit/new`: mock `draft.save()` or network POST failure and confirm visible copy says exactly "Something went wrong saving your request — try again."
- [ ] Attachment check: force one upload failure, confirm the failed file stays visible until Retry succeeds or "Continue without this file" is clicked.
- [ ] Visual check: light and dark `/submit/new` at 1440px and 390px show warm canvas, one 28px h1, no clipped text, no target under 44px.
