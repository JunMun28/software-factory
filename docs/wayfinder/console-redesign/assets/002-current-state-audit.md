# Current-state audit: Console and supervision backend

**Audit date:** 2026-07-10  
**Scope:** `apps/console`, its shared client state/API layer, and the FastAPI supervision paths it consumes.  
**Method:** source audit of current code; the June 2026 design is treated as intent, not proof.  
**Constraints carried forward:** `progress_event` remains append-only; the API remains single-worker; the two human gates and their side effects remain authoritative.

## Executive findings

- The console has ten routed/structural surfaces: shell, Mission control, Factory map, All requests, Gates/queue, Request detail, per-app Activity/feed, Needs me, Registry, and Settings (`apps/console/src/app/app.routes.ts:11-60`).
- The operating spine is a single append-only event cursor polled every 4 seconds. Any new event increments a global version; most projections then re-fetch in full (`packages/shared/src/lib/poll.service.ts:25-61`; `apps/console/src/app/core/store.service.ts:22-28`).
- Mission control is the default and correctly separates gates, autonomous runs, stalled work, and recent work (`apps/console/src/app/admin/mission.ts:60-241`; `docs/adr/0015-supervision-first-console.md:12-20`).
- Run state is derived at read time from the latest stage-local `step_summary`; it is not stored (`api/app/supervision.py:31-55`; `docs/adr/0014-step-level-trace-events.md:16-17`).
- Gate evidence is also derived: spec evidence from grounded spec lines; merge evidence from the latest `verification` event (`api/app/supervision.py:72-98`).
- The simulator implements the full supervision contract: `step_summary`, steer acknowledgments, milestones, verification, and gate events (`api/app/simulator.py:59-94`).
- The real `agent` runner now emits merge `verification`; the old “no verification” gap is partly fixed. It still emits no `step_summary` and never consumes/acknowledges `steer_note`, leaving real runs at `step 0`, `no_signal` (`api/app/agent_runner.py:193-313`).
- Approver identity is persisted in both `gate_event.actor` and `AuditEvent.actor`, but Request detail does not read either into its “who” line. The requested RequestDetail gap is confirmed even though the underlying actor data exists (`api/app/routers/gates.py:52-70`; `apps/console/src/app/admin/request-detail.ts:761-768`).
- There is no operator claim/reservation model. Spec approval has an atomic compare-and-set against double pipeline start, but the console cannot show who is reviewing or prevent two operators composing conflicting actions (`api/app/routers/gates.py:52-63`).
- The current code is a useful supervision prototype, not yet a reliable 2–5 operator control room: identity is a browser-local mock defaulting every operator to Kim P., action errors are mostly unhandled, and optimistic/local chips can disagree across browsers (`apps/console/src/app/core/session.service.ts:5-28`; `apps/console/src/app/admin/mission.ts:555-589`).

## 1. Routing and shell

### Route map

- `/` and `/admin` redirect to `/admin/mission`; wildcard routes do the same (`apps/console/src/app/app.routes.ts:11-13,60`).
- `/admin/map` → Factory map; `/admin/mission` → Mission control; `/admin/list` → All requests; `/admin/queue` → Gates (`apps/console/src/app/app.routes.ts:14-33`).
- `/admin/requests/:id` → Request detail; `/admin/apps/:key` → per-app feed (`apps/console/src/app/app.routes.ts:34-43`).
- `/admin/inbox`, `/admin/registry`, and `/admin/settings` complete the operator surface (`apps/console/src/app/app.routes.ts:44-58`).
- Every routed surface uses `adminGuard`, but the console session defaults to an admin, so this is not real access control (`apps/console/src/app/app.routes.ts:14-58`; `apps/console/src/app/core/session.service.ts:13-22`).

### Admin shell

**Shows.** Persistent sidebar, app/channel navigation, badges for gates/escalations, runner mode, last-sync age, command palette, theme control, and mock operator identity (`apps/console/src/app/admin/admin-shell.ts:16-156`).

**Endpoints.** Indirectly consumes Store projections `GET /api/requests`, `GET /api/apps`, and `GET /api/inbox`; directly calls `GET /api/health`; command palette can call `POST /api/simulator/tick` (`apps/console/src/app/core/store.service.ts:22-28`; `apps/console/src/app/admin/admin-shell.ts:326-354`; `api/app/routers/system.py:23-36`).

**State/events.** Reads `AppEntry.{id,key,name,muted,unread}` and inbox `gate`/`needs_human`; reads health `runner`. It does not interpret event kinds directly (`apps/console/src/app/admin/admin-shell.ts:65-83,293-297`).

**Refresh.** Starts the singleton Poll service once; health is fetched only in the shell constructor and does not refresh with later poll versions (`apps/console/src/app/admin/admin-shell.ts:326-329`). Store data re-fetches whenever Poll `version` changes (`apps/console/src/app/core/store.service.ts:22-28`).

**UX.** Strong keyboard layer: command palette, `G` chords, shortcuts overlay, and a real cross-app “New request” link (`apps/console/src/app/admin/admin-shell.ts:281-320,336-469`). Runner badge is broken: health returns `runner_mode()` (`agent` or simulator), while the shell tests for `claude` and labels every other value “simulated” (`api/app/routers/system.py:23-32`; `apps/console/src/app/admin/admin-shell.ts:129-139`).

