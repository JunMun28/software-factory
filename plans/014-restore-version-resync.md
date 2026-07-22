# Plan 014: Make "restore version" actually change the live cloud preview

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5b9facb..HEAD -- app-preview/orchestrator/src/chat-store.ts app-preview/orchestrator/src/factory.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/012-appview-into-verify-and-ci.md` (soft — 012 makes
  the orchestrator suite run in CI; you can execute this plan without it by
  running `npm test` by hand)
- **Category**: bug
- **Planned at**: commit `5b9facb`, 2026-07-21

## Why this matters

In cloud mode (`APPVIEW_SANDBOX=kube`) each chat's live preview is a pod
running a dev server that holds **its own git clone** of the workspace. It only
picks up new code when the orchestrator explicitly pokes it — a `resync`, which
triggers an in-pod `git fetch` + `reset --hard`.

The orchestrator pokes it after a green turn. It does **not** poke it after a
version restore. So a user clicks "restore v3", the API returns 201, the
version list updates to show the restore — and the preview keeps serving the
newest code. The UI and the running app disagree, with no error anywhere.

This works correctly in local mode, where the dev server watches the workspace
directory directly and picks the change up on its own. That asymmetry is
exactly why the hand-proof on the kind cluster (2026-07-21) missed it: the live
run only exercised the green-turn path.

## Current state

All paths are under `app-preview/orchestrator/`.

### The hook exists and has exactly one caller

`src/chat-store.ts:90` declares it:

```ts
  onVersionCreated?: (chatId: string, sha: string) => void;
```

`grep -rn "onVersionCreated" src/` returns exactly three lines: that
declaration, one call, and the factory wiring. The one call is inside
`runTurn`, in the `version-created` branch (`src/chat-store.ts:762-775`):

```ts
        if (event.type === 'version-created') {
          const { diffStat, files } = await this.computeVersionDiff(
            chat.workspaceDir,
            event.commit,
          );
          await this.db.insertVersion(
            chatId,
            generationId,
            event.commit,
            event.message,
            null,
            diffStat,
            files,
          );
          // A live sandbox tracks the work branch: poke it to the new commit so
          // the preview reflects this turn. Fire-and-forget; never fail the turn.
          this.onVersionCreated?.(chatId, event.commit);
        }
```

The wiring, `src/factory.ts:90-94`:

```ts
  // A green turn writes a new Version; point any live sandbox at it (no-op for
  // the local dev server, which already watches the workspace directory).
  chatStore.onVersionCreated = (chatId, sha) => {
    void previewManager.resync(chatId, sha);
  };
```

### `restoreVersion` cuts a commit and stops there

`src/chat-store.ts:418-449`:

```ts
  async restoreVersion(
    chatId: string,
    versionId: string,
  ): Promise<VersionDetails> {
    const chat = await this.requireIdleChat(chatId);
    const source = await this.db.getVersion(chatId, versionId);
    if (!source) {
      throw new VersionNotFoundError(versionId);
    }

    await gitRestoreToCommit(chat.workspaceDir, source.manifestRef);
    const message = `Restore v${source.seq}`;
    const commit = await gitCommit(chat.workspaceDir, message, {
      allowEmpty: true,
    });
    const { diffStat, files } = await this.computeVersionDiff(
      chat.workspaceDir,
      commit,
    );
    const version = await this.db.insertVersion(
      chatId,
      null,
      commit,
      message,
      source.id,
      diffStat,
      files,
    );
    await this.db.touchChat(chatId);
    await chat.session?.dispose();
    chat.session = null;
    return toVersionDetails(version);
  }
