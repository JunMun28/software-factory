# Implementation notes — opencode as default agent runtime

Task: add **opencode** as a third `FACTORY_CLI` (alongside codex/claude), make it the
**default**, and prove it with a real full-pipeline end-to-end run.

## Design decisions

- **One chokepoint, unchanged shape.** opencode joins codex/claude behind `run_agent`
  in `agent_exec.py`. New `_opencode_cmd` / `_run_opencode_cli`, mirroring the existing
  two branches. Nothing outside the seam learns a third vendor exists.
- **Headless invocation:** `opencode run --format json -m <provider/model> <prompt>`.
  `--format json` emits an NDJSON event stream; the agent's final message is the
  concatenation of the `type:"text"` parts (verified empirically — see below).
- **Read-only / write contract** (the crux — must be as hard as codex's OS sandbox):
  enforced by a **factory-owned config** pointed at via the `OPENCODE_CONFIG` env var,
  NOT the user's global opencode agents (their global `plan` agent is set to allow-all,
  so it is useless as a read-only guarantee).
  - read-only → `api/app/opencode/factory-readonly.json`: `edit/bash/webfetch = deny`.
  - write     → `api/app/opencode/factory-write.json`:   `edit/bash = allow`, `webfetch = deny`
    (build needs FS + shell for pytest/git; no network, matching codex `workspace-write`).
  Verified live: with the deny config a write attempt returns `DENIED` and no file is
  created (overriding the global allow-all); with the write config `opencode run` creates
  the file. See the two smoke tests in the task transcript.
- **Model:** `FACTORY_OPENCODE_MODEL` defaults to `openai/gpt-5.5` (authed here; matches
  the cost/intelligence profile in CLAUDE.md). opencode model ids are `provider/model`.
- **Foreign-model guard:** the brain passes claude/codex model ids for the prototype step
  (`_proto_model()`), but that already returns `None` unless the CLI is claude, so opencode
  uses `OPENCODE_MODEL`. Defense-in-depth: `_opencode_cmd` only forwards a `model` that
  looks like an opencode id (contains `/`); anything else falls back to `OPENCODE_MODEL`.

## Result

Full pipeline ran **green end-to-end** with opencode/gpt-5.5 as the live runner (REQ-2045,
feature `top_category`): architecture → RED (2 fail / 2 pass) → GREEN + test-isolation (4 pass)
→ review → human merge → `main` updated, status `done`, `pytest` on merged main = 4 passed.
Reviewer verdict was REQUEST-CHANGES (advisory — the human merge gate governs, as designed).

## Deviations

- **Simulator merge-gate email is post-commit.** The simulator now carries the
  table-owned gate notification through `Win.notify()` and fires it only after
  the per-request tick commit. Recipients and single-send behavior are unchanged,
  but a failed commit can no longer announce a gate that was rolled back.
- **`--dir` is mandatory, subprocess cwd is not enough.** The first full-pipeline run
  escalated at the architecture gate: the stage agent read the *software-factory repo root*
  (`api/`, `sample/`) instead of the per-request workspace, despite `Popen(cwd=ws)`. Headless
  `opencode run` resolves its project dir from `--dir` (it can attach to a server whose dir
  differs), NOT the process cwd. Fix: `_opencode_cmd` emits `--dir <cwd>` whenever a cwd is
  given. Verified: with `--dir` the agent reads the workspace's `SPEC.md`/`src/` correctly.
  (Codex/claude are unaffected — they honor process cwd, so this stays inside the opencode branch.)
- **Headless-autonomy directive needed.** Second run reached architecture but escalated at the
  RED gate: gpt-5.5 answered the stage prompt with a plan + "reply `OK` and I will proceed" and
  wrote no tests — a single-shot `run` has no one to say OK. Fix: the opencode adapter appends a
  short "you are headless, act in one turn, never ask for confirmation" directive (`_OPENCODE_HEADLESS`),
  the counterpart to claude's `--safe-mode`. Shared stage prompts stay CLI-neutral; only the
  opencode branch appends it.

---

## Lifecycle transitions — final wrap-up (2026-07-15)

