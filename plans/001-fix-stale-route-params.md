# Plan 001: Make admin issue and channel-feed views react to route param changes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 76bb314..HEAD -- web/src/app/admin/issue.ts web/src/app/admin/feed.ts`
> If either file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
> Note: this plan was written against commit `76bb314` **plus uncommitted
> working-tree changes** (an intake reach/impact feature in the submitter and
> api). Neither in-scope file was part of those changes; excerpts here match
> the working tree as planned.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `76bb314`, 2026-06-11

## Why this matters

The admin issue page reads its `:id` route param **once**, at component
construction. Angular's default route-reuse strategy keeps the same component
instance when only the param changes, so navigating from issue A directly to
issue B (which the ⌘K command palette, the approval queue's "Compare" button
for duplicates, and board/pipeline links all do) leaves the component fetching
and displaying **issue A's data while the URL says issue B**. This is the
screen where approval decisions are made — showing the wrong request is the
worst kind of bug for it. The channel feed has the identical defect with its
`:key` param, and the sidebar channel rail makes feed→feed navigation the
primary way that view is used.

## Current state

- `web/src/app/admin/issue.ts` — full-screen issue view. The bug:

  ```ts
  // issue.ts:247
  id = Number(inject(ActivatedRoute).snapshot.paramMap.get('id'));
  ...
  // issue.ts:261-266 (constructor)
  constructor() {
    effect(() => {
      this.poll.version();
      this.api.request(this.id).subscribe((r) => this.d.set(r));
    });
  }
  ```

  `snapshot.paramMap` is read once; the effect re-runs on poll ticks but
  always with the stale `this.id`.

- `web/src/app/admin/feed.ts` — per-app channel feed. Same pattern:

  ```ts
  // feed.ts:160
  key = inject(ActivatedRoute).snapshot.paramMap.get('key')!;
  ```

- Navigation paths that re-enter the same route with a different param
  (evidence this is reachable):
  - `web/src/app/admin/admin-shell.ts:302` — command palette opens `/admin/issue/${r.id}` (works from anywhere, including another issue).
  - `web/src/app/admin/queue.ts:84` — duplicate hint "Compare" button: `openIssue(r.duplicate.id)` can be clicked while routed to a different issue.
  - `web/src/app/admin/admin-shell.ts:61` — channel rail: `(click)="go('/admin/apps/' + a.key)"` switches feed→feed.

- Repo conventions: Angular 22 standalone components, signals everywhere,
  inline templates. Reactive interop helpers (`toSignal`) come from
  `@angular/core/rxjs-interop` (already an Angular core secondary entry
  point — no new dependency). Look at `web/src/app/admin/issue.ts` itself
  for the signal style used across the repo.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Web build | `cd web && npx ng build` | "Application bundle generation complete", exit 0 |
| Web tests | `cd web && npx ng test` | all tests pass |
| Dev servers | `make dev WEB_PORT=4300` (from repo root) | API :8000, web :4300 |

## Scope

**In scope** (the only files you should modify):
- `web/src/app/admin/issue.ts`
- `web/src/app/admin/feed.ts`

**Out of scope** (do NOT touch, even though they look related):
- `web/src/app/submitter/request-detail.ts`, `review.ts`, `interview.ts`,
  `confirm.ts` — they use the same `snapshot.paramMap` pattern, but the
  submitter flow has no same-route renavigation path (you always pass through
  a different route first, which destroys the component). Converting them is
  churn without a reachable bug.
- `web/src/app/core/poll.service.ts` — the poll/version mechanism is correct;
  do not change it.
- Router configuration (`app.routes.ts`) — do not add
  `runGuardsAndResolvers` or custom route reuse strategies; fix the
  components.

## Git workflow

- Branch: `advisor/001-stale-route-params`
- Commit message style: short imperative title, matching e.g.
  `Fix: UTC re-tagging for SQLite-naive timestamps` from `git log`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make `id` reactive in issue.ts

In `web/src/app/admin/issue.ts`:

