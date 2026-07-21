# ng-v0 bridge — conversational preview editing (design)

Visual: [factory-flow.html](factory-flow.html) — the full intake → factory →
sandbox → deploy line as one page (open in a browser).

Decision D3 (2026-07-18, revised 2026-07-21): ng-v0 becomes the **editing
surface** for factory previews; the factory remains the **only road to
production**. v1 shipped the in-factory path (preview link + request-changes
feedback rounds); this doc is the contract for the full bridge. The "Edit in
ng-v0" button in the intake preview card is honest-disabled until this lands.

**v2 revision (2026-07-21):** an imported edit is no longer replayed as a
feedback round through the architecture/build stages. The sandbox session
already produced the code, so the factory applies it **directly** and resumes
at verification. See "The contract", piece 2.

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

### 2. Factory: expose the seed source + apply the result directly

- Seed source: the request's git-daemon repo (`GIT_REMOTE_BASE/<ref>`) at the
  PREVIEWED sha — both already exist; needs only a read-only URL reachable
  from ng-v0's sandboxes (same host in dev; office = internal git).
- `POST /api/requests/{rid}/preview/import-edit` (new): body
  `{ "bundle": <git bundle>, "summary": str, "versions": [{sha, message}] }`.

  **Direct apply — no stage rewind.** The factory:

  1. Applies the bundle to a **temp ref** first, never straight onto the work
     branch. Each sandbox Version arrives as its **own commit, 1:1** — the
     bundle carries the session's real git history against the seed ref, not
     a squashed patch. Every edit stays an individually revertable checkpoint
     (`git revert <sha>`), mirroring ng-v0's Versions list.
  2. Runs the factory gate on the temp ref. **Red → the import is rejected
     atomically**: the work branch is untouched and the 422 response carries
     the gate output so the requester fixes it in the sandbox, where they
     were already working. (The factory's gate can disagree with the
     sandbox's — trust is not transitive.)
  3. Green → fast-forwards the work branch to the temp ref, authored/attributed
     to the requester (Entra identity), and **records the session in the
     spec**: preview round, who edited, per-Version summaries (the chat
     turns' prompts), and the diffstat. The spec stays the true description
     of the app; code and spec never drift silently.
  4. Resumes the pipeline **at verification, not at the beginning**: review
     re-runs on the imported diff (cheap; catches leaked secrets and
     accidental regressions even in human edits) → new preview round → the
     normal accept → merge → deploy. The architecture/build agent stages are
     **skipped** — there is nothing to re-derive.

  Concurrency: if the work branch has moved since the seed sha (another
  feedback round landed), the import is rejected with the conservative
  answer — re-seed from the new preview and replay the edits there.

### 3. ng-v0: export a Version back

`POST /chats/:chatId/versions/:versionId/export` (new): returns a **git
bundle of the Version's commit chain** against the seed ref (history
preserved — this is what makes piece 2's per-checkpoint revert possible),
plus the per-Version summaries. The intake preview card's "Send back to the
factory" action posts it to `import-edit`.

## UX

Intake preview card: **Edit in ng-v0** → opens
`<ng-v0-ui>/chats/new?seed=req-2136` (ng-v0 UI reads the query, calls
POST /chats with the seed). The user iterates conversationally — every green
turn is a Version, a git commit checkpoint restorable exactly like v0. When
happy: "Send back" → factory gates the import → spec records the session →
review → new factory preview round → accept → merge → deploy as normal. If
the factory gate rejects the import, the sandbox shows the gate output and
the user keeps editing where they are.

## Invariants

- **The factory still grades every import** — gate and review re-run under
  the factory's own runner; only the build stage is skipped, because the code
  already exists. ng-v0 Versions are green by ng-v0's gate, but the factory
  re-proves them under ITS OWN gate — trust is not transitive.
- **No side door**: production is still reached only through accept → merge
  → deploy. Direct apply shortens the path to a new preview; it does not
  bypass the human gate.
- **Spec is the record**: an import that lands without its spec record is a
  bug. The spec entry is written in the same transaction as the branch
  fast-forward.
- Identity: the import records the requester (Entra identity) as the actor
  on every imported commit.
- One template. If the golden templates drift between repos, seeding still
  works (clone, not copy) but gate expectations may diverge — sync the
  vendored copy when ng-v0's template changes (provenance note in
  templates/golden delta log).

## Sizing

ng-v0 side: seed param + clone path + export endpoint (~1-2 days with tests).
Factory side: import-edit (temp-ref apply + gate + spec record + resume-at-
review) + intake card wiring (~1.5 days). Both are independent,
contract-first — either side can land behind a flag.
