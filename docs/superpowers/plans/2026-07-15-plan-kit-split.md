# Kit Split (Deepening Candidate 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink `@sf/shared` to true both-app primitives: split `packages/shared/src/lib/kit.ts` into focused files under `lib/kit/`, move the five console-only gate modals (plus `floor-action-outcome`) into the console app, delete five dead components, and make `public-api.ts` an explicit per-symbol contract.

**Architecture:** `@sf/shared` is plain in-repo source resolved via the root tsconfig path `@sf/shared -> packages/shared/src/public-api.ts`; both apps compile it directly, and any change under `packages/shared/**` triggers the shared-gate CI (ADR 0017). Every change here is a pure move / import-path update / dead-code deletion — component code is copied **verbatim**, selectors and behavior unchanged. The shared surface shrinks; the gate (`.github/workflows/shared-gate.yml`) stays exactly as it is (design decision D12).

**Tech Stack:** Angular 22 standalone components with inline templates (house style), vitest via `ng test` (three projects: `intake`, `console`, `shared`), Task (Taskfile.yml) for verify recipes.

## Design decisions this plan implements (binding)

From `docs/superpowers/specs/2026-07-14-deepening-candidates-design.md`, Candidate 2:

- **D9:** true primitives stay in shared under `lib/kit/`; console-only domain modals move into the console app next to floor/dossier; `floor-action-outcome` moves to a console-shared location.
- **D10:** `public-api.ts` becomes per-symbol exports (no `export *`).
- **D11:** `EscalationBox` deleted (zero consumers).
- **D12:** `shared-gate.yml` unchanged.

## Verified consumer map (grep at 8316758, 2026-07-15 — worktrees excluded)

| Symbol | Consumers | Fate |
|---|---|---|
| `Glyph` | intake (`confirm.ts`, `request-detail.ts`) + console (`library-page.ts`) | stays in shared |
| `Autofocus` | console (`console-shell.ts`) + the two send-back modals | stays in shared |
| `Icon`, `Mark`, `Avatar`, `Pill`, `TypeChip`, `TrackChip`, `Sig` | intake only today, but generic UI primitives (D9) | stay in shared |
| `ApproveModal`, `SendBackModal`, `SendBackStageModal`, `RecoveryConfirm`, `CancelConfirm` | console only (`floor-page.ts`, `dossier-page.ts`) | move to console |
| `EscalationBox`, `PopMenu`, `SpecLines`, `InterviewAnswers`, `EvidenceStrip` | **zero consumers anywhere** | delete |

## Deviations from the design doc (current code has moved on)

The design doc's Candidate-2 list is stale — it predates the console-redesign merge
(197cdd3). D9 names **six** console-only modals including `EvidenceStrip`, but
`EvidenceStrip` now has **zero** consumers (the redesigned floor/dossier render
evidence inline). D9's operative rule is "grep-verified at implementation time",
and D11's deletion test ("zero consumers → delete") is the same rule that killed
`EscalationBox`. Applying it uniformly:

- **Delete, not move:** `EvidenceStrip` (dead — moving dead code into console
  would defeat the point of the split).
- **Also delete:** `PopMenu`, `SpecLines`, `InterviewAnswers` — dead the same way,
  unmentioned by the design doc only because its list was a snapshot. Git history
  preserves them; `plans/004-pop-menu-component.md` documents PopMenu if it is
  ever needed again.
- **Not touched:** `evidenceBits` / `confirmSteps` and all model types stay in
  `util.ts` / `models.ts` even where their last component consumer moved or died —
  contract slimming is Candidate 5, explicitly out of scope. (`evidenceBits` ends
  up test-only; noted as a Candidate-5 follow-up, not deleted here.)

Executors: if any grep in Task 2 finds a live consumer, STOP, keep that symbol in
shared, and log the deviation in `implementation-notes.md` under `## Deviations`.

## Global Constraints

- **Zero behavioral / visual change.** Pure moves, import-path updates, and dead-code deletion. Component code is copied verbatim: same selectors, same templates, same styles, same class names.
- **Every task independently verify-green.** Each task ends with the task gate before its commit:
  `npx ng lint shared && npx ng lint console && npx ng lint intake && task test-web && task build`
  (vitest for intake + console + shared must ALL pass). Task 5 additionally ends with the full `task verify` (lint + pytest + vitest ×3 + build ×2 + smoke).
- **House style:** Angular standalone components with inline templates. All moved code already complies; do not convert anything to external templates.
- **`shared-gate.yml` unchanged** (D12). Do not edit `.github/workflows/shared-gate.yml`.
- **No new dependencies.** No changes to `angular.json`, `tsconfig.json`, `Taskfile.yml`, or any eslint config.
- **Branch:** all work on branch `kit-split` off local `main` (8316758 or later). Do not push; merge decision is the owner's.
- Repo rule (CLAUDE.md): never UPDATE or DELETE `progress_event` rows — irrelevant to this frontend-only plan, but binding.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- If an edge case forces a deviation, pick the conservative option, log it in `implementation-notes.md` under `## Deviations`, and keep going.