```

`commit` is the new workspace HEAD. Nothing tells the sandbox about it.

The HTTP route is `src/http/app.ts:176`:
`app.post('/chats/:chatId/versions/:versionId/restore', …)`.

### Why `forkVersion` is NOT affected

`forkVersion` (`src/chat-store.ts:451` onwards) creates a **new chat** with a
`randomUUID()` id and a fresh workspace. A brand-new chat has no preview record
and no sandbox, so there is nothing to resync. Leave it alone.

### Conventions to match

- `src/preview-manager.ts:239-258` — `resync()` is documented as safe to call
  with no live sandbox (it early-returns) and as never throwing. That is what
  makes a fire-and-forget call at the call site correct.
- Comments here explain **why**, densely. Match the existing hook's comment
  style.
- **Test exemplar**: `test/version-chat-lifecycle.test.ts` already tests
  restore — see the test at line 124, *"lists database versions and restore
  appends a provenance-linked commit with the source tree"*, which drives the
  real HTTP route via `context.app.request(…/restore, { method: 'POST' })`.
  Its `makeContext()` helper builds a real `ChatStore` + `PlatformDb` +
  `PreviewManager` over a temp dir and the `fixtures/template` workspace.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `cd app-preview/orchestrator && npm ci` | exit 0 |
| Tests | `cd app-preview/orchestrator && npm test` | exit 0, all pass |
| One file | `cd app-preview/orchestrator && npx vitest run test/version-chat-lifecycle.test.ts` | exit 0 |
| Typecheck | `cd app-preview/orchestrator && npm run typecheck` | exit 0, no output |

## Scope

**In scope** (the only files you should modify):
- `app-preview/orchestrator/src/chat-store.ts`
- `app-preview/orchestrator/test/version-chat-lifecycle.test.ts` (add a test)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):
- `src/factory.ts` — the wiring is already correct and needs no change. This
  plan adds a *caller* of an existing hook, not a new hook.
- `forkVersion` — see above; a forked chat has no sandbox.
- `src/preview-manager.ts` and `src/kube-sandbox.ts` — `resync` already works;
  it was proven live on the cluster on 2026-07-21.
- The seed/import path (`seedChat` or equivalent). If you find it also writes a
  version without poking the sandbox, **report it — do not fix it here.** It
  has a different lifecycle (the sandbox usually does not exist yet at seed
  time) and deserves its own reasoning.
- **The working tree has uncommitted changes from other work** (files under
  `apps/intake/`, `mockups/`, `plans/009`–`011`). Do not stage or commit them.

## Git workflow

- Branch: `advisor/014-restore-resync`
- Conventional commits, e.g.
  `fix(appview): resync the sandbox after a version restore`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing test

In `test/version-chat-lifecycle.test.ts`, add a test that asserts the hook
fires on restore. The cleanest way, given `makeContext()` builds the store
directly, is to set the hook on the context's `chatStore` and record calls —
this is the same contract `factory.ts` wires in production:

```ts
  it('pokes a live sandbox to the restored commit (cloud previews hold their own clone)', async () => {
    const context = await makeContext();
    const chatId = await createChat(context);
    // …commit two versions using the file's existing commitVersion() helper…

    const resyncs: Array<{ chatId: string; sha: string }> = [];
    context.chatStore.onVersionCreated = (id, sha) => {
      resyncs.push({ chatId: id, sha });
    };

    const before = /* …list versions via the app, as the existing restore test does… */;
    const response = await context.app.request(
      `/chats/${chatId}/versions/${before[0]!.id}/restore`,
      { method: 'POST' },
    );
    expect(response.status).toBe(201);
    const restored = (await response.json()) as VersionJson;

    expect(resyncs).toHaveLength(1);
    expect(resyncs[0]).toMatchObject({ chatId, sha: restored.commit });
  });