## 2. Surface-by-surface inventory

### Mission control — `/admin/mission`

**Shows.** Consequence-ordered bands: gates with evidence and side effects; live runs with step progress/health and inline steering; stalled requests with reason/retry; recent done/cancelled/sent-back work (`apps/console/src/app/admin/mission.ts:60-241`). An all-clear hero appears when gates and stalled are both empty while runs remain visible (`apps/console/src/app/admin/mission.ts:49-59,627-630`).

**Endpoints.** `GET /api/mission`; mutations use `POST /api/requests/{id}/approve`, `/send-back`, `/retry`, and `/steer` (`apps/console/src/app/admin/mission.ts:542-545,572-622`; `api/app/routers/mission.py:20-49`).

**State/events.** Reads aggregate `gates[].request`, `gates[].evidence`, `runs[].run`, `stalled`, and `recent`. Run fields are `step`, `of`, `label`, `health`, `seconds_since_event` (`packages/shared/src/lib/models.ts:208-249`). Indirect event dependencies are latest `step_summary` for run state and latest `verification` for merge evidence (`api/app/supervision.py:31-55,83-97`).

**Refresh.** Full `GET /api/mission` on every Poll version bump; 4-second cursor polling only bumps version when events arrive, or immediately after local mutation nudge (`apps/console/src/app/admin/mission.ts:538-546`; `packages/shared/src/lib/poll.service.ts:41-67`). Request row changes that emit no progress event will not cause another browser to refresh until some later event.

**UX/actions.** Keyboard `J/K`, Enter, `A`, `S`, `T`; evidence before approval; side-effect text; inline steering preserves text on 409/error (`apps/console/src/app/admin/mission.ts:66-95,667-696`). The “note queued” chip is browser-session-local and never reconciled/cleared from server acknowledgment (`apps/console/src/app/admin/mission.ts:142-145,552-589`). “Open issue” is stale tracker vocabulary (`apps/console/src/app/admin/mission.ts:192,624-626`).

### Factory map — `/admin/map`

**Shows.** Six spatial stage columns, two gate counts, live step overlays, a “Now working” band, attention exceptions, summary counts, filters/zoom, and idle placeholders (`apps/console/src/app/admin/map.ts:19-22`; `apps/console/src/app/core/map-view.ts:4-42,77-120`).

**Endpoints.** Indirect `GET /api/requests` through Store plus page-local `GET /api/mission` (`apps/console/src/app/admin/map.ts:979-1006`). Drill-down navigates to Request detail; no mutations are offered.

**State/events.** Uses request `stage`, `status`, `gate`, `needs_human`, app/type fields, plus mission `runs[].run.step/of`. Map state precedence is stalled → gate → sent-back → done → run → triage (`apps/console/src/app/core/map-view.ts:65-73`). No event kind is rendered directly.

**Refresh.** Store and mission both re-fetch on Poll version; the two HTTP responses can land at different times, briefly combining different snapshots (`apps/console/src/app/admin/map.ts:979-1003`; `apps/console/src/app/core/store.service.ts:22-28`).

**UX.** Purposefully a lens, not the worklist; it stores no new state (`docs/adr/0016-factory-map-spatial-lens-and-cockpit-exception.md:5-10`). Cockpit styling is an explicit exception. Known ADR-recorded defects remain: no keyboard parity, unlabeled/mismatched conic fill, and width animation layout work (`docs/adr/0016-factory-map-spatial-lens-and-cockpit-exception.md:46-54`). Empty stages say “stage idle”; no active run says the lane is clear (`apps/console/src/app/admin/map.ts:111,173`).

**Broken handoff.** Map drills to List with `?stage=` / `?state=gate`, but List never reads `ActivatedRoute` or query parameters and always renders all bands (`apps/console/src/app/admin/map.ts:1068-1073`; `apps/console/src/app/admin/list.ts:86-95`).

### All requests — `/admin/list`

**Shows.** All non-draft requests grouped into Gates/needs-human, Intake, In flight, Sent back, Done, and Cancelled bands. Rows show glyph, title, type, app, attention badge, stage, and age (`apps/console/src/app/admin/list.ts:31-73,94-138`).

**Endpoints.** Indirect `GET /api/requests` only (`apps/console/src/app/admin/list.ts:86-90`; `api/app/routers/requests.py:235-257`). Row opens Request detail.

**State/events.** Reads request lifecycle fields and `last_event` only through the shared Request model, though `last_event` is not displayed. No direct event-kind rendering (`api/app/routers/requests.py:244-257`; `apps/console/src/app/admin/list.ts:43-70`).

**Refresh.** Store full-list re-fetch on Poll version. Backend caps at 500 by client default/1000 maximum; there is no client pagination or notice of truncation (`api/app/routers/requests.py:235-243`; `packages/shared/src/lib/api.service.ts:39-43`).

**UX.** Keyboard Enter works per focused row. The implemented list does not match the design’s flat searchable/filterable archive or keyset pagination; it is grouped, has no search, no filters, and hides empty groups (`apps/console/src/app/admin/list.ts:35-73,136-137`; design intent at `docs/superpowers/specs/2026-06-12-ui-supervision-revamp-design.md:168-171`).