- **Branch:** `lifecycle-transitions`
- **Seven-task commit series:** all seven implementation commits are present; the
  coordinator committed Task 7 as `9eeb068`.
  1. `acee7de` — transition table + `apply()`, the legal lifecycle write path
  2. `919ecce` — gate endpoints through `apply()`
  3. `903bb37` — submit/create through `apply()` with flush-first semantics
  4. `1e3703b` — simulator transitions, epoch fencing, commit-per-item
  5. `58c007b` — runner/startup transitions; `lifecycle.py` absorbed and deleted
  6. `8077a95` — shared `classify()` projection for mission, inbox, and detail
  7. `9eeb068` — Task 7 terminology, documentation, architecture assertion,
     characterization test, implementation notes, and final report
- **Verification:** `263 passed, 2 warnings`; `uv run ruff check .` passed. The
  full `task verify` chain passed lint, API tests, all 188 frontend tests, and both
  production builds, but this managed sandbox forbids the smoke server from binding
  `127.0.0.1:8911` (`Errno 1`), so it could not reach `✓ VERIFY PASSED` here.

### Deviations

- `apply()` guards parameter-dependent effect construction so a consumed precondition
  resolves as `Loss`, while an eligible call with missing parameters still raises.
- `apply()` flushes staged sibling writes before its CAS, preserving them across the
  winner refresh while `Loss` still rolls the transaction back.
- Simulator merge-gate notification now fires through `Win.notify()` after commit;
  recipients and exactly-once behavior are unchanged, and rolled-back gates are not announced.
- Task 7 was subsequently committed by the coordinator as `9eeb068`.

## Deviations — generation-stream branch (2026-07-15)

- **GenerationStream constructor gained an optional 5th `opts` bag** beyond design
  D14's four positional args: the real per-component variance (three distinct
  "should I stream" decision points, two payload validators, onState side effects,
  error handlers) cannot ride four positionals. Documented in the plan; pinned by
  the class spec.
- **Four pre-approved micro-normalizations** (from the plan): prototype's poll gains
  clear-timer-before-re-arm; interview loses scroll-on-invalid-SSE-payload (its
  `busy` clear there was unreachable — verified); review/plan-panel gain
  clear-before-arm; all four share one teardown shape.
- **Final-review fix**: `drive()` now clears any pending poll tick first — a stale
  poll response could transiently overwrite an SSE terminal state (unreachable
  through the current four components; hardened because the class is a public
  surface). Garbled-SSE-payload fallback test ported from the deleted streamState
  spec.

## Deviations

- **B2 review — reset safety:** `workspace.reset_branch()` now stops immediately
  when the work-branch checkout fails. It never runs hard reset or clean against
  whichever branch happened to be checked out (especially `main`).
- **B2 review — 409 adoption:** same-name Job adoption is now limited to the
  crash-before-record case where no prior `StageJob` UID exists. Once any UID was
  recorded, both a lingering known UID and an unknown stranger UID park as infra;
  neither is adopted or graded.
- **B2 review — SHA input:** git-backed runs accept agent-supplied stage SHAs only
  when they match `^[0-9a-f]{40}$`. A malformed SHA becomes a recorded gate
  failure, while malformed historical graded SHAs are ignored as reset/merge
  targets.
- **B2 review — unset remote fallback:** `approve_merge()` delegates to the B1
  simulator path as soon as `FACTORY_GIT_REMOTE_BASE` is unset, before it computes
  a workspace path or reads graded git state.
- **B2 review — UID-safe deletion:** the small client-seam change was made rather
  than deferred: every runner deletion passes the recorded `StageJob.job_uid`, and
  `RealKubeClient` sends it as a `V1DeleteOptions` UID precondition. Deletes with no
  recorded UID retain the prior unconditioned behavior.
- **B2 review — capture docs:** `kube_jobs.py` now says running-pod output capture
  is attempted before deletion; only transfer failure remains best-effort.
- **Prior task-report deviation — wall-clock assertion:** the B1 wall-clock test's
  envelope assertion changed from the fake termination message to `None`. A pod
  that is still running has no terminated-container message, even though
  `capture=True` can already retrieve and persist its live logs.
- **Prior task-report deviation — retry timing:** `defer_spawn` added a deliberate
  one-tick delay after failed, timed-out, or infra observations so deterministic
  same-name Jobs are not recreated while their predecessors are still terminating.
  Nested gate-spawn failures now propagate the same delay.

## Plan B2 — kind cluster (2026-07-15)

