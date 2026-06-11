# Plan 002: Unit-test the three core web services (poll, session, intake-draft)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 76bb314..HEAD -- web/src/app/core/poll.service.ts web/src/app/core/session.service.ts web/src/app/submitter/intake-draft.service.ts`
> If any in-scope source file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
> Note: planned against commit `76bb314` **plus uncommitted working-tree
> changes**; `intake-draft.service.ts` was part of those changes (it gained
> `reach`, `reachText`, `impactMetric`, `impactValue` fields). The excerpt
> below reflects the working tree. If those changes were committed since,
> the drift diff will show them — that alone is NOT a stop condition as long
> as the excerpt still matches the live file.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `76bb314`, 2026-06-11

## Why this matters

The web app has exactly one spec file (`web/src/app/core/util.spec.ts`, 14
tests of pure functions). The three stateful services that everything else
depends on have zero tests: `Poll` drives every live admin view (a broken
in-flight guard would turn a stalled backend into a request burst; a broken
cursor would replay or drop events), `Session` gates the admin role via a
localStorage round-trip with shape validation, and `IntakeDraft` implements
the persist-first POST→PATCH contract for the whole submitter flow. Any
refactor of these is currently flying blind. These tests are also the safety
net for plans 004 (pop-menu refactor) and any future polling change.

## Current state

- `web/src/app/core/poll.service.ts` — the keyset-cursor poll loop. Key
  behaviors to pin (read the whole file before writing tests):

  ```ts
  // poll.service.ts (abridged, working tree at 76bb314)
  start(intervalMs = 4000) {
    if (this.timer) return;
    this.api.eventsCursor().subscribe({
      next: (c) => { this.cursor = c.cursor; this.version.update((v) => v + 1); this.lastSync.set(Date.now()); },
      error: () => this.version.update((v) => v + 1),
    });
    this.zone.runOutsideAngular(() => { this.timer = setInterval(() => this.tickOnce(), intervalMs); });
  }
  private tickOnce() {
    if (this.inFlight) return; // a stalled backend must not queue a refetch burst
    this.inFlight = true;
    this.api.events({ after: this.cursor }).subscribe({
      next: (evs) => { this.inFlight = false;
        if (evs.length) { this.cursor = evs[evs.length - 1].id; /* zone.run: delta.set(evs); version++ ; lastSync */ }
        else { /* zone.run: lastSync only */ } },
      error: () => { this.inFlight = false; },
    });
  }
  ```

- `web/src/app/core/session.service.ts` — `load()` parses `localStorage`
  key `sf-user`, validates shape (`name`/`initials`/`color` strings, `role`
  is `'submitter' | 'admin'`), removes invalid blobs, falls back to the
  `SUBMITTER` constant. `signIn(role)` persists. Note: `Session` has **no
  injected dependencies** — `new Session()` works without TestBed.

- `web/src/app/submitter/intake-draft.service.ts` — persist-first store.
  Key behavior:

  ```ts
  // intake-draft.service.ts (abridged, working tree)
  async save(): Promise<number> {
    const body = { ..., app_id: this.type === 'bug' || this.type === 'enh' ? this.appId : null,
      reach: this.type === 'bug' ? null : this.reachText.trim() || this.reach,
      impact_metric: this.type !== 'bug' && this.impactMetric && this.impactValue.trim() ? this.impactMetric : null,
      impact_value: ... same condition ... };
    if (this.requestId == null) { const r = await firstValueFrom(this.api.createRequest(body)); this.requestId = r.id; }
    else { await firstValueFrom(this.api.updateRequest(this.requestId, body)); }
    return this.requestId!;
  }
  ```

- `web/src/app/core/api.service.ts` — the `Api` surface the mocks must
  match: `eventsCursor(): Observable<{cursor:number}>`,
  `events(opts): Observable<ProgressEvent[]>`, `createRequest(body)`,
  `updateRequest(id, body)`, `apps()`. All plain `HttpClient` wrappers.

- Test infrastructure: vitest via `npx ng test` (Angular 22 unit-test
  builder, jsdom environment — `jsdom` is in devDependencies). Spec files
  are discovered as `web/src/**/*.spec.ts`. Exemplar for imports/structure:
  `web/src/app/core/util.spec.ts` (`import { describe, expect, it } from 'vitest';`).
  For injected services use Angular's TestBed:
  `import { TestBed } from '@angular/core/testing';`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Web tests | `cd web && npx ng test` | all pass (14 existing + your new ones) |
| Web build | `cd web && npx ng build` | exit 0 |

## Scope

**In scope** (create only; modify nothing else):
- `web/src/app/core/poll.service.spec.ts` (create)
- `web/src/app/core/session.service.spec.ts` (create)
- `web/src/app/submitter/intake-draft.service.spec.ts` (create)

**Out of scope** (do NOT touch):
- The three services under test — if a behavior seems wrong, write the test
  that documents the CURRENT behavior and flag it in your report. This plan
  is characterization, not fixing.
- `web/src/app/core/api.service.ts`, components, vitest/angular config.

## Git workflow

- Branch: `advisor/002-web-service-tests`
- One commit per spec file is fine; message style: short imperative title
  (see `git log --oneline`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: `session.service.spec.ts`

`Session` needs no TestBed. Skeleton:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, SUBMITTER, Session } from './session.service';