---

### Task 1: Console-shared home — move `floor-action-outcome`

`dossier-page.ts` currently reaches across folders into `../floor/floor-action-outcome`. Create the console app's shared directory and move the module there (D9's "console-shared location"). Pure file move + 4 import-path updates; the existing `floor.spec.ts` / `dossier.spec.ts` suites are the regression harness.

**Files:**
- Move: `apps/console/src/app/floor/floor-action-outcome.ts` → `apps/console/src/app/shared/action-outcome.ts`
- Modify: `apps/console/src/app/floor/floor-page.ts`
- Modify: `apps/console/src/app/floor/floor-content.ts`
- Modify: `apps/console/src/app/floor/floor-gate-card.ts`
- Modify: `apps/console/src/app/dossier/dossier-page.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `apps/console/src/app/shared/action-outcome.ts` exporting (unchanged signatures)
  `interface FloorActionOutcome { kind: 'conflict' | 'error'; message: string }`,
  `type FloorActionVerb`, `interface FloorActionError`,
  `function floorActionOutcome(verb: FloorActionVerb, error: FloorActionError): FloorActionOutcome`.
  Task 3 puts `gate-modals.ts` in the same `apps/console/src/app/shared/` directory.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/wongjunmun/development/ai-development/software-factory
git checkout main && git checkout -b kit-split
```

- [ ] **Step 2: Move the file (content unchanged — do not edit the moved file)**

```bash
mkdir -p apps/console/src/app/shared
git mv apps/console/src/app/floor/floor-action-outcome.ts apps/console/src/app/shared/action-outcome.ts
```

Keep every exported name exactly as-is (`FloorActionOutcome`, `FloorActionVerb`, `FloorActionError`, `floorActionOutcome`) — renaming symbols would ripple into templates and specs for zero benefit.

- [ ] **Step 3: Update the four importers**

In `apps/console/src/app/floor/floor-page.ts`, change the import path (names unchanged):

```ts
// old
} from './floor-action-outcome';
// new
} from '../shared/action-outcome';
```

In `apps/console/src/app/floor/floor-content.ts`:

```ts
// old
import { FloorActionOutcome } from './floor-action-outcome';
// new
import { FloorActionOutcome } from '../shared/action-outcome';
```

In `apps/console/src/app/floor/floor-gate-card.ts`:

```ts
// old
import { FloorActionOutcome } from './floor-action-outcome';
// new
import { FloorActionOutcome } from '../shared/action-outcome';
```

In `apps/console/src/app/dossier/dossier-page.ts`:

```ts
// old
} from '../floor/floor-action-outcome';
// new
} from '../shared/action-outcome';
```

- [ ] **Step 4: Confirm no stale references remain**

Run: `grep -rn "floor-action-outcome" apps packages --include='*.ts' | grep -v node_modules`
Expected: no output.

- [ ] **Step 5: Run the task gate**

Run: `npx ng lint shared && npx ng lint console && npx ng lint intake && task test-web && task build`
Expected: all green (existing `floor.spec.ts` and `dossier.spec.ts` exercise these pages).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(console): move floor-action-outcome to app-level shared home

Dossier no longer reaches into ../floor for the action-outcome vocabulary
(deepening candidate 2, D9). Pure move; no behavioral change.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Delete the five dead kit components

`EscalationBox` (D11) plus `PopMenu`, `SpecLines`, `InterviewAnswers`, `EvidenceStrip` — all grep-verified to have zero consumers outside `kit.ts` itself (see "Deviations from the design doc" above). Deletion is gated on re-running the grep at execution time.

**Files:**
- Modify: `packages/shared/src/lib/kit.ts` (delete five classes + shrink imports)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `kit.ts` now exports exactly `Autofocus, Glyph, Icon, Mark, Avatar, Pill, TypeChip, TrackChip, Sig, ApproveModal, SendBackModal, RecoveryConfirm, SendBackStageModal, CancelConfirm` (the five modals leave in Task 3).

- [ ] **Step 1: Re-run the deletion test (the gate for this whole task)**

Run:

```bash
grep -rnE "\b(PopMenu|EscalationBox|SpecLines|InterviewAnswers|EvidenceStrip)\b|sf-(pop-menu|escalation-box|spec-lines|interview-answers|evidence-strip)" \
  apps packages --include='*.ts' --include='*.html' | grep -v node_modules
```

Expected: every hit is inside `packages/shared/src/lib/kit.ts` itself (class declarations and one cross-reference comment). **If any file outside `kit.ts` appears, STOP: keep that symbol, delete only the confirmed-dead ones, and log the deviation in `implementation-notes.md`.**

- [ ] **Step 2: Delete the five components from `kit.ts`**

Delete each of these, including the `/** ... */` doc comment directly above it:

1. `@Component({ selector: 'sf-pop-menu', ... }) export class PopMenu { ... }` — also delete its section comment `/* ---- sf-pop-menu — the one floating options panel (plan 004) ---- */`
2. `@Component({ selector: 'sf-escalation-box', ... }) export class EscalationBox { ... }`
3. `@Component({ selector: 'sf-spec-lines', ... }) export class SpecLines { ... }`
4. `@Component({ selector: 'sf-interview-answers', ... }) export class InterviewAnswers { ... }`
5. `@Component({ selector: 'sf-evidence-strip', ... }) export class EvidenceStrip { ... }`

Replace the section comment above the (kept, for now) modals:

```ts
// old
/* ---- shared gate UI — one copy of the escalation box, spec rendering,
   and the three irreversible-action modals (board, issue, queue consume these) ---- */
// new
/* ---- gate UI — the irreversible-action modals (floor/dossier consume these) ---- */
```

- [ ] **Step 3: Shrink the `kit.ts` import header to exactly this**

(`model` was only used by InterviewAnswers; `Evidence`/`SpecLine`/`Turn` and `evidenceBits` only by the deleted components. `FormsModule`, `FactoryRequest`, `confirmSteps` are still used by the modals until Task 3.)

```ts
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import { FactoryRequest } from './models';
import { TYPE_LABEL, confirmSteps } from './util';
```

- [ ] **Step 4: Run the task gate**