### Gates / Approval queue — `/admin/queue`

**Shows.** Two-pane attention queue. Left side lists inbox work; right side renders request detail, escalation recovery, duplicate warning, grounded draft spec/open questions, merge evidence, attachments/context, and a pinned action bar (`apps/console/src/app/admin/queue.ts:45-105,133-266`).

**Endpoints.** Indirect `GET /api/inbox`; selected item `GET /api/requests/{id}`; actions call `/approve`, `/send-back`, `/cancel`, and `/retry` (`apps/console/src/app/admin/queue.ts:317-383`; `api/app/routers/gates.py:26-157`).

**State/events.** Reads request `gate`, `needs_human`, reason, evidence, spec lines/open note, duplicate, attachment/detail data. It does not fetch trace events. Evidence is derived from spec/verification as described above.

**Refresh.** Inbox follows Store version; selected detail re-fetches when selection or poll-dependent effects run (`apps/console/src/app/admin/queue.ts:317-341`). Mutations nudge the shared poll after success (`apps/console/src/app/admin/queue.ts:368-383`).

**UX/actions.** Approve, spec send-back, cancel, and retry are implemented with keyboard shortcuts and confirmations (`apps/console/src/app/admin/queue.ts:244-286,368-416`). Empty left pane presents a clear state (`apps/console/src/app/admin/queue.ts:75-77`). Merge gates show evidence; spec gates show grounded draft content (`apps/console/src/app/admin/queue.ts:225-233`).

### Request detail — `/admin/requests/:id`

**Shows.** Header/status/who line, recovery/gate actions, escalation reason, gate evidence, attachments, toggleable Delivery map and stage-grouped trace, plus comments (`apps/console/src/app/admin/request-detail.ts:75-180,220-320`). It intentionally drops issue-tracker labels/checklists/subscribers (`apps/console/src/app/admin/request-detail.ts:29-32`).

**Endpoints.** Polls `GET /api/requests/{id}` and `GET /api/requests/{id}/trace`; uses raw attachment URLs; actions call `/approve`, `/send-back`, `/cancel`, `/retry`, and `/comments` (`apps/console/src/app/admin/request-detail.ts:739-757,797-835`; `api/app/routers/events.py:92-127`; `api/app/routers/attachments.py:50-51`).

**State/events.** Reads all detail lifecycle data, derived `run`, `evidence`, attachments, comments, and trace events. Renders all eight event kinds generically, with special treatment for `step_summary`, `steer_note`, `gate_event`, `verification`, `milestone_summary`, and `escalation` (`apps/console/src/app/admin/request-detail.ts:240-274,770-785`). `recovery_action` and `comment` fall through to the generic ring/title row; comments are also rendered separately from `RequestDetail.comments` (`apps/console/src/app/admin/request-detail.ts:286-319`).

**Refresh.** Both full detail and up-to-200 trace items re-fetch on every Poll version. It does not use trace keyset incrementally and has no older-page UI (`apps/console/src/app/admin/request-detail.ts:739-758`; `packages/shared/src/lib/api.service.ts:176-179`).

**UX/actions.** Loading skeleton, evidence strip, why expansion, steer acknowledgment labels, comments, and keyboard `A/S/C/R` are present (`apps/console/src/app/admin/request-detail.ts:59-73,240-280,843-870`). Needs-human recovery only offers retry/retry-with-note/cancel; the source explicitly says Take over and Send back to stage are not built (`apps/console/src/app/admin/request-detail.ts:95-121`).

### Per-app Activity/feed — `/admin/apps/:key`

**Shows.** App identity, follow/mute controls, request participants, milestone/gate/escalation/recovery/comment messages, grouped threads/attention items, and a plain composer (`apps/console/src/app/admin/feed.ts:120-225,240-278`).

**Endpoints.** Indirect Store `GET /api/apps` and `GET /api/requests`; direct `GET /api/subjects/{key}/feed`; comments use `POST /api/requests/{id}/comments` (`apps/console/src/app/admin/feed.ts:246-248,281-320,489-493`; `api/app/routers/events.py:72-89,111-124`).

**State/events.** Subject feed deliberately excludes `step_summary`, `steer_note`, and `verification`; it renders `milestone_summary`, `gate_event`, `escalation`, `recovery_action`, and `comment` (`api/app/routers/events.py:26,72-89`; `apps/console/src/app/admin/feed.ts:266,306-320,378-442`).

**Refresh.** Initial/full subject feed fetches on app key changes. Thereafter the page merges Poll `delta` events for that app, filtering trace-only kinds, rather than re-fetching the whole feed (`apps/console/src/app/admin/feed.ts:281-320`). This is the only major surface that actually uses the delta signal as designed.

**UX.** Calm milestone-level channel is consistent with the firehose guard (`docs/adr/0014-step-level-trace-events.md:25-27`). Composer targets the currently active request heuristically, falling back to the first request; that can post to an unintended thread when several requests share the app (`apps/console/src/app/admin/feed.ts:334-344,489-493`).

### Needs me — `/admin/inbox`

**Shows.** Clear-to-zero list of gates and escalations, with app/type/title/action/age. Empty state says “No specs waiting on you,” even though merge gates and escalations also belong here (`apps/console/src/app/admin/inbox.ts:17-75`).