1. Add imports: `toSignal` from `@angular/core/rxjs-interop`, `map` from `rxjs`.
2. Replace the snapshot read with a signal:

   ```ts
   private route = inject(ActivatedRoute);
   id = toSignal(this.route.paramMap.pipe(map((p) => Number(p.get('id')))), {
     initialValue: Number(inject(ActivatedRoute).snapshot.paramMap.get('id')),
   });
   ```

   (Keep one injected `ActivatedRoute`; the snippet shows intent, not exact
   layout — `initialValue` can read `this.route.snapshot` if you order the
   fields so `route` is initialized first.)
3. Update the constructor effect so a param change clears stale data before
   the refetch, while a plain poll tick does not flash:

   ```ts
   constructor() {
     let lastId: number | null = null;
     effect(() => {
       const id = this.id();
       this.poll.version();
       if (id !== lastId) {
         lastId = id;
         this.d.set(null);          // do not show the previous issue while loading
       }
       this.api.request(id).subscribe((r) => this.d.set(r));
     });
   }
   ```

4. Find every other read of `this.id` in this file (template included) —
   `grep -n "this.id\b\|\bid\b" web/src/app/admin/issue.ts` — and convert
   value reads to `this.id()`. Template references to `id` become `id()`.

**Verify**: `cd web && npx ng build` → exit 0, no template/type errors.

### Step 2: Make `key` reactive in feed.ts

In `web/src/app/admin/feed.ts`, apply the same conversion to `key`
(`feed.ts:160`):

1. `key = toSignal(route.paramMap.pipe(map((p) => p.get('key')!)), { initialValue: ... })`.
2. Run `grep -n "this.key\|\bkey\b" web/src/app/admin/feed.ts` and inspect
   each hit. Any data loading that currently happens once in the constructor
   or in field initializers using `key` must move into (or be triggered by)
   an `effect()` that reads `this.key()`, so switching channels reloads the
   feed and resets per-channel state (cursor, messages list, composer text —
   whatever the component holds per channel; reset all of it on key change
   using the same `lastKey` pattern as Step 1).

**Verify**: `cd web && npx ng build` → exit 0.

### Step 3: Manual behavior check in the running app

1. `make dev WEB_PORT=4300` from the repo root (port 4200 is often taken on
   this machine).
2. Open http://localhost:4300/login → "Sign in as a reviewer".
3. Open any issue from the board (`G B`, click a card's full view). Note its
   REQ ref in the header.
4. Press `⌘K`, type another request's title, open it. **Expected**: the
   header ref, title, and activity all switch to the second issue (before
   this fix the first issue's data stayed).
5. In the sidebar channel rail, click one app channel, then another.
   **Expected**: the feed header and messages switch to the second channel.

**Verify**: both expected behaviors observed; no console errors in the
browser devtools console.

## Test plan

This repo has no component-level web tests (see plans/002). Do not introduce
a component test harness in this plan. Coverage here is the manual check in
Step 3 plus the build. If plan 002 has already landed when you execute this,
note in your report whether a regression test for "param change refetches"
could be added to the service specs — do not write it here.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd web && npx ng build` exits 0
- [ ] `cd web && npx ng test` exits 0
- [ ] `grep -n "snapshot.paramMap" web/src/app/admin/issue.ts web/src/app/admin/feed.ts` returns no matches (or only inside an `initialValue` expression)
- [ ] Manual check in Step 3 passed (state which navigation paths you exercised)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts above don't match the live code (drift).
- `feed.ts` turns out to hold per-channel state in a service shared across
  channels (not in the component) — resetting it needs a design decision.
- Converting `id`/`key` to signals forces changes in files outside the
  in-scope list.
- The manual check still shows stale data after the fix (the route-reuse
  assumption would then be wrong and the diagnosis needs revisiting).

## Maintenance notes

- Any new admin view that takes a route param and can be re-entered from the
  command palette must use the same `toSignal(paramMap)` pattern — the
  palette makes every param-routed view same-route renavigable.
- Reviewer should scrutinize: that `d.set(null)` only fires on id change,
  not on every poll tick (otherwise the issue view flashes every 4s).