Run: `npx ng lint shared && npx ng lint console && npx ng lint intake && task test-web && task build`
Expected: all green. (Unused-import leftovers would fail `ng lint shared` — the header above is exact.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(shared): delete five dead kit components

EscalationBox (design D11), PopMenu, SpecLines, InterviewAnswers and
EvidenceStrip all have zero consumers after the console redesign
(grep-verified). evidenceBits/confirmSteps and the model types stay —
contract slimming is candidate 5, out of scope.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Move the five gate modals into the console app

`ApproveModal`, `SendBackModal`, `SendBackStageModal`, `RecoveryConfirm`, `CancelConfirm` are consumed only by `floor-page.ts` and `dossier-page.ts`. They move — verbatim — to `apps/console/src/app/shared/gate-modals.ts`, gaining their first direct test coverage on the way (TDD: the spec is written first and fails on the missing module).

**Files:**
- Test (create): `apps/console/src/app/shared/gate-modals.spec.ts`
- Create: `apps/console/src/app/shared/gate-modals.ts`
- Modify: `apps/console/src/app/floor/floor-page.ts`
- Modify: `apps/console/src/app/dossier/dossier-page.ts`
- Modify: `packages/shared/src/lib/kit.ts` (remove the five modal classes)

**Interfaces:**
- Consumes: the `apps/console/src/app/shared/` directory from Task 1; `Autofocus`, `Icon`, `FactoryRequest`, `confirmSteps` from `@sf/shared` (all remain exported through Task 5).
- Produces: `apps/console/src/app/shared/gate-modals.ts` exporting the five component classes with unchanged selectors (`sf-approve-modal`, `sf-send-back-modal`, `sf-send-back-stage-modal`, `sf-recovery-confirm`, `sf-cancel-confirm`) and unchanged inputs/outputs.

- [ ] **Step 1: Write the failing spec**

Create `apps/console/src/app/shared/gate-modals.spec.ts`:

```ts
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { FactoryRequest } from '@sf/shared';

import {
  ApproveModal,
  CancelConfirm,
  RecoveryConfirm,
  SendBackModal,
  SendBackStageModal,
} from './gate-modals';

function req(over: Partial<FactoryRequest> = {}): FactoryRequest {
  return {
    id: 1,
    ref: 'REQ-1',
    title: 'Fix the export',
    description: '',
    type: 'enh',
    urgency: 'normal',
    reach: null,
    impact_metric: null,
    impact_value: null,
    bug_where: null,
    priority: 'Normal',
    app_id: 1,
    app_name: 'App',
    app_key: 'app',
    repo: null,
    prospective_repo: null,
    new_app_name: null,
    stage: 'spec',
    status: 'pending_approval',
    gate: 'approve_spec',
    needs_human: false,
    needs_human_reason: null,
    reporter: 'Jun',
    reporter_initials: 'JM',
    labels: null,
    send_back_question: null,
    send_back_response: null,
    send_back_rounds: 0,
    repo_ready: false,
    spec_pr_open: false,
    stage2_fired: false,
    spec_open_note: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stage_entered_at: null,
    last_event: null,
    ...over,
  };
}

@Component({
  imports: [ApproveModal],
  template: `<sf-approve-modal
    [r]="r()"
    (approved)="approvals = approvals + 1"
    (cancelled)="cancels = cancels + 1"
  />`,
})
class ApproveHost {
  r = signal(req({ gate: 'approve_spec', prospective_repo: 'micron/new-app' }));
  approvals = 0;
  cancels = 0;
}

@Component({
  imports: [SendBackModal],
  template: `<sf-send-back-modal
    reporter="Jun"
    (sent)="sentNote = $event"
    (cancelled)="cancels = cancels + 1"
  />`,
})
class SendBackHost {
  sentNote = '';
  cancels = 0;
}

@Component({
  imports: [SendBackStageModal],
  template: `<sf-send-back-stage-modal [currentStage]="stage()" (sent)="sentTo = $event" />`,
})
class StageHost {
  stage = signal<FactoryRequest['stage']>('review');
  sentTo: { stage: 'architecture' | 'build' | 'review'; reason: string } | null = null;
}

@Component({
  imports: [RecoveryConfirm],
  template: `<sf-recovery-confirm
    title="Retry the build?"
    consequence="Re-runs the stage from its last checkpoint."
    confirmLabel="Retry"
    (kept)="keeps = keeps + 1"
    (confirmed)="confirms = confirms + 1"
  />`,
})
class RecoveryHost {
  keeps = 0;
  confirms = 0;
}

@Component({
  imports: [CancelConfirm],
  template: `<sf-cancel-confirm
    [r]="r()"
    (kept)="keeps = keeps + 1"
    (confirmed)="confirms = confirms + 1"
  />`,
})
class CancelHost {
  r = signal(req());
  keeps = 0;
  confirms = 0;
}

describe('ApproveModal', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [ApproveHost] }));

  it('renders the spec-gate copy with the irreversible steps', () => {
    const f = TestBed.createComponent(ApproveHost);
    f.detectChanges();
    const text = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Approve this spec?');
    expect(text).toContain('Approve & start build');
    expect(text).toContain('Create the GitHub repo');
    expect(text).toContain('micron/new-app'); // prospective_repo via confirmSteps
  });

  it('renders the merge-gate copy', () => {
    const f = TestBed.createComponent(ApproveHost);
    f.componentInstance.r.set(req({ gate: 'approve_merge', repo: 'micron/northwind' }));
    f.detectChanges();
    const text = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Approve this merge?');
    expect(text).toContain('Approve & deploy');
    expect(text).toContain('micron/northwind');
  });

  it('emits approved / cancelled from the two buttons', () => {
    const f = TestBed.createComponent(ApproveHost);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.btn.primary')!.click();
    el.querySelector<HTMLButtonElement>('.btn:not(.primary)')!.click();
    expect(f.componentInstance.approvals).toBe(1);
    expect(f.componentInstance.cancels).toBe(1);
  });
});

describe('SendBackModal', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [SendBackHost] }));

  it('disables Send back until a note is typed, then emits the trimmed note', async () => {
    const f = TestBed.createComponent(SendBackHost);
    f.detectChanges();
    await f.whenStable();
    const el = f.nativeElement as HTMLElement;
    const primary = el.querySelector<HTMLButtonElement>('.btn.primary')!;
    expect(primary.disabled).toBe(true);

    const area = el.querySelector<HTMLTextAreaElement>('textarea')!;
    area.value = '  Which environment does this affect?  ';
    area.dispatchEvent(new Event('input'));
    f.detectChanges();
    await f.whenStable();

    expect(primary.disabled).toBe(false);
    primary.click();
    expect(f.componentInstance.sentNote).toBe('Which environment does this affect?');
  });
});

describe('SendBackStageModal', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [StageHost] }));

  it('offers only strictly-earlier stages from review', () => {
    const f = TestBed.createComponent(StageHost);
    f.detectChanges();
    const labels = Array.from(
      (f.nativeElement as HTMLElement).querySelectorAll('.stage-choice'),
    ).map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Architecture', 'Build']);
  });

  it('explains when there is nothing earlier', () => {
    const f = TestBed.createComponent(StageHost);
    f.componentInstance.stage.set('architecture');
    f.detectChanges();
    const text = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('already the earliest stage');
    expect((f.nativeElement as HTMLElement).querySelectorAll('.stage-choice').length).toBe(0);
  });

  it('requires a stage and a reason, then emits both', async () => {
    const f = TestBed.createComponent(StageHost);
    f.detectChanges();
    await f.whenStable();
    const el = f.nativeElement as HTMLElement;

    el.querySelectorAll<HTMLButtonElement>('.stage-choice')[1]!.click(); // Build
    f.detectChanges();
    await f.whenStable();

    const area = el.querySelector<HTMLTextAreaElement>('textarea')!;
    area.value = 'Wrong DB migration.';
    area.dispatchEvent(new Event('input'));
    f.detectChanges();
    await f.whenStable();

    el.querySelector<HTMLButtonElement>('.btn.primary:not(.stage-choice)')!.click();
    expect(f.componentInstance.sentTo).toEqual({ stage: 'build', reason: 'Wrong DB migration.' });
  });
});

describe('RecoveryConfirm', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [RecoveryHost] }));

  it('renders title, consequence and confirm label, and emits both outputs', () => {
    const f = TestBed.createComponent(RecoveryHost);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const text = el.textContent ?? '';
    expect(text).toContain('Retry the build?');
    expect(text).toContain('last checkpoint');
    el.querySelector<HTMLButtonElement>('.btn.primary')!.click(); // "Retry"
    el.querySelector<HTMLButtonElement>('.btn:not(.primary)')!.click(); // "Keep it stopped"
    expect(f.componentInstance.confirms).toBe(1);
    expect(f.componentInstance.keeps).toBe(1);
  });
});

describe('CancelConfirm', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [CancelHost] }));

  it('names the request and reporter, and emits confirmed from the danger button', () => {
    const f = TestBed.createComponent(CancelHost);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const text = el.textContent ?? '';
    expect(text).toContain('Cancel this request?');
    expect(text).toContain('Fix the export');
    expect(text).toContain('Jun');
    el.querySelector<HTMLButtonElement>('.btn.danger')!.click();
    expect(f.componentInstance.confirms).toBe(1);
  });
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `npx ng test console`
Expected: FAIL — `gate-modals.spec.ts` cannot resolve `./gate-modals`.

- [ ] **Step 3: Create `apps/console/src/app/shared/gate-modals.ts`**

The five component classes are copied **verbatim** from `packages/shared/src/lib/kit.ts` (do NOT retype them — copy the exact class blocks including their doc comments). Only the file header is new:

```ts
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Autofocus, FactoryRequest, Icon, confirmSteps } from '@sf/shared';