**Endpoints.** Indirect `GET /api/inbox`; row handoff routes to Queue with `?sel={id}` (`apps/console/src/app/admin/inbox.ts:79-100`; `api/app/routers/events.py:133-142`).

**State/events.** Reads request `needs_human`, `gate`, type, app, title, and creation age. Inbox membership is row-state based, not assigned-operator based; it is the same list for every admin (`apps/console/src/app/admin/inbox.ts:41-65`; `api/app/routers/events.py:133-142`).

**Refresh.** Store re-fetch on global Poll version. Focus index is clamped as rows disappear (`apps/console/src/app/admin/inbox.ts:83-91`).

**UX.** `J/K`, Enter, and `A` all navigate to Queue; `A` does not approve directly (`apps/console/src/app/admin/inbox.ts:102-117`). No snooze or mark-read exists despite the June design describing those as retained capabilities (`docs/superpowers/specs/2026-06-12-ui-supervision-revamp-design.md:67`).

### App registry — `/admin/registry`

**Shows.** App table with owner, repo, open requests, provisioning mode, plus create/edit side panel (`apps/console/src/app/admin/registry.ts:20-109`).

**Endpoints.** Store `GET /api/apps`; create `POST /api/apps`; update `PATCH /api/apps/{id}` (`apps/console/src/app/admin/registry.ts:112-154`; `api/app/routers/registry.py:20-55`).

**State/events.** Reads `AppEntry` fields; no progress events. `unread` is derived by the backend app projection, while edit form includes `muted`/provisioning state (`apps/console/src/app/admin/registry.ts:117-146`).

**Refresh.** Store refresh after Poll version; create/update explicitly nudges Poll (`apps/console/src/app/admin/registry.ts:148-154`).

**UX.** Side panel and Escape handling are implemented. Repo field always displays “verified” without an endpoint or validation result, which is misleading (`apps/console/src/app/admin/registry.ts:78-87`). Text says changing an app feeds “1 channel” regardless of actual channel cardinality (`apps/console/src/app/admin/registry.ts:90-98`).

### Settings — `/admin/settings`

**Shows.** Notification matrix, digest time, and persisted Theme choice (`apps/console/src/app/admin/settings.ts:18-118`).

**Endpoints.** None. Theme persistence is client-side shared Theme behavior; notification settings and digest time are component memory only.

**State/events.** Local `prefs`, `digest`, and `digestOpen`; rows describe gate, needs-human, and progress event classes (`apps/console/src/app/admin/settings.ts:121-167`). No backend notification model is read or written.

**Refresh.** None.

**UX.** The page permanently shows “Preview” and “Saved” while explicitly persisting nothing (`apps/console/src/app/admin/settings.ts:12-24`). Locked in-app toggles communicate a policy that has no server enforcement (`apps/console/src/app/admin/settings.ts:46-75,134-162`).

## 3. Endpoint-to-surface mapping

| Endpoint                                     | Router evidence                        | Console consumers                                         |
| -------------------------------------------- | -------------------------------------- | --------------------------------------------------------- |
| `GET /api/health`                            | `api/app/routers/system.py:23-33`      | Shell runner badge                                        |
| `POST /api/simulator/tick`                   | `api/app/routers/system.py:35-39`      | Shell command palette                                     |
| `GET /api/apps`                              | `api/app/routers/registry.py:20-35`    | Store → shell, Feed, Registry                             |
| `POST /api/apps` / `PATCH /api/apps/{id}`    | `api/app/routers/registry.py:37-55`    | Registry                                                  |
| `GET /api/requests`                          | `api/app/routers/requests.py:235-257`  | Store → Map, List, Feed, shell-derived state              |
| `GET /api/requests/{id}`                     | `api/app/routers/requests.py:260-284`  | Queue, Request detail                                     |
| `POST /api/requests/{id}/steer`              | `api/app/routers/requests.py:521-532`  | Mission control                                           |
| `POST /api/requests/{id}/approve`            | `api/app/routers/gates.py:26-74`       | Mission, Queue, Request detail                            |
| `POST /api/requests/{id}/send-back`          | `api/app/routers/gates.py:77-95`       | Mission, Queue, Request detail                            |
| `POST /api/requests/{id}/cancel`             | `api/app/routers/gates.py:117-131`     | Queue, Request detail                                     |
| `POST /api/requests/{id}/retry`              | `api/app/routers/gates.py:134-157`     | Mission, Queue, Request detail                            |
| `GET /api/events/cursor` / `GET /api/events` | `api/app/routers/events.py:50-69`      | Global Poll service; Feed delta merge                     |
| `GET /api/subjects/{key}/feed`               | `api/app/routers/events.py:72-89`      | Per-app Feed                                              |
| `GET /api/requests/{id}/trace`               | `api/app/routers/events.py:92-107`     | Request detail                                            |
| `POST /api/requests/{id}/comments`           | `api/app/routers/events.py:111-124`    | Feed, Request detail                                      |
| `GET /api/inbox`                             | `api/app/routers/events.py:133-142`    | Store → shell badges, Queue, Needs me                     |
| `GET /api/mission`                           | `api/app/routers/mission.py:20-49`     | Mission control, Factory map                              |
| attachment upload/list/delete                | `api/app/routers/attachments.py:18-48` | No console mutation surface; Intake owns upload lifecycle |
| `GET /api/attachments/{id}/raw`              | `api/app/routers/attachments.py:50-58` | Request detail links/thumbnails                           |