```

Reuse the existing helpers in that file (`createChat`, `commitVersion`, and
whatever it uses to list versions) rather than writing new ones — copy the
setup from the restore test at line 124. Confirm the expected response status
against that existing test rather than trusting the `201` above.

**Verify**: `npx vitest run test/version-chat-lifecycle.test.ts` → the new test
FAILS with `resyncs` length 0. Every other test in the file still passes.

### Step 2: Fire the hook from `restoreVersion`

In `src/chat-store.ts`, in `restoreVersion`, after `insertVersion` and before
the return. Place it next to the other post-insert bookkeeping:

```ts
    await this.db.touchChat(chatId);
    // A cloud sandbox holds its OWN clone and only moves when poked — the same
    // reason runTurn fires this. Without it a restore changes the version list
    // and the workspace but the live preview keeps serving the pre-restore
    // code (invisible locally, where the dev server watches the directory).
    this.onVersionCreated?.(chatId, commit);
    await chat.session?.dispose();
    chat.session = null;
    return toVersionDetails(version);
```

Use `commit` (the new HEAD written by `gitCommit`), **not** `source.manifestRef`
— the sandbox must land on the newly-cut restore commit, which is what the work
branch now points at. Getting this wrong would reset the pod to a detached
older commit and diverge it from the orchestrator's branch.

Keep it a plain call, not awaited: the hook's production implementation is
`void previewManager.resync(...)`, which is deliberately fire-and-forget and
never throws. A restore must not fail because a pod is slow.

**Verify**: `npx vitest run test/version-chat-lifecycle.test.ts` → the new test
PASSES; the rest of the file still passes.

### Step 3: Full suite and typecheck

**Verify**:
- `npm test` → whole orchestrator suite green.
- `npm run typecheck` → exits 0.

### Step 4: Update the index

Add this plan's row to `plans/README.md`.

**Verify**: `grep -n "014" plans/README.md` shows your row.

## Test plan

- **New test**, in `test/version-chat-lifecycle.test.ts`: restore fires
  `onVersionCreated` exactly once, with the chat id and the **new** restore
  commit sha (not the source version's sha).
- **Structural pattern**: the existing restore test in the same file (line 124,
  *"lists database versions and restore appends a provenance-linked commit with
  the source tree"*).
- The test must be seen to fail before Step 2 — a test that passes beforehand
  is not exercising the hook.
- Regression guard: `npm test` proves the green-turn path
  (`runTurn` → `onVersionCreated`) still fires exactly once per version and did
  not become a double-fire.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd app-preview/orchestrator && npm test` exits 0
- [ ] `cd app-preview/orchestrator && npm run typecheck` exits 0
- [ ] `grep -c "onVersionCreated" app-preview/orchestrator/src/chat-store.ts` returns 3 (the declaration, the `runTurn` call, the new `restoreVersion` call)
- [ ] The new test exists and asserts the sha equals the **restore** commit
- [ ] `git status --porcelain` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The new test passes before you make the change in Step 2.
- `restoreVersion` in the live code does not match the "Current state" excerpt
  (in particular, if it already calls `onVersionCreated`, or if the variable
  holding the new commit is not named `commit`).
- You find that firing the hook from `restoreVersion` causes a double resync
  (e.g. because some other path already fires on the same commit) — report the
  duplicate path instead of suppressing it.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

For whoever owns this next:

- **The rule to remember**: *every* code path that moves a chat's workspace
  HEAD must fire `onVersionCreated`, because in cloud mode the preview is a
  separate clone. Today that is `runTurn` and `restoreVersion`. Any future path
  that writes a version — a revert, an undo, an imported edit landing in the
  sandbox, a blueprint apply — needs the same line. This is a good candidate
  for centralising: if a third caller appears, move the hook call inside a
  single `recordVersion()` helper that both `insertVersion` callers go through,
  so it cannot be forgotten again.
- **What a reviewer should scrutinise**: that the sha passed is the new restore
  commit, not `source.manifestRef`.
- **Related, deliberately not fixed here**: `PreviewManager.resync` swallows
  failures to `console.error` only, so a failed resync leaves the preview
  silently stale with the status still `ready`. Surfacing that (e.g. a
  `stale: true` field on the preview status the SSE stream already carries) is
  a separate improvement.