/* ---- gate UI — the irreversible-action modals (floor/dossier consume these).
   Moved verbatim out of @sf/shared (deepening candidate 2, D9): the console is
   their only consumer, so they no longer belong on the shared contract. ---- */
```

Then, in this order, the verbatim class blocks from `kit.ts`:

1. `/** The "Approve this merge/spec?" confirmation — the one intentional friction point. */` + `@Component({ selector: 'sf-approve-modal', ... }) export class ApproveModal { ... }`
2. `/** The "Send back to {reporter}?" modal — emits the blocking question. */` + `@Component({ selector: 'sf-send-back-modal', ... }) export class SendBackModal { ... }`
3. `/** Confirmation for a recovery action whose blast radius must be read first. */` + `@Component({ selector: 'sf-recovery-confirm', ... }) export class RecoveryConfirm { ... }`
4. `/** Pick a valid earlier runner stage, explain discarded work, then require a reason. */` + `@Component({ selector: 'sf-send-back-stage-modal', ... }) export class SendBackStageModal { ... }`
5. `/** Cancel is irreversible too — every surface confirms through this one modal. */` + `@Component({ selector: 'sf-cancel-confirm', ... }) export class CancelConfirm { ... }`

No edits inside the class blocks. Their existing `imports: [Icon]` / `imports: [FormsModule, Autofocus]` metadata now resolves against this file's header (Icon and Autofocus come from `@sf/shared`).

- [ ] **Step 4: Run the spec to verify it passes**

Run: `npx ng test console`
Expected: PASS — all `gate-modals.spec.ts` tests green (existing console specs still green).

- [ ] **Step 5: Repoint `floor-page.ts`**

Replace the `@sf/shared` import block:

```ts
// old
import {
  Api,
  ApproveModal,
  CancelConfirm,
  FactoryRequest,
  MissionGate,
  MissionOut,
  Poll,
  RecoveryConfirm,
  SendBackStageModal,
  SendBackModal,
} from '@sf/shared';
// new
import { Api, FactoryRequest, MissionGate, MissionOut, Poll } from '@sf/shared';
```

And add, in the relative-import group (directly after the `Session` import):

```ts
import {
  ApproveModal,
  CancelConfirm,
  RecoveryConfirm,
  SendBackModal,
  SendBackStageModal,
} from '../shared/gate-modals';
```

The `@Component` `imports: [...]` array is unchanged.

- [ ] **Step 6: Repoint `dossier-page.ts`**

Replace the `@sf/shared` import block:

```ts
// old
import {
  Api,
  ApproveModal,
  CancelConfirm,
  CommentItem,
  FactoryRequest,
  Poll,
  ProgressEvent,
  RecoveryConfirm,
  RequestDetail,
  SendBackModal,
  SendBackStageModal,
  clock,
  inFlight,
} from '@sf/shared';
// new
import {
  Api,
  CommentItem,
  FactoryRequest,
  Poll,
  ProgressEvent,
  RequestDetail,
  clock,
  inFlight,
} from '@sf/shared';
```

And add, in the relative-import group (directly after the `Session` import):

```ts
import {
  ApproveModal,
  CancelConfirm,
  RecoveryConfirm,
  SendBackModal,
  SendBackStageModal,
} from '../shared/gate-modals';
```

The `@Component` `imports: [...]` array is unchanged.

- [ ] **Step 7: Delete the five modal classes from `kit.ts`**

Delete the five class blocks (with their doc comments) and the `/* ---- gate UI ... ---- */` section comment from `packages/shared/src/lib/kit.ts`. Shrink its import header to exactly:

```ts
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import { TYPE_LABEL } from './util';
```

(`FormsModule`, `FactoryRequest` and `confirmSteps` left with the modals; `output` is still used by `TrackChip`, `ElementRef`/`inject`/`afterNextRender` by `Autofocus`, `DomSanitizer` by `Icon`.)

`kit.ts` now contains exactly: `Autofocus`, `Glyph`, the private `ICONS` map, `Icon`, `Mark`, `Avatar`, `Pill`, `TypeChip`, `TrackChip`, `Sig`.

- [ ] **Step 8: Confirm no app still imports a modal from `@sf/shared`**

Run:

```bash
grep -rnE "\b(ApproveModal|SendBackModal|SendBackStageModal|RecoveryConfirm|CancelConfirm)\b" \
  apps packages --include='*.ts' | grep -v node_modules | grep -v apps/console/src/app/shared