describe('Session', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a signed-in user through localStorage', () => {
    new Session().signIn('admin');
    expect(new Session().user().role).toBe('admin');
  });
  it('falls back to SUBMITTER on malformed JSON', () => {
    localStorage.setItem('sf-user', '{not json');
    expect(new Session().user()).toEqual(SUBMITTER);
  });
  it('discards a wrong-shape blob and removes it', () => {
    localStorage.setItem('sf-user', JSON.stringify({ name: 'X' }));
    expect(new Session().user()).toEqual(SUBMITTER);
    expect(localStorage.getItem('sf-user')).toBeNull();
  });
  it('rejects an unknown role', () => {
    localStorage.setItem('sf-user', JSON.stringify({ ...ADMIN, role: 'root' }));
    expect(new Session().user()).toEqual(SUBMITTER);
  });
});
```

**Verify**: `cd web && npx ng test` → all pass, ≥4 new tests.

### Step 2: `poll.service.spec.ts`

Use TestBed with a mocked `Api` and rxjs `Subject`s so you control emission
timing (that's how you test the in-flight guard). Use vitest fake timers for
the interval. Skeleton:

```ts
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api } from './api.service';
import { Poll } from './poll.service';

function ev(id: number) { return { id } as any; }

describe('Poll', () => {
  let api: { eventsCursor: ReturnType<typeof vi.fn>; events: ReturnType<typeof vi.fn> };
  let poll: Poll;

  beforeEach(() => {
    vi.useFakeTimers();
    api = { eventsCursor: vi.fn(() => of({ cursor: 100 })), events: vi.fn(() => of([])) };
    TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: api }] });
    poll = TestBed.inject(Poll);
  });
  afterEach(() => { poll.ngOnDestroy(); vi.useRealTimers(); });

  it('seeds the cursor from the tail and bumps version once', () => {
    poll.start(1000);
    expect(api.eventsCursor).toHaveBeenCalledOnce();
    expect(poll.version()).toBe(1);
  });
  it('advances the cursor and publishes the delta on new events', () => {
    api.events.mockReturnValue(of([ev(101), ev(102)]));
    poll.start(1000);
    vi.advanceTimersByTime(1000);
    expect(api.events).toHaveBeenCalledWith({ after: 100 });
    expect(poll.delta()).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(api.events).toHaveBeenLastCalledWith({ after: 102 });
  });
  it('in-flight guard: a slow response suppresses the next tick', () => {
    const slow = new Subject<any[]>();
    api.events.mockReturnValue(slow.asObservable());
    poll.start(1000);
    vi.advanceTimersByTime(3000);            // 3 ticks while the first hangs
    expect(api.events).toHaveBeenCalledOnce(); // no refetch burst
    slow.next([ev(101)]); slow.complete();
    vi.advanceTimersByTime(1000);
    expect(api.events).toHaveBeenCalledTimes(2);
  });
  it('an errored tick keeps the cursor and retries next tick', () => { /* error response, then assert next call still uses after:100 and version unchanged */ });
  it('empty poll bumps lastSync but not version', () => { /* of([]) → version stays at 1 */ });
  it('start() is idempotent', () => { poll.start(1000); poll.start(1000); expect(api.eventsCursor).toHaveBeenCalledOnce(); });
});
```

Fill in the two stubbed tests. Note `NgZone.runOutsideAngular` works fine in
TestBed without extra setup.

**Verify**: `cd web && npx ng test` → all pass, ≥6 new Poll tests.

### Step 3: `intake-draft.service.spec.ts`

TestBed with mocked `Api`. `IntakeDraft` also injects `Session` — provide the
real one (it has no deps) or a stub with `user()` returning a user object
(check the `save()` body for which fields it reads: `u.name`, `u.initials`).
Cases to cover:

1. First `save()` calls `createRequest` once and stores `requestId` from the
   response; second `save()` calls `updateRequest` with that id and does NOT
   call `createRequest` again.
2. `type='bug'` → body has `reach: null`, `impact_metric: null`,
   `impact_value: null` even when the draft fields are set.
3. Free-text reach wins over the chip: `reach='team'`, `reachText='all of
   Penang'` → body `reach === 'all of Penang'`.
4. Impact only sent complete: `impactMetric='hours'`, `impactValue=''` →
   both `impact_metric` and `impact_value` are null in the body.
5. A failed `createRequest` (use `throwError(() => new Error('boom'))`)
   rejects `save()` and leaves `requestId` null, so a retry POSTs again.
6. `reset()` clears every field back to initial state (assert at least
   `requestId`, `type`, `reach`, `reachText`, `impactMetric`, `impactValue`,
   `urgency`).

Assert request bodies via `api.createRequest.mock.calls[0][0]`.

**Verify**: `cd web && npx ng test` → all pass, ≥6 new IntakeDraft tests.

## Test plan

This plan IS the test plan. Structural pattern: `web/src/app/core/util.spec.ts`
for imports and naming; describe-per-service, it-per-behavior, behavior-named
test titles (the repo style is sentence-like titles, e.g. "re-tags naive
SQLite timestamps as UTC").

## Done criteria

- [ ] `cd web && npx ng test` exits 0 with ≥ 30 total tests (14 existing + ≥16 new)
- [ ] All three spec files exist at the paths in Scope
- [ ] No source file modified: `git status` shows only the three new spec files (plus plans/README.md)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- TestBed + vitest fake timers fundamentally don't cooperate with
  `NgZone.runOutsideAngular` in this setup (symptom: ticks never fire even
  with `advanceTimersByTime`) after one focused attempt to fix — report the
  symptom rather than rewriting the service to be "more testable".
- The Api surface doesn't match the mock shapes above (drift).
- Any test requires modifying a service under test to pass.

## Maintenance notes

- These are characterization tests: if plan 001/004 or later work changes
  polling or draft behavior intentionally, update the corresponding test in
  the same commit — these specs exist precisely to force that conversation.
- Future: when SSE replaces polling (ADR 0007 "polling now, SSE later"), the
  Poll spec is the contract for what the SSE client must preserve (cursor
  continuity, no-burst, delta semantics).
