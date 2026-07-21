# app-preview — vendored from ng-v0

The conversational editing surface for factory previews (Decision D3): a human
takes a preview, shapes it here, and sends it back through the normal gates.
This directory edits; it never ships. The factory remains the only road to
production.

## Source

| | |
|---|---|
| Repo | `github.com/JunMun28/ng-v0` |
| Commit | `f22d7e76b6f86368b254ec4502894a0a125d31ce` (`f22d7e7`) |
| Copied | 2026-07-20 |

The source tree had four uncommitted paths at copy time — `implementation-notes.md`,
`docs/parity/`, `ui/playwright-report/`, `ui/test-results/` — none of them source,
so this copy is equivalent to the commit above.

## What was copied, and what was not

Copied: `orchestrator/` and `ui/`, source only — 2.1 MB, 198 files.

Deliberately excluded:

- **`orchestrator/var/` (25 GB)** — generated chat workspaces, `platform.db` and
  its WAL. Runtime state, not source. Copying it would have consumed most of the
  free disk on this machine.
- `node_modules/` (697 MB across both), `dist/`, `.angular/`, `coverage/`,
  `playwright-report/`, `test-results/`, `suite/results/`.
- **`golden-template/`** — the factory already vendors this at `templates/golden`,
  and `implementation-notes.md` tracks every intentional delta from it. A second
  copy would drift silently against the one that is actually tracked.
- `suite/` — the prompt/eval suite; not needed for the editing surface. Pull it
  in separately if the bridge work needs it.

## Not yet wired

Nothing in the factory references this directory yet. It is a working copy for
the review-stage editing work, not an integrated app:

- `ui/` carries its own `angular.json` and is a separate Angular workspace. It is
  intentionally NOT under `apps/`, which would collide with the root workspace
  that builds `console` and `intake`.
- The bridge contract itself (seed a chat from a request ref, import the edit
  back through the preview-revision machinery) is designed but unbuilt — see
  `docs/design/ng-v0-bridge.md`, which currently lives on the
  `plan-008-scalability` worktree rather than `main`.

## Keeping it honest

This is a vendored copy, so it will drift from upstream. To see what has changed
since the copy:

```
git -C ../ng-v0 diff f22d7e7 -- orchestrator ui
```

Record intentional deltas here, the same way `implementation-notes.md` records
them for the golden template.

## Deviations

- **`dbo`, not a separate schema.** The plan was one shared database with an
  `appview` schema. On Azure SQL the Entra admin maps to `dbo`, whose default
  schema cannot be changed — so tables created while testing as admin land in
  `dbo` while the app's future service-principal user would get `appview`. Same
  code, two schemas, and the `appview` path unverifiable until that principal
  exists. Took the conservative option: `dbo`, with only the one genuinely
  generic table renamed (`migrations` -> `appview_migrations`). The factory's
  tables (`requests`, `operators`, `apps`, `progress_events`) do not collide
  with this app's (`users`, `projects`, `chats`, `generations`, `turn_events`,
  `versions`, `plans`, `blueprint_revisions`, `connections`).

- **Index key widths warn on Azure SQL.** Every id is `NVARCHAR(450)`, so three
  composite keys exceed SQL Server's declared limits: `turn_events` PK (904 vs
  900 bytes), `turn_events_chat_generation_seq_idx` (1804 vs 1700), and
  `plans_chat_created_at_idx` (1800 vs 1700). These are variable-length columns,
  so SQL Server warns at CREATE and only errors if a real row's key exceeds the
  limit. Actual values are UUIDs (~36 chars) and ISO-8601 timestamps (~32), so
  real keys land near 150 bytes. Narrowing ids to `NVARCHAR(64)` and timestamps
  to `NVARCHAR(32)` would silence it — a schema decision, deliberately not taken
  as part of a translation.

### ng-v0 bridge pieces 1 & 3 (2026-07-21)

- **Export bundle uses a throwaway branch, not the literal `git bundle create
  <file> <seedRef>..<versionSha>`.** With two raw shas the range names no ref,
  and `git bundle` then refuses it ("Refusing to create empty bundle"). A bundle
  must record at least one named ref. Conservative fix (`git.ts` `gitBundleRange`):
  point a uniquely-named temp branch at the version sha, bundle
  `seedRef..refs/heads/<tmp>`, then delete the branch. It never touches HEAD or
  the working tree, so an in-flight turn is unaffected. Same commit range and
  base64 output the design asked for.

- **Export round-trips by unbundling into a repo that holds the seed ref, not by
  `git clone`-ing the bundle standalone.** `seedRef..versionSha` is a *thin*
  bundle: it carries `seedRef` as a prerequisite, not a payload, so a bare
  `git clone` fails ("Repository lacks these prerequisite commits"). This is by
  design — piece 2's factory already has the seed ref (it seeded from it) and
  fetches the bundle onto a temp ref. The export test replays that exact flow
  (fetch the seed commit from the source, then `git fetch <bundle>`), which is a
  truer round-trip than a standalone clone would be.

- **`seed_ref` stores the requested ref verbatim; export derives the concrete
  anchor sha itself.** The `chats.seed_ref` column records exactly what the
  caller asked to seed at (honest provenance for the "seeded from REQ-2136" UI).
  The export's `seedRef` sha is computed at export time as the workspace root
  commit (`git rev-list --max-parents=0 <versionSha>`) — the shallow seed commit
  for a seeded chat, the golden baseline commit for a template-born one — rather
  than trusting the stored ref string, which may be a branch/tag rather than a
  sha.