```

Expected: only the import lines and `imports:` arrays in `floor-page.ts` and `dossier-page.ts` (both resolving to `../shared/gate-modals`), nothing under `packages/`.

- [ ] **Step 9: Run the task gate**

Run: `npx ng lint shared && npx ng lint console && npx ng lint intake && task test-web && task build`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(console): move gate modals out of @sf/shared next to floor/dossier

ApproveModal, SendBackModal, SendBackStageModal, RecoveryConfirm and
CancelConfirm are console-only (grep-verified); they now live in the
console app with their first direct spec coverage (deepening candidate 2,
D9). Verbatim move — selectors, inputs and outputs unchanged.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Split the remaining `kit.ts` into focused files under `lib/kit/`

After Tasks 2–3, `kit.ts` holds only the nine true primitives. Split it one-component-per-file with a per-symbol barrel (D9). `track-chip.spec.ts` moves next to its component. `public-api.ts` still says `export * from './lib/kit'` — that specifier now resolves to `lib/kit/index.ts`, so no public-api edit happens in this task (that's Task 5).

**Files:**
- Create: `packages/shared/src/lib/kit/autofocus.ts`
- Create: `packages/shared/src/lib/kit/glyph.ts`
- Create: `packages/shared/src/lib/kit/icon.ts`
- Create: `packages/shared/src/lib/kit/mark.ts`
- Create: `packages/shared/src/lib/kit/avatar.ts`
- Create: `packages/shared/src/lib/kit/pill.ts`
- Create: `packages/shared/src/lib/kit/type-chip.ts`
- Create: `packages/shared/src/lib/kit/track-chip.ts`
- Create: `packages/shared/src/lib/kit/sig.ts`
- Create: `packages/shared/src/lib/kit/index.ts`
- Move: `packages/shared/src/lib/track-chip.spec.ts` → `packages/shared/src/lib/kit/track-chip.spec.ts`
- Delete: `packages/shared/src/lib/kit.ts`

**Interfaces:**
- Consumes: the post-Task-3 `kit.ts` (nine primitives only).
- Produces: `./lib/kit` (the barrel) re-exporting exactly `Autofocus, Glyph, Icon, Mark, Avatar, Pill, TypeChip, TrackChip, Sig` — Task 5's public-api imports from this path.

Class bodies are copied **verbatim** from `kit.ts` — the code blocks below show each complete file so nothing is left to interpretation; if a block ever disagrees with `kit.ts`, `kit.ts` (post-Task-3) wins and the deviation is logged.

- [ ] **Step 1: Create `packages/shared/src/lib/kit/autofocus.ts`**

```ts
import { Directive, ElementRef, afterNextRender, inject } from '@angular/core';

/** Reliable focus for dynamically-inserted inputs (the `autofocus` attribute only
 *  works at document parse time, not for @if-rendered overlays). */
@Directive({ selector: '[sfAutofocus]' })
export class Autofocus {
  constructor() {
    const el = inject(ElementRef);
    afterNextRender(() => el.nativeElement.focus());
  }
}
```

- [ ] **Step 2: Create `packages/shared/src/lib/kit/glyph.ts`**

Header below + the `Glyph` class copied verbatim (template with the ring/flag/dotted/check/strike branches and all `computed` geometry — `sw`, `c`, `r`, `vb`, `dash`, `rot`, `checkPath`, `strikePath`, `flagPole`, `flagBody`):

```ts
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/* ---- status-type glyph: shape carries the type, colour second ----
   dotted = Intake/early · ring = in-progress (fill = position) ·
   check = done · strike = cancelled · flag = needs-human */
```

then verbatim: `@Component({ selector: 'sf-glyph', ... }) export class Glyph { ... }`

- [ ] **Step 3: Create `packages/shared/src/lib/kit/icon.ts`**

Header below + the private `const ICONS: Record<string, string> = { ... }` map and the `Icon` class, both copied verbatim (ICONS stays module-private — do not export it):

```ts
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

