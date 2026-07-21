# Cloud per-chat sandbox pods (app-preview orchestrator)

Status: Phases 0–2 + follow-ups (browser-routing + live resync) ALL built and
live-proven on kind (2026-07-21). The full "fully cloud" loop works: a chat → a
per-chat pod → a browser-reachable preview with the overlay → edits reflected via
git resync. See implementation-notes.md "Cloud sandbox pods" for the live results.
NOTE the preview routing below evolved to HOST-BASED (<slug>.<domain>), not the
"/preview/<chat>" subpath sketched in Phase 1 — subpath breaks Angular's absolute
asset paths. Goal from the user: the ng-v0 editing surface
runs **fully on cloud, no local machine** — the orchestrator and every chat
sandbox live as pods in the existing `software-factory` kind cluster (and later
AKS/OpenShift), reached through ingress.

Today (ADR-0011) the orchestrator is a single local node process that spawns a
local `ng serve` per chat on a localhost port and proxies it in-process
(`preview-bridge.ts`, which injects the point-to-edit overlay and tunnels the
HMR WebSocket). This doc supersedes the local-only constraint.

## The load-bearing decision: where do live edits meet the dev server?

In the local model the opencode turn and the dev server share ONE workspace
directory, so an edit HMR-reloads instantly. In a pod split they would diverge.
Two ways to keep them together:

- **A. Agent-in-pod** — move turn execution into the sandbox pod so the agent,
  workspace, and dev server are co-located. Correct, but a large rewrite of the
  turn pipeline and a heavy per-chat image (opencode + Angular CLI).
- **B. Dev-server-tracks-git (CHOSEN).** Turns keep running in the orchestrator
  (unchanged). Each sandbox pod is a thin **dev server that tracks the chat's
  git ref**: it clones the workspace from the orchestrator's git-daemon at
  startup, and after every green turn the orchestrator pokes it to `git fetch`
  + `reset --hard` to the new Version sha; the dev server's file watcher fires
  HMR. No shared volume (kind is RWO), no agent in the pod, and the current
  turn/gate/Version machinery is untouched.

B is the conservative option and the one we build. Preview latency per turn =
one git fetch+reset (sub-second on a warm clone). The pod is stateless scratch;
the orchestrator remains the single source of truth for the workspace.

## Architecture

```
ng-v0 UI pod (nginx) ──ingress ngv0.localtest.me──▶ orchestrator pod
                                                     │  (control plane + turns
                                                     │   + git-daemon sidecar
                                                     │   + preview bridge proxy)
                          preview (overlay+HMR)  ┌───┴─── creates via k8s API ───▶ sandbox pod / chat
                          proxied through the    │                                (dev server, tracks
                          orchestrator ──────────┘                                 git://orchestrator:9418/<chat>)
platform state: PVC+SQLite (Recreate, single writer) → Azure SQL once a service principal Secret exists
```

Why the orchestrator stays in the request path for previews (not a per-sandbox
ingress): `preview-bridge.ts` must keep injecting the design overlay and
tunnelling the HMR upgrade. Pointing its target at the sandbox **Service DNS**
(`http://sf-sandbox-<chat>.<ns>.svc:<port>`) instead of `localhost:<port>`
reuses that code almost verbatim. Only the orchestrator's own UI needs an
ingress host; sandboxes are reached via the orchestrator's bridge URL.

## Phase 0 — orchestrator + UI as cluster citizens

- `app-preview/orchestrator/Dockerfile` — `node:24-slim`; `npm ci`; compile to
  `dist/` (add a real `build` script) and run `node dist/index.js`; the image
  ALSO carries `git` (the git-daemon sidecar reuses this image, factory-api
  pattern). EXPOSE 7071 (http) + 9418 (git-daemon).
- `app-preview/ui/Dockerfile` — Angular → nginx, the `apps/console` template;
  nginx `proxy_pass` the orchestrator API to `http://ng-v0-orchestrator:7071`.
- `deploy/base/ng-v0.yaml` — orchestrator Deployment (`replicas:1`,
  `strategy:Recreate`, SA `sf-ngv0`, `automountServiceAccountToken:true` — it
  needs the k8s API in Phase 1), git-daemon sidecar exporting `/data/workspaces`
  on 9418, a `sf-ngv0-data` PVC for the platform DB + workspaces; UI Deployment
  (nginx :80); Services `ng-v0-orchestrator` (7071 + 9418) and `ng-v0-ui` (80).
- Platform DB in-cluster: PVC+SQLite at `/data/platform.db` (mirrors factory-api
  `sf-data`). `APPVIEW_DB_URL` stays configurable; Azure SQL is a later swap once
  a service-principal Secret (`APPVIEW_DB_CLIENT_ID/_SECRET/_TENANT_ID`) exists —
  the pod cannot `az login`, so Azure is NOT the Phase 0 default.
- Ingress: add `ngv0.localtest.me` → `ng-v0-ui:80` in `deploy/overlays/local`.
- `index.ts` currently binds `config.hostname`; keep `0.0.0.0` in-cluster.
- Taskfile `kind-load`: build + load `sf-ngv0-orchestrator:dev` and
  `sf-ngv0-ui:dev`; `IfNotPresent`.

## Phase 1 — per-chat sandbox pods (dev-server-tracks-git)

- New abstraction `SandboxProvider` above the current
  `ProcessSpawner`/localhost model in `preview-manager.ts`:
  `start(chatId, seedRef) → { previewBaseUrl, resync(sha), stop() }`.
  - `LocalProcessSandbox` — today's child-process + localhost behaviour,
    preserved and kept as the default when not in-cluster.
  - `KubeSandbox` — creates a Deployment + Service per chat via a TS k8s client
    (`@kubernetes/client-node`). Labels `sf/tier:sandbox, sf/session:<chat>`;
    the pod clones `git://ng-v0-orchestrator:9418/<chat>` and runs the workspace
    dev server; `resync(sha)` triggers an in-pod `git fetch + reset --hard`
    (small HTTP endpoint on the pod, or `kubectl exec`); `stop()` deletes by
    `sf/session=<chat>` with Foreground propagation.
- `preview-bridge` target becomes the sandbox Service DNS; overlay injection and
  the HMR upgrade tunnel are unchanged.
- The orchestrator pokes `resync(newSha)` after each green turn (turn pipeline
  already knows the new Version sha).

## Phase 2 — walls + lifecycle

- RBAC: `sf-ngv0` SA gets the `sf-api-deploy` verb set (deployments/services
  create+get+list+patch+delete+deletecollection) scoped to the namespace.
- NetworkPolicy for `sf/tier:sandbox`: ingress only from the orchestrator
  (bridge proxy) on the dev-server port; egress DNS + the orchestrator git-daemon
  (9418) + package registries for `npm install` (model on `build-walls`, NOT the
  egress-sealed `app-walls`).
- Idle GC: a sweep (mirroring `_sweep_preview_ttl`) deletes sandbox pods whose
  chat has had no turn/subscriber for `SANDBOX_IDLE_TTL`; deleted on chat close.
  Re-created lazily on next preview request.
- Caps: per-chat resource requests/limits (dev servers are heavy — small
  requests, bounded limits); a global concurrency cap on live sandboxes.

## Invariants

- The orchestrator is the single writer of each workspace; sandbox pods are
  read-only scratch that track a git ref. A pod loss is invisible (re-clone).
- Single orchestrator replica (Recreate) — the control loop and preview manager
  assume one process, exactly like factory-api.
- Nothing here weakens the factory's own walls; the sandbox tier is additive.