## 4. As-built supervision model

### Append-only two-axis rail

- `progress_event` is one append-only source keyed by both request and app/subject; request trace and app feed are fan-out-on-read projections (`docs/adr/0008-two-axis-progress-event-log.md:6-18`).
- Event reads use `id` keyset cursors; the same cursor is the polling/SSE seam (`docs/adr/0008-two-axis-progress-event-log.md:29-36`).
- Step detail is allowed only as completed-step summaries, never tokens/streaming/heartbeats (`docs/adr/0014-step-level-trace-events.md:19-27`).
- Consumption of a steer note is derived from a later step payload’s `acked_steer_ids`; no historical row is updated (`api/app/supervision.py:1-7,58-69`).

### Derived run state

- A request is in flight only when `status == approved`, stage is a pipeline stage, and `needs_human == false` (`api/app/supervision.py:24-28`).
- Latest `step_summary` is restricted to the current stage and ignored if older than `stage_entered_at`, which prevents retry attempts from leaking into the current run (`api/app/supervision.py:31-46`).
- No step event yields `step: 0`, plan length, `label: null`, and `health: no_signal`; an event yields healthy/slow from elapsed time and `RUN_SLOW_AFTER_SECONDS` (`api/app/supervision.py:45-55`).
- Escalation is represented separately by `needs_human`; “slow/no signal” is not falsely called stalled (`docs/adr/0014-step-level-trace-events.md:28-30`).

### Evidence model

- Spec gate evidence: grounded line count, total lines, answered interview count, assumptions (`api/app/supervision.py:76-82`).
- Merge gate evidence: latest `verification` payload’s tests, diff, changed files, reviewer verdict, assumptions (`api/app/supervision.py:83-97`).
- Missing verification remains `null` and is visibly renderable as “no evidence recorded”; approval is not blocked solely for legacy missing evidence (`api/app/supervision.py:72-75`; `packages/shared/src/lib/models.ts:232-235`).
- The real runner is stricter before raising a merge gate: zero tests or zero changed files escalates rather than presenting false evidence (`api/app/agent_runner.py:300-311`).

### Gate semantics

- Spec gate approval atomically changes pending approval → approved/architecture, records actor, writes gate event/audit, and starts the real runner once (`api/app/routers/gates.py:41-74`).
- Spec send-back returns work to the submitter, clears escalation state, stores the question, emits a gate event, and records actor (`api/app/routers/gates.py:77-95`).
- Merge approval is the irreversible boundary: runner-specific merge/deploy path executes; a failed real merge escalates instead of reporting done (`api/app/routers/gates.py:30-40`; `api/app/agent_runner.py:317-337`).
- Retry clears escalation and re-runs the same stage; real agent mode explicitly restarts the pipeline thread (`api/app/routers/gates.py:134-157`).
- Cancel wins over later runner escalation and prevents a late review from raising a merge gate (`api/app/agent_runner.py:177-186,294-297`).

### Event taxonomy: emitters and renderers

The persisted API contract contains exactly eight kinds (`api/app/models.py:206-219`; `packages/shared/src/lib/models.ts:183-203`).

| Event kind          | Current emitters                                                                                                                                                                                                            | Mission/Map                                                 | Request detail                                    | Per-app Feed        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------- | ------------------- |
| `milestone_summary` | submit/respond, agent stage completions, simulator milestones/stage advances, deploy (`api/app/routers/requests.py:495-508`; `api/app/agent_runner.py:208-310`; `api/app/simulator.py:81-92`; `api/app/lifecycle.py:33-34`) | Indirect cursor refresh only                                | Generic/check trace row                           | Rendered            |
| `gate_event`        | spec draft/approval/send-back, merge-gate raise/approval (`api/app/routers/requests.py:508`; `api/app/routers/gates.py:66-92`; `api/app/lifecycle.py:15-34`)                                                                | Indirect; gate state/evidence comes from request projection | Special gate row                                  | Rendered/broadcast  |
| `escalation`        | startup orphan recovery and real runner failures (`api/app/startup.py:40-49`; `api/app/agent_runner.py:177-186`)                                                                                                            | Indirect; stalled band uses `needs_human`                   | Flag row                                          | Rendered            |
| `recovery_action`   | cancel and retry (`api/app/routers/gates.py:117-150`)                                                                                                                                                                       | Indirect cursor refresh                                     | Generic row                                       | Rendered            |
| `comment`           | comment endpoint/backfill (`api/app/routers/events.py:111-124`; `api/app/startup.py:22-33`)                                                                                                                                 | Indirect cursor refresh                                     | Generic trace row plus duplicate comments section | Rendered            |
| `step_summary`      | simulator only in current runtime paths (`api/app/simulator.py:69-78`)                                                                                                                                                      | Powers run state                                            | Detailed step/why/ack row                         | Explicitly excluded |
| `verification`      | simulator and real agent runner (`api/app/simulator.py:42-66`; `api/app/agent_runner.py:298-311`)                                                                                                                           | Powers merge evidence                                       | Check row                                         | Explicitly excluded |
| `steer_note`        | steer endpoint, any runner mode (`api/app/routers/requests.py:521-532`)                                                                                                                                                     | Mission shows only local queued chip                        | Special queued/honored row                        | Explicitly excluded |

