# ng-v0 bridge — conversational preview editing (design)

Decision D3 (2026-07-18): ng-v0 becomes the **editing surface** for factory
previews; the factory remains the **only road to production**. v1 shipped the
in-factory path (preview link + request-changes feedback rounds); this doc is
the contract for the full bridge. The "Edit in ng-v0" button in the intake
preview card is honest-disabled until this lands.

## Why not today

ng-v0's `POST /chats` takes only `projectId`/`title` — a Chat's workspace is
always born from ng-v0's own golden template (`workspace-provider.ts` copies
the blueprint). There is no way to seed a Chat from an existing repo state.
Both repos share the same golden template (the factory vendored it), so the
gap is narrow and well-defined.

## The contract (three pieces)

### 1. ng-v0: seed a Chat from a source (ng-v0-side change)

`POST /chats` gains an optional `seed`:

```json
{ "title": "REQ-2136 preview edits",
  "seed": { "kind": "git", "url": "http://<factory-git>/req-2136", "ref": "<preview-sha>" } }
```

- workspace-provider: when `seed` present, `git clone --depth 1 <url>` at
  `<ref>` instead of copying the blueprint; then the normal gate run proves
  the seeded app is green before the first turn (a red seed fails chat
  creation loudly — never start a conversation on a broken app).
- The Chat records `seed` metadata so the UI can show "seeded from REQ-2136".

### 2. Factory: expose the seed source + accept the result

- Seed source: the request's git-daemon repo (`GIT_REMOTE_BASE/<ref>`) at the
  PREVIEWED sha — both already exist; needs only a read-only URL reachable
  from ng-v0's sandboxes (same host in dev; office = internal git).
- `POST /api/requests/{rid}/preview/import-edit` (new): body
  `{ "bundle": <git bundle or patch>, "summary": str }`. The factory applies
  it as a commit on the request's work branch **through the normal
  preview-revision machinery** (same rail as request-changes: rewind →
  re-grade red/green/review → new preview round). ng-v0 edits NEVER skip the
  factory gates — an imported edit is exactly a very concrete feedback round.

### 3. ng-v0: export a Version back

`POST /chats/:chatId/versions/:versionId/export` (new): returns a git bundle
of the Version's tree against the seed ref. The intake preview card's
"Send back to the factory" action posts it to `import-edit`.

## UX

Intake preview card: **Edit in ng-v0** → opens
`<ng-v0-ui>/chats/new?seed=req-2136` (ng-v0 UI reads the query, calls
POST /chats with the seed). The user iterates conversationally (ng-v0's
sandbox previews, green-gated Versions). When happy: "Send back" → factory
imports → pipeline re-grades → new factory preview round → accept → merge →
deploy as normal.

## Invariants

- The factory's gates (red/green/review, accept-preview, merge, deploy) grade
  every imported edit. ng-v0 Versions are green by ng-v0's gate, but the
  factory re-proves them under ITS OWN gate — trust is not transitive.
- Identity: the import records the requester (Entra identity) as the actor.
- One template. If the golden templates drift between repos, seeding still
  works (clone, not copy) but gate expectations may diverge — sync the
  vendored copy when ng-v0's template changes (provenance note in
  templates/golden delta log).

## Sizing

ng-v0 side: seed param + clone path + export endpoint (~1-2 days with tests).
Factory side: import-edit endpoint + intake card wiring (~1 day). Both are
independent, contract-first — either side can land behind a flag.