- **Cluster:** kind v0.32.0 (node Kubernetes v1.36.1), Calico v3.30.3
  (server-side apply; enforcement PROVEN by `scripts/calico-probe.sh` —
  kindnet's silent NetworkPolicy no-op is the trap this avoids),
  ingress-nginx controller-v1.13.0 on host port 8081.
- **sf-agent image:** built on `ghcr.io/astral-sh/uv:python3.13-bookworm-slim`
  with git 2.39.5, pytest 9.1.1, node 24.18.0, codex-cli 0.144.4,
  opencode 1.18.1, @angular/cli, jq 1.6. All gate paths verified under
  `--user 12345:0` (arbitrary-UID proof) against the sample fixture; each
  printed envelope round-trips through `app.kube_jobs.parse_envelope`.
- **Manifests:** kustomize base + `overlays/local`; backend Service named
  `api` so the SPA images' baked `proxy_pass http://api:8000` stays
  unchanged; git-daemon sidecar exports `/data/workspaces` on 9418;
  SQLite-on-PVC by default (Azure SQL is a one-env swap, see plan
  decision 10).

### Deviations (B2 cluster half)

- **codex sandbox inside pods:** the plan's `codex exec -s workspace-write`
  (and `-s read-only` for review) fails inside unprivileged containers —
  bubblewrap/landlock cannot create user namespaces, so EVERY exec/apply_patch
  errors and codex exits 0 having written nothing (found live: REQ-2045
  escalated with "architecture produced no PLAN.md" after 2 honest gate
  fails). Conservative fix: `-s danger-full-access` in-pod — the POD is the
  sandbox (non-root arbitrary UID, NetworkPolicy walls, ephemeral clone); the
  review stage stays read-only by construction (nothing pushed; the gate
  grades the pinned SHA on the orchestrator's own repo). Proven by local
  docker repro before rerunning the smoke.
- **Kind smoke run of record (2026-07-15):** REQ-2046 end-to-end in ~17 min,
  zero gate retries (run 1 failed on the codex-sandbox deviation above;
  run 2 clean). Architecture/red/green/review each ran as one codex agent
  Job + one gate Job; merge gate approved via API; workspace main tip =
  merge commit; all Jobs reaped; all 6 netpol walls re-proven in-run.
- **B2 post-merge review fixes:** stage-pod egress now excepts 169.254.0.0/16
  (link-local/IMDS — the SSRF wall this template must carry to Azure);
  netpol-smoke probes print SF_OPEN/SF_BLOCKED from inside the pod so an
  unschedulable probe fails loudly instead of reading as "blocked";
  calico-probe cleans its namespace on the failure path too; the review
  verdict grep is line-anchored so prose mentions can't count as a verdict.

## Plan B3 — produced-app build + deploy (2026-07-16)

- **Registry:** in-cluster `sf-registry` (registry:2) + containerd NodePort
  mirror — ONE image name (`sf-registry:5000/sf-app-<slug>`) for kaniko push
  (cluster DNS) and kubelet pull (mirror → localhost:30500). Both directions
  probed before the smoke: build-tier pod got HTTP 200 on /v2/, node crictl
  pull resolved through the mirror (404 manifest, not DNS failure).
- **Build:** kaniko (gcr.io/kaniko-project/executor:latest), non-privileged
  (allowPrivilegeEscalation false, drop ALL), clone init-container reuses
  sf-agent (`SF_ROLE=clone`); digest captured via
  `--digest-file=/dev/termination-log` on the existing capture-before-delete
  machinery.
- **Review wave (opus, 1 HIGH + 1 MEDIUM, both fixed + pinned):** a timed-out
  deploy row dead-ended the request after a human Retry (driver now re-applies
  when the last deploy row is dead — apply is create-or-update, the intent key
  is idempotent); an absent build Job (crash between row commit and create)
  escalated instead of re-running (now re-spawns, bounded at 3 consecutive
  infra rounds).
- **Deviations:** none beyond the plan; docker builds must run from a CLEAN
  worktree when the main checkout has another session's uncommitted edits
  (`git worktree add --detach`), and `.dockerignore` now exists because the
  intake build once copied `.claude/worktrees/` and filled the disk.
- **Live findings (first real build+deploy run, each fixed + re-proven):**
  (1) kaniko as UID 10101 dies unpacking rootfs ("chown /") — kaniko container
  now in-container root (no privileged mode, no escalation; the pre-recorded
  plan fallback); (2) `pip install` inside the build needs package indexes —
  FQDN allowlists don't exist in vanilla NetworkPolicy, so build-walls egress
  is internet-except-cluster+IMDS (stage-pod shape; office/AKS profiles put
  Artifactory/EgressFirewall behind the same seam); (3) `rollout_ready` reads
  the deployments/status SUBRESOURCE — its own RBAC rule; (4) app-walls must
  admit the factory-api pod on :8000 — the runner's deploy-verify health probe
  is the one in-cluster caller besides the ingress. The escalate → Retry →
  re-drive loop recovered the same request through all four fixes with no
  rebuild of anything but the failed leg — the review-wave re-drive path,
  exercised live.

---

# Implementation notes — IntakeDraft stale-answer leak fix (2026-07-16)

Task: stop a previous request's in-memory draft answers (reach/impact/app) from
leaking into a newly opened/created request.

## Root cause

`IntakeDraft.hydrateFrom()` stamped `requestId = d.id` and then early-returned
whenever the draft was "live" (`type != null`) — keeping every OTHER field from
the PREVIOUS request. Any later `save()` (ring click, blur, type pick) PATCHed
request A's answers onto request B. Reproduced live: with a live draft on
request 99 (`reach='me'`), SPA-navigating (list → interview) to request 97
produced a draft claiming to be 97 while still holding 99's answers.

## Fix

`hydrateFrom()` now calls `reset()` whenever the incoming `d.id` differs from
the draft's own `requestId`, before hydrating from the server. Same-request
re-hydration keeps in-session edits exactly as before (including
`typeConfidence < 1`, which the basics wizard relies on to never pre-select a
type). Reset-then-hydrate also covers "server value is null" — fields return to
defaults instead of retaining stale values. Two new specs in
`intake-draft.service.spec.ts` (72 intake tests green).

## Deviations

- The task suggested also resetting the draft in `new-request.ts` on mount.
  NOT done (conservative choice): Review's "Edit details" intentionally lands on
  `/submit/new` with a live draft to keep editing it (see `sub-shell.startNew`
  comment), and `save()` PATCHes the full body — clearing basics on mount would
  wipe the stored answers on the server for that legitimate flow. With the
  `hydrateFrom` guard, the cross-request leak is closed at the single chokepoint;
  deep-linking to `/submit/new` with a live draft now means "resume editing that
  draft" (the old description is visibly prefilled in the composer), which
  matches the Edit-details semantics.
- Noticed, out of scope: `Interview.id` reads the route param from a SNAPSHOT,
  so a hypothetical interview→interview param-only navigation reuses the
  component with a stale id. No in-app link does this today; worth a
  paramMap-subscription if one ever appears.

## Console overview redesign (2026-07-16)

User rejected the narrative Floor home page. Rebuilt `/` as an admin
dashboard with two zones:

1. **Waiting on you** — a dense decision queue derived from `/api/mission`:
   gate rows (spec gate = "approve to build", merge gate = "approve to
   deploy") with inline evidence bits + Approve / Send back; needs-human
   rows with the four recovery verbs; human-owned rows.
2. **Pipeline board** — bird's-eye of every open request across five fixed
   columns: Intake & Spec, Architecture, Build, Review & Preview, Deploy.
   Populated from the Store's `/api/requests` projection, with run overlays
   (step x of y, health) joined from mission runs. Approval boundaries are
   drawn on the Architecture and Deploy column headers (amber diamond,
   "enters by approval") — the two human gates are visible in the geometry.

Mechanics kept, not rebuilt: gate modals, action plumbing (409 outcomes),
j/k + a/s keyboard flow, poll loop. `FloorGateCard` deleted (queue rows
replaced it). Shell nav label Floor → Overview; shell gains a `wide` input
so the board gets 1400px while other pages keep 1060px.

`stage: 'deploy'` added to the shared FactoryRequest type (backend B3
already emits it via begin_deploy).

### Deviations
- "Steer next step" dropped from the home page (was on every lane card);
  still available per-request in the dossier, which is the scoped place
  for it. Conservative: no backend change, no feature loss.