## 5. Deferred-gap verification

| Known gap                                   | Status               | Current evidence and exact boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approver identity missing on Request detail | **CONFIRMED**        | Actor is persisted in `gate_event` and `AuditEvent` (`api/app/routers/gates.py:66-70`; merge actor at `api/app/lifecycle.py:23-34`). Detail API returns audit rows (`api/app/routers/requests.py:260-268`), but UI ignores `r.audit`; `whoLine()` never computes “decided by” and falls back to filed-by after completion (`apps/console/src/app/admin/request-detail.ts:761-768`). Trace gate title can incidentally contain the actor, but no stable decided-by field is rendered.                                                                                                                                                                                                                                             |
| Real runner emits no `step_summary`         | **CONFIRMED**        | All real stage success emissions are `milestone_summary`; failure is `escalation`; review also emits `verification`/merge `gate_event` (`api/app/agent_runner.py:193-313`). No real-stage `step_summary` exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Real runner emits no `verification`         | **FIXED**            | Real review builds and validates a verification payload, emits it, then raises merge gate (`api/app/agent_runner.py:298-313`). Shared verification writer is explicit (`api/app/verification.py:117-139`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Real runner emits/acks no `steer_note`      | **PARTIALLY FIXED**  | API accepts and appends steer notes for any in-flight mode (`api/app/routers/requests.py:521-532`). Only simulator queries pending notes and adds `acked_steer_ids` (`api/app/simulator.py:69-78`); real runner never calls `pending_steer_notes`. Thus notes are recorded but not consumed.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Take-over endpoint absent                   | **CONFIRMED**        | No router declares take-over; Request detail source marks it “not built” (`apps/console/src/app/admin/request-detail.ts:95`). Current gate router exposes only approve, send-back, respond, cancel, retry (`api/app/routers/gates.py:26-157`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Send-back-to-stage endpoint absent          | **CONFIRMED**        | Existing `/send-back` only accepts spec/submitted state and sends work to the submitter (`api/app/routers/gates.py:77-95`). It cannot return an escalated architecture/build/review run to a prior stage; Request detail marks that recovery verb unbuilt (`apps/console/src/app/admin/request-detail.ts:95`).                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Dead tokens / unused state fields           | **CONFIRMED**        | Console tokens `--a800`, `--r-sm`, `--dur-i`, and `--hero-grad` are defined but have no `var(...)` consumer in console/shared source (`apps/console/src/styles.css:66,96,109,113`). Conversely `var(--fg-faint)` is used with no definition (`apps/console/src/styles.css:1087`). `FactoryRequest.labels`, `priority`, and the detail `audit` payload survive in shared models but are not rendered by current console surfaces (`packages/shared/src/lib/models.ts:53-98,110-120`); detail explicitly claims labels are gone (`apps/console/src/app/admin/request-detail.ts:29-32`). Settings notification/digest state is intentionally non-persistent preview state (`apps/console/src/app/admin/settings.ts:12-14,121-167`). |
| Route naming oddities                       | **CONFIRMED**        | IA says Gates at `/admin/gates`, implementation remains `/admin/queue` (`docs/superpowers/specs/2026-06-12-ui-supervision-revamp-design.md:63-67`; `apps/console/src/app/app.routes.ts:29-33`). “Activity” is routed as `/admin/apps/:key` and component/class remains Feed (`apps/console/src/app/app.routes.ts:39-43`). Needs-me active key is `needsme` while URL is `/admin/inbox` (`apps/console/src/app/admin/inbox.ts:13`; `apps/console/src/app/app.routes.ts:44-48`). Factory-map shortcut is `G O`, not mnemonic `G M` because Mission already owns M (`apps/console/src/app/admin/admin-shell.ts:304-310`).                                                                                                           |
| Map-to-List filtering                       | **CONFIRMED BROKEN** | Map navigates with stage/state query parameters, but List reads only Store and defines no route/query handling (`apps/console/src/app/admin/map.ts:1068-1073`; `apps/console/src/app/admin/list.ts:86-95`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Runner-mode badge                           | **CONFIRMED BROKEN** | Health reports backend runner mode, while shell treats only the impossible value `claude` as real and otherwise says simulated (`api/app/routers/system.py:23-32`; `apps/console/src/app/admin/admin-shell.ts:129-139`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 6. Multi-operator hazards (2–5 operators)

1. **No server-backed operator identity.** Every fresh browser defaults to the same hard-coded Kim P. identity; arbitrary user JSON is stored only in localStorage (`apps/console/src/app/core/session.service.ts:5-28`). Audit actors therefore cannot reliably distinguish people.
2. **No authentication/authorization boundary.** `adminGuard` sees the local mock admin by default; actor strings supplied by clients are trusted by mutation endpoints (`apps/console/src/app/core/session.service.ts:13-25`; `api/app/routers/gates.py:26-29`).
3. **No claim/reservation verb or state.** Inbox and Mission say “waiting on you” to every operator. There is no `claimed_by`, lease, review-presence, or claim endpoint in schemas/routers (`api/app/schemas.py:100-172`; `api/app/routers/gates.py:23-157`). Two people can simultaneously investigate and compose different decisions.
4. **Spec approval avoids duplicate execution but not misleading attribution.** Atomic update ensures one pipeline start, but the losing concurrent approve returns the already-approved row without reporting who won; only the winner’s actor is recorded (`api/app/routers/gates.py:52-70`).
5. **Merge approval lacks the same compare-and-set claim.** Both callers can enter runner-specific merge logic based on a stale gate snapshot; real git merge may serialize/fail and escalate, but there is no explicit database claim before side effects (`api/app/routers/gates.py:26-40`; `api/app/agent_runner.py:317-337`).
6. **Send-back, cancel, and retry are read-then-write transitions.** They validate current status/flag but do not use version/ETag/compare-and-set updates; concurrent actions can overwrite one another or produce surprising 409s after another operator acts (`api/app/routers/gates.py:77-157`).
7. **Most action errors disappear.** Mission approve/send-back/retry subscribe only to success; Request detail mutations likewise omit error handlers (`apps/console/src/app/admin/mission.ts:607-622`; `apps/console/src/app/admin/request-detail.ts:797-827`). A stale operator can click, see no explicit explanation, and wait for polling.
8. **Local optimism is not shared truth.** Mission’s `steered` Set is local to one component/browser and never cleared from acknowledged events (`apps/console/src/app/admin/mission.ts:552-589`). Other operators see neither pending ownership nor the chip.
9. **Polling is event-coupled, not row-version-coupled.** Cross-browser projection refresh happens only when a progress event arrives. Any state mutation without an event is invisible until another event; registry changes are the clearest example because create/update nudges only the initiating browser and registry router emits no progress event (`apps/console/src/app/admin/registry.ts:148-154`; `api/app/routers/registry.py:37-55`).
10. **Whole-projection re-fetches can reorder focus under an operator.** Queue, Mission, Inbox, Map, and Detail refresh from independent requests after a version bump. There is no snapshot cursor/version tying `/api/mission`, `/api/inbox`, `/api/requests`, and detail together (`packages/shared/src/lib/poll.service.ts:41-61`; `apps/console/src/app/core/store.service.ts:22-28`).
11. **Map combines two asynchronous snapshots.** Request columns and mission step overlays can temporarily disagree, especially when a run reaches a gate between responses (`apps/console/src/app/admin/map.ts:979-1003`).
12. **Feed comment targeting is implicit.** The composer selects an active/first request rather than requiring a visible thread selection, risky when multiple operators discuss several requests in one app (`apps/console/src/app/admin/feed.ts:334-344,489-493`).
13. **No notification preference persistence or per-operator read model.** Settings are local preview only, and `App.unread`/Needs me are not viewer-specific (`apps/console/src/app/admin/settings.ts:12-14`; `apps/console/src/app/admin/inbox.ts:79-84`). “Unread” and “needs me” cannot be truthful for multiple people.
14. **Single-worker is load-bearing.** The background tick/pipeline and SQLite writer model assumes one uvicorn worker; multi-operator work must add coordination without proposing horizontal API replicas under the current architecture (repo `AGENTS.md:60-62`; `AGENTS.md:107-110`).

## 7. Current surfaces and feeds

| Surface          | Route                 | Primary feeds                                             | Direct event kinds rendered                    | Mutations/actions                                   |
| ---------------- | --------------------- | --------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| Admin shell      | structural            | `/api/requests`, `/api/apps`, `/api/inbox`, `/api/health` | none                                           | simulator tick, navigation, theme, intake deep-link |
| Mission control  | `/admin/mission`      | `/api/mission`                                            | none directly; derived from step/verification  | approve, send back, retry, steer                    |
| Factory map      | `/admin/map`          | `/api/requests` + `/api/mission`                          | none                                           | drill-down only                                     |
| All requests     | `/admin/list`         | `/api/requests`                                           | none                                           | drill-down only                                     |
| Gates            | `/admin/queue`        | `/api/inbox` + selected `/api/requests/{id}`              | none                                           | approve, send back, retry, cancel                   |
| Request detail   | `/admin/requests/:id` | detail + trace + raw attachments                          | all eight; several generic                     | approve, send back, retry, cancel, comment          |
| Per-app Activity | `/admin/apps/:key`    | Store + subject feed + Poll delta                         | milestone, gate, escalation, recovery, comment | comment                                             |
| Needs me         | `/admin/inbox`        | `/api/inbox`                                              | none                                           | handoff to Gates                                    |
| Registry         | `/admin/registry`     | `/api/apps`                                               | none                                           | create/update app                                   |
| Settings         | `/admin/settings`     | local state only                                          | none                                           | local preview toggles/theme                         |

## 8. Candidate additive backend gaps for the redesign

| Candidate                                 | Why it is needed                                                                                                                                                                           | Current pointers                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable gate-decision projection           | Expose `decided_by`, decision time, gate, and outcome without parsing titles or scanning generic audit rows; preserve append-only events.                                                  | Actor exists in `api/app/routers/gates.py:66-70`; UI gap at `apps/console/src/app/admin/request-detail.ts:761-768`.                                        |
| Authenticated operator identity storage   | Replace caller-supplied/localStorage actor strings so audit, claims, comments, and steer notes identify real people.                                                                       | Mock at `apps/console/src/app/core/session.service.ts:5-28`; trusted actor at `api/app/routers/gates.py:26-29`.                                            |
| Gate/recovery claim API                   | Short lease/claim with claimant and expiry would prevent duplicate review and make “waiting on” truthful; do not mutate historical events—claims belong in separate current-state storage. | No claim schema/endpoints in `api/app/schemas.py:100-172` or `api/app/routers/gates.py:23-157`.                                                            |
| Atomic merge-gate claim                   | Protect irreversible merge/deploy side effects with the same explicit one-winner pattern used for spec approval.                                                                           | Spec CAS at `api/app/routers/gates.py:52-63`; merge path at `api/app/routers/gates.py:30-40`.                                                              |
| Real-runner `step_summary` adapter        | Make real runs first-class in Mission/trace and provide honest health/progress rather than permanent no-signal.                                                                            | Contract at `docs/adr/0014-step-level-trace-events.md:31-32`; missing in `api/app/agent_runner.py:193-313`.                                                |
| Real-runner steer consumption/ack         | Read pending notes at safe stage/step boundaries and write ack IDs in a new step summary; never update steer rows.                                                                         | Derived contract at `api/app/supervision.py:58-69`; simulator model at `api/app/simulator.py:69-78`.                                                       |
| Take-over endpoint/state                  | Required recovery choice when automation stalls; must define ownership, cancellation of active runner work, and audit event.                                                               | Explicitly absent at `apps/console/src/app/admin/request-detail.ts:95`.                                                                                    |
| Send-back-to-stage endpoint               | Allow a human to return architecture/build/review to a defined earlier stage with reason and fresh stage clock, distinct from submitter send-back.                                         | Existing endpoint is spec-only at `api/app/routers/gates.py:77-95`.                                                                                        |
| Projection revision/cursor contract       | Let clients detect consistent snapshots and stale actions across mission/inbox/requests/detail without changing event history.                                                             | Independent polling at `packages/shared/src/lib/poll.service.ts:41-61`; mission cursor exists but is unused by page at `api/app/routers/mission.py:48-49`. |
| Conditional mutation/version checks       | Return explicit conflict details (`acted_by`, resulting state) for stale approve/send-back/retry/cancel actions.                                                                           | Current 409/idempotent behavior at `api/app/routers/gates.py:41-63,77-157`.                                                                                |
| Per-operator inbox/read/preferences model | Make “Needs me,” unread, notification routing, and digest settings meaningful for 2–5 humans. Keep this separate from append-only progress history.                                        | Shared inbox at `api/app/routers/events.py:133-142`; preview-only settings at `apps/console/src/app/admin/settings.ts:12-14`.                              |
| Registry change signal                    | Ensure other browsers refresh registry changes, via a separate revision stream or an additive typed event that respects the rail’s domain boundary.                                        | Local-only nudge at `apps/console/src/app/admin/registry.ts:148-154`; registry writes emit no event at `api/app/routers/registry.py:37-55`.                |

## 9. Load-bearing vs disposable

### Load-bearing; keep and deepen

- Request lifecycle, two human gates, escalation/retry/cancel semantics, and honest merge failure behavior (`api/app/routers/gates.py:26-157`; `api/app/agent_runner.py:317-337`).
- Append-only, two-axis `progress_event`, cursor reads, and feed-vs-trace firehose boundary (`docs/adr/0008-two-axis-progress-event-log.md:6-18,29-43`; `api/app/routers/events.py:26,72-107`).
- Derived run state, evidence derivation, and derived steer acknowledgment; these are clean read models that avoid mutable duplicated truth (`api/app/supervision.py:31-98`).
- Mission aggregate’s four semantic buckets and Request detail’s trace as the core operator mental model (`api/app/routers/mission.py:20-49`; `docs/adr/0015-supervision-first-console.md:12-23`).
- Atomic one-winner spec approval and the single-worker-aware pipeline boundary (`api/app/routers/gates.py:52-74`; `api/app/agent_runner.py:131-170`).
- Shared API/Poll seam is worth retaining, but should evolve toward consistent delta/read models rather than automatic full re-fetch (`packages/shared/src/lib/poll.service.ts:6-22`).

### Disposable or redesignable

- Current route names, sidebar grouping, duplicated Gates/Needs-me navigation, and tracker residue (“queue,” “issue,” Feed class naming).
- Factory map’s cockpit styling and 1,200-line single component; the spatial lens may survive, but its visual exception and interaction debt are not foundational (`docs/adr/0016-factory-map-spatial-lens-and-cockpit-exception.md:12-33,46-54`).
- Grouped All requests implementation, non-persistent Settings preview, fake registry verification, and browser-local identity.
- Local optimistic chips and success-only subscriptions; replace with server-acknowledged operation state and actionable conflict feedback.
- Shell-wide full projection refresh on every event. Keep cursor polling and append-only events, but redesign consumer projections for bounded deltas and snapshot consistency.

**Bottom line:** preserve the domain seams and event/gate invariants; treat almost all present information architecture, route vocabulary, view composition, local identity, and refresh behavior as replaceable. The redesign’s highest-value backend work is additive supervision fidelity and multi-operator coordination, not a rewrite of the lifecycle or the event log.