/* ---- UI line icons (Lucide-spec, 1.75px, 24-grid) ---- */
```

then verbatim: `const ICONS ... ;` and `@Component({ selector: 'sf-icon', ... }) export class Icon { ... }`

- [ ] **Step 4: Create `packages/shared/src/lib/kit/mark.ts`**

Header below + the `Mark` class (the Stacked-S brand mark) copied verbatim including the `/** "Stacked S" brand mark ... */` doc comment between the decorator and the class:

```ts
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/* ---- the factory mark — micron-dot square (nods to wafer motif) ---- */
```

then verbatim: `@Component({ selector: 'sf-mark', ... }) /** "Stacked S" brand mark: ... */ export class Mark { ... }`

- [ ] **Step 5: Create `packages/shared/src/lib/kit/avatar.ts`**

```ts
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'sf-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="avatar" [class.sm]="sm()" [class.lg]="lg()" [style.background]="color()"
    ><ng-content
  /></span>`,
})
export class Avatar {
  color = input<string>('var(--avatar)');
  sm = input<boolean>(false);
  lg = input<boolean>(false);
}
```

- [ ] **Step 6: Create `packages/shared/src/lib/kit/pill.ts`**

Header below + the `Pill` class copied verbatim:

```ts
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { Glyph } from './glyph';
```

then verbatim: `@Component({ selector: 'sf-pill', imports: [Glyph], ... }) export class Pill { ... }`

- [ ] **Step 7: Create `packages/shared/src/lib/kit/type-chip.ts`**

Header below + the `TypeChip` class copied verbatim:

```ts
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { TYPE_LABEL } from '../util';
import { Icon } from './icon';
```

then verbatim: `@Component({ selector: 'sf-type-chip', imports: [Icon], ... }) export class TypeChip { ... }`

- [ ] **Step 8: Create `packages/shared/src/lib/kit/track-chip.ts`**

Header below + the `TrackChip` class copied verbatim (including its `styles` block with the pulse animation and reduced-motion override):

```ts
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { TYPE_LABEL } from '../util';
import { Icon } from './icon';
```

then verbatim: `@Component({ selector: 'sf-track-chip', imports: [Icon], ... }) export class TrackChip { ... }`

- [ ] **Step 9: Create `packages/shared/src/lib/kit/sig.ts`**

Header below + the `Sig` class copied verbatim:

```ts
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { Glyph } from './glyph';

/* signal badge — the loud gate / needs-human marker */
```

then verbatim: `@Component({ selector: 'sf-sig', imports: [Glyph], ... }) export class Sig { ... }`

- [ ] **Step 10: Create the barrel `packages/shared/src/lib/kit/index.ts`**

```ts
/* @sf/shared UI kit — true both-app primitives only (deepening candidate 2, D9).
   Domain components live with their app; this barrel is the kit's whole surface. */
export { Autofocus } from './autofocus';
export { Avatar } from './avatar';
export { Glyph } from './glyph';
export { Icon } from './icon';
export { Mark } from './mark';
export { Pill } from './pill';
export { Sig } from './sig';
export { TrackChip } from './track-chip';
export { TypeChip } from './type-chip';
```

- [ ] **Step 11: Move the TrackChip spec next to its component**

```bash
git mv packages/shared/src/lib/track-chip.spec.ts packages/shared/src/lib/kit/track-chip.spec.ts
```

Then update its import:

```ts
// old
import { TrackChip } from './kit';
// new
import { TrackChip } from './track-chip';
```

- [ ] **Step 12: Delete the old monolith**

```bash
git rm packages/shared/src/lib/kit.ts
```

`public-api.ts`'s `export * from './lib/kit'` now resolves to `lib/kit/index.ts` — same specifier, no edit.

- [ ] **Step 13: Run the task gate**

Run: `npx ng lint shared && npx ng lint console && npx ng lint intake && task test-web && task build`
Expected: all green — both apps' imports go through `@sf/shared`, whose surface is unchanged.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "refactor(shared): split kit.ts into focused files under lib/kit/

One primitive per file plus a per-symbol barrel; track-chip.spec moves next
to its component. Verbatim code moves — no behavioral change (deepening
candidate 2, D9).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Per-symbol `public-api.ts` + surface contract test

D10: no `export *`. First a characterization spec locks today's runtime surface (36 value exports), then the rewrite must keep it green. Ends with the full `task verify`.

**Files:**
- Test (create): `packages/shared/src/lib/public-surface.spec.ts`
- Modify: `packages/shared/src/public-api.ts`

**Interfaces:**
- Consumes: `./lib/kit` barrel from Task 4; the untouched `models` / `util` / service modules.
- Produces: the final `@sf/shared` contract — 36 value exports + 31 type exports, enumerated below. Both apps keep importing the same names from `@sf/shared`.

- [ ] **Step 1: Write the surface contract spec**

Create `packages/shared/src/lib/public-surface.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';

import * as surface from '../public-api';

/** The deliberate runtime surface of @sf/shared. Type exports are enforced by
 *  the compiler; this locks the VALUE exports so a stray `export *` or leaked
 *  helper can't silently widen the contract the shared-gate CI defends. */
const VALUE_EXPORTS = [
  // services
  'Api',
  'Poll',
  'Theme',
  // UI kit primitives
  'Autofocus',
  'Avatar',
  'Glyph',
  'Icon',
  'Mark',
  'Pill',
  'Sig',
  'TrackChip',
  'TypeChip',
  // label tables
  'STAGE_LABEL',
  'TYPE_LABEL',
  'TYPE_SHORT',
  // pure helpers
  'adminStateLine',
  'boardGlyph',
  'clock',
  'confirmSteps',
  'elapsedShort',
  'evidenceBits',
  'gateLabel',
  'groupTrace',
  'healthLine',
  'inFlight',
  'liveStatus',
  'loadStoredUser',
  'missionRowLabel',
  'missionSubtitle',
  'missionSummary',
  'plainActivity',
  'plainStage',
  'prototypeSrcdoc',
  'streamState',
  'timeAgo',
  'utc',
];

describe('@sf/shared public surface', () => {
  it('exports exactly the agreed value symbols', () => {
    expect(Object.keys(surface).sort()).toEqual([...VALUE_EXPORTS].sort());
  });

  it('every agreed symbol is defined', () => {
    for (const name of VALUE_EXPORTS) {
      expect(surface[name as keyof typeof surface], name).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run it against the current `export *` surface**

Run: `npx ng test shared`
Expected: PASS — after Tasks 2–4 the wildcard surface already equals this list. **If it fails, the consumer map is wrong: reconcile the list against the actual diff (do not just edit the list to match), log the finding in `implementation-notes.md`, and only then proceed.**

- [ ] **Step 3: Rewrite `packages/shared/src/public-api.ts` (complete replacement)**

`isolatedModules` is on, so interfaces/type aliases must use `export type`:

```ts
/*
 * Public API Surface of @sf/shared.
 *
 * Per-symbol exports — no `export *` (deepening candidate 2, D10). Every name
 * below is a deliberate, grep-able contract with the intake and console apps;
 * adding one widens the surface the shared-gate CI (ADR 0017) defends, so do
 * it consciously. lib/public-surface.spec.ts locks the value surface.
 */

// ---- domain models (types only) ----
export type {
  AppEntry,
  AppSubscription,
  Attachment,
  AuditItem,
  ClassifyResult,
  CommentItem,
  Evidence,
  FactoryRequest,
  InterviewState,
  MissionGate,
  MissionHumanOwned,
  MissionOut,
  MissionRecent,
  MissionRun,
  Operator,
  ProgressEvent,
  PrototypeAnnotation,
  PrototypeState,
  PrototypeTurn,
  RequestDetail,
  ReviewSummary,
  RunState,
  SpecLine,
  SpecSection,
  SteerState,
  Turn,
  User,
} from './lib/models';

// ---- label tables + pure helpers ----
export {
  STAGE_LABEL,
  TYPE_LABEL,
  TYPE_SHORT,
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
  loadStoredUser,
  missionRowLabel,
  missionSubtitle,
  missionSummary,
  plainActivity,
  plainStage,
  prototypeSrcdoc,
  streamState,
  timeAgo,
  utc,
} from './lib/util';
export type { EvidenceBit, TraceGroup, TraceRow } from './lib/util';

// ---- services ----
export { Api } from './lib/api.service';
export { Poll } from './lib/poll.service';
export { Theme } from './lib/theme.service';
export type { ThemeChoice } from './lib/theme.service';

// ---- UI kit primitives ----
export {
  Autofocus,
  Avatar,
  Glyph,
  Icon,
  Mark,
  Pill,
  Sig,
  TrackChip,
  TypeChip,
} from './lib/kit';
```

- [ ] **Step 4: Run the surface spec again**

Run: `npx ng test shared`
Expected: PASS — identical surface, now spelled out.

- [ ] **Step 5: Run the task gate, then the FULL verify**

Run: `npx ng lint shared && npx ng lint console && npx ng lint intake && task test-web && task build`
Expected: all green.

Run: `task verify`
Expected: `✓ VERIFY PASSED — tests, build, and smoke all green` (lint + pytest + vitest ×3 + build ×2 + smoke).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(shared): per-symbol public API exports + surface contract test

public-api.ts now enumerates every exported symbol (no export *, design
D10); lib/public-surface.spec.ts locks the 36-value runtime surface so it
can't silently widen (deepening candidate 2).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Done means

- `packages/shared/src/lib/kit.ts` no longer exists; `lib/kit/` holds nine one-primitive files + a per-symbol barrel.
- `apps/console/src/app/shared/` holds `action-outcome.ts` and `gate-modals.ts` (with spec); no console file reaches into `../floor/` for shared vocabulary.
- `EscalationBox`, `PopMenu`, `SpecLines`, `InterviewAnswers`, `EvidenceStrip` are gone.
- `public-api.ts` has zero `export *` lines and `public-surface.spec.ts` guards the value surface.
- `.github/workflows/shared-gate.yml` byte-identical to main.
- `task verify` fully green on branch `kit-split`; branch NOT merged, NOT pushed — merge is the owner's call per the repo workflow.
