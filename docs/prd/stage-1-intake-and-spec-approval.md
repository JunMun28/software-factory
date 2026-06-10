# PRD — Stage 1: Intake & Spec Approval (the Factory front door)

> Scope: the web-app front door and the in-app Spec-approval slice of the Software Factory.
> Boundary: ends the moment the **Stage 2 trigger fires** (an approved `SPEC.md` committed to a
> fresh branch + PR). Stages 2–6 are out of scope. Uses the [CONTEXT.md](../../CONTEXT.md)
> glossary and respects ADRs [0001](../adr/0001-copilot-first-ci-enforced-factory.md),
> [0002](../adr/0002-pr-centric-orchestration.md), [0003](../adr/0003-draft-spec-staged-in-db-until-approval.md),
> [0005](../adr/0005-control-center-acts-through-github-and-protected-branch-deploy.md),
> [0006](../adr/0006-stages-are-resumable.md), [0007](../adr/0007-web-app-stack.md).

## Problem Statement

People across the org need software work done — a **bug fix**, an **enhancement**, or a whole
**new app** — but there is no good front door for asking. Non-technical requesters don't use
GitHub and can't write a spec, so requests arrive vague and inconsistent, and engineering burns
time chasing clarifications. Admins who triage incoming work have nowhere to see everything that's
been asked, no consistent description to judge, and no controlled, traceable way to say "yes,
build this" that actually kicks the work off.

## Solution

A web app that is the Factory's front door. A **Submitter** logs in with their company account
(Microsoft SSO), picks a request type, and describes what they want in plain language. An AI
**Intake interview** asks a few clarifying follow-ups while they're still there, then writes a
**Draft spec**. The Request is saved and a GitHub Issue is opened automatically. An **Admin**
reviews the Draft spec in the **Control center**, then **Approves** or **Sends back**. Approval
automatically sets up the work in GitHub — creating the repo for a new app, writing `SPEC.md` to a
fresh branch + PR, and firing the Stage 2 trigger — or sends it back for more info. Submitters
track their Request's status without ever touching GitHub.

## User Stories

1. As a Submitter, I want to log in with my company Microsoft account, so that I don't need a new password or a GitHub account.
2. As a Submitter, I want to choose whether my Request is a bug fix, an enhancement, or a new app, so that the form asks me the right things.
3. As a Submitter filing a bug fix or enhancement, I want to pick which existing app it's about from a dropdown, so that I don't need to know any repo names.
4. As a Submitter, I want to give a short title and a description in my own words, so that I can explain what I need quickly.
5. As a Submitter filing a bug, I want to describe what happens now versus what I expect, so that the problem is clear.
6. As a Submitter, I want to optionally attach a screenshot or link, so that I can add detail without writing more text.
7. As a Submitter filing a new app, I want to say what problem it solves and who will use it, so that the request captures intent, not just features.
8. As a Submitter, I want to set how urgent it is, so that admins can prioritize.
9. As a Submitter, I want an AI to ask me a few quick follow-up questions right after I submit, so that I can fill gaps while it's fresh instead of being chased later.
10. As a Submitter, I want the follow-up questions to stop after a few (not interrogate me), so that submitting stays quick.
11. As a Submitter, I want my identity (name/email) taken from my login, so that I don't have to type who I am.
12. As a Submitter, I want a confirmation that my Request was received, so that I know it went through.
13. As a Submitter, I want to see a list of my own Requests and their status, so that I know what's happening without asking anyone.
14. As a Submitter, I want to see status in plain stages (Submitted → Spec drafted → Approved → Building → In review → Deployed, or Needs a human), so that I understand progress without GitHub.
15. As a Submitter, I want to be notified when my Request is approved or sent back, so that I can respond if more info is needed.
16. As an Admin, I want every submitted Request to appear in a Control center, so that nothing falls through the cracks.
17. As an Admin, I want Requests laid out on a Kanban board with stage columns, so that I can see where each one is at a glance.
18. As an Admin, I want a clear "Approve spec" badge on Requests waiting for me, so that I know which ones need my action.
19. As an Admin, I want to filter the board to "waiting on me", so that I can focus on my queue.
20. As an Admin, I want to read the AI's Draft spec for a Request, so that I can judge whether to build it.
21. As an Admin, I want to see the original Request and the interview answers alongside the Draft spec, so that I have full context.
22. As an Admin, I want to Approve a Draft spec, so that the Factory starts building it.
23. As an Admin, I want to Send back a Request with a note, so that the Submitter can clarify or correct it.
24. As an Admin, I want approval of a new-app Request to automatically create its GitHub repo and register it, so that I don't set up repos by hand.
25. As an Admin, I want approval of an existing-app Request to use the right repo, so that the work lands in the correct codebase.
26. As an Admin, I want approval to write the approved spec as `SPEC.md` on a fresh branch + PR, so that the Work item is created consistently and traceably.
27. As an Admin, I want approval to trigger Stage 2 (Architecture), so that the pipeline continues without manual steps.
28. As an Admin, I want no repo or PR created for a Request I haven't approved, so that rejected/unreviewed requests don't litter GitHub.
29. As an Admin, I want to manage the App registry (add/edit which app maps to which repo and owner), so that the Submitter dropdown stays accurate.
30. As an Admin, I want an audit record of who approved or sent back each Request and when, so that decisions are traceable.
31. As an Admin, I want the board to update on its own (without manual refresh), so that I see current state.
32. As an Admin, I want to see the GitHub Issue link for a Request, so that I can dig in if needed.
33. As a Submitter, I want my Request and its enriched answers stored, so that the Draft spec reflects everything I said.
34. As an Admin, I want the Draft spec to live in the app until I approve it, so that I can review and send back without half-built repos existing.
35. As a platform owner, I want all Request Issues to live in one Factory control repo, so that even new-app Requests (with no app repo yet) have a home.
36. As a platform owner, I want the web app to talk to GitHub through a single Factory App identity, so that there's one integration to install and audit.
37. As a Submitter, I want the form to be quick on mobile and desktop, so that I can file from anywhere.
38. As an Admin, I want a Cancel option on a Request, so that I can abandon work that shouldn't proceed and notify the Submitter.

## Implementation Decisions

**Architecture & boundaries**
- The Stage 1 AI (Intake interview + Draft spec) runs **inside the web app** as direct LLM calls — not as a Copilot/CI agent — because the Submitter is waiting and, for a new app, no repo exists yet (ADR 0007).
- The **Draft spec lives in the database** until Spec approval; approval is the bridge that creates/selects the repo, writes `SPEC.md`, and fires Stage 2 (ADR 0003).
- **Submit-time vs approve-time side effects** are distinct: on submit (after the interview) the app saves the enriched Request and **creates a GitHub Issue** in the Factory control repo; on **Approve** the app **creates the repo if new**, registers it, **writes `SPEC.md` to a fresh branch + PR** (the Work item is born), and **fires the Stage 2 trigger**.
- The Factory **Builder bot** (one GitHub App, installation token) performs all GitHub writes (issue, repo, branch, PR commit). Admin GitHub-identity linking is **not** needed in Stage 1 because Spec approval is an in-app action, not a GitHub gate (that comes at merge/deploy, out of scope).

**Modules (deep, isolated interfaces)**
- `LLMClient` — `complete(messages) → text`. The swap-later seam: OpenAI raw now, corporate wrapped LLM later, configurable base URL/key/model. Nothing else knows the provider (ADR 0007).
- `IntakeInterview` — `next(request, history) → { questions } | done`. Owns all interview prompting and the "stop after ~3–4 / when enough" logic. Wraps `LLMClient`.
- `DraftSpecGenerator` — `generate(request) → DraftSpec`. Turns an enriched Request into a structured Draft spec. Wraps `LLMClient`.
- `RequestLifecycle` — pure state machine. States: `Draft → Submitted → PendingApproval → (Approved | SentBack | Cancelled)`. Each transition declares its side-effect intents (e.g. `Submitted` → create issue; `Approved` → ensure repo + write SPEC.md PR + fire Stage 2). No I/O; returns intents that the orchestration layer executes.
- `AppRegistry` — `list()`, `resolve(appName) → repo`, `register(app) → repo`. Backs the form dropdown and resolves the Subject repo.
- `GitHubGateway` — `createIssue()`, `createRepo()`, `openSpecPr()`. Wraps the Factory App. Idempotent where possible (re-running Approve must not create duplicate repos/PRs — supports resumability, ADR 0006).
- `RequestRepository` — persistence for Requests, interview answers, Draft specs, status history, and audit. SQLAlchemy; stays DB-agnostic for the SQLite → MSSQL swap (ADR 0007).
- `Auth` — resolves an incoming request to `{ user, role }` via Microsoft SSO (Entra); roles are `Submitter` and `Admin`.

**Thin glue (not isolated):** FastAPI routes (submit, interview step, list-my-requests, admin list-pending, approve, send-back, cancel, app-registry CRUD); a webhook receiver that records "issue created" confirmation. Routes delegate to the modules above.

**Schema (conceptual, not literal columns)**
- `Request`: id, submitter (from Auth), type (`bug | enhancement | new_app`), title, description, type-specific fields, urgency, target app (nullable for new app), status, timestamps.
- `InterviewTurn`: request_id, question(s), answer, order.
- `DraftSpec`: request_id, content, version.
- `AppRegistryEntry`: name, repo, owner.
- `AuditEvent`: request_id, actor, action (`approved | sent_back | cancelled`), note, timestamp.
- `Request` carries the GitHub Issue ref after submit, and the Work item (branch/PR) ref after approval.

**API contracts (shape, not paths)**
- Submit returns the created Request id and kicks off the interview.
- Interview step accepts the current answer and returns either the next question(s) or `done` + the generated Draft spec.
- Admin approve/send-back/cancel take a Request id (+ note) and return the new status; approve additionally returns the Work item PR ref once created.

**Frontend (Angular)**
- Intake form with a type selector that reveals conditional fields.
- Interview chat panel (real-time within the submit flow).
- Submitter "my Requests" status view.
- Control center: approval queue + Intake/Spec board columns, with Approve / Send-back (+ note) / Cancel; board updates by **polling** (~3–5s; SSE later, ADR 0007).

## Testing Decisions

**What makes a good test here:** exercise **external behavior** through a module's public
interface, not its internals. Mock at the **seams** (`LLMClient`, `GitHubGateway`) so tests are
deterministic and offline; never assert on prompt strings or HTTP call internals — assert on the
decisions and outputs the module produces.

**Modules to test (confirmed):**
- `RequestLifecycle` — the highest-value target. Pure state machine: assert valid transitions, rejected illegal transitions, and the **side-effect intents** each transition emits (e.g. Approve on a new-app Request emits create-repo + write-SPEC.md + fire-Stage-2; Approve on an existing-app Request emits use-repo, not create-repo). No mocks needed.
- `IntakeInterview` — with a stubbed `LLMClient`: asks follow-ups, **stops at the cap / when enough**, and folds answers into the Request.
- `DraftSpecGenerator` — with a stubbed `LLMClient`: produces a Draft spec from an enriched Request; behavior around missing fields.
- `AppRegistry` — resolve known app → repo, unknown app handling, register new app returns a repo and makes it resolvable.
- `GitHubGateway` — against a mocked GitHub API: creates issue/repo/PR with the right inputs, and is **idempotent** on re-run (Approve twice must not duplicate) to support resumability.

**Not tested:** the thin FastAPI route/glue layer and the Angular view components (behavior lives in the modules; routes are wiring).

**Prior art:** greenfield repo — this PRD establishes the pytest + mocked-seam pattern (uv-managed, per the global toolchain) that later stages will follow.

## Out of Scope (TODO — future grilling sessions)

- Stages 2–6 of the Factory engine (Architecture, Test authoring, Implementation, Review, Deploy).
- Control-center features tied to later stages: Progress timeline, Code-change view, and Recovery actions (Retry / Send-back-to-stage / Take-over / Cancel mid-build) for build failures.
- Merge gate and Deploy gate (protected-branch approvals) and **admin GitHub-identity linking**.
- Notifications routing (who gets pinged when) — beyond the basic "approved / sent back" notice to the Submitter.
- Admin permission tiers (e.g. who may approve prod deploys vs specs).
- SSE live-push (Stage 1 uses polling).
- Migration to the corporate wrapped LLM and to Azure SQL/MSSQL (the seams exist; the swap itself is later).

## Further Notes

- Two swap-later seams are load-bearing and must be respected from day one: data access behind
  `RequestRepository`/SQLAlchemy (SQLite → MSSQL) and all model calls behind `LLMClient`
  (OpenAI → corporate). See ADR 0007.
- Resumability (ADR 0006): Approve and the GitHub writes must be safe to re-run on the same
  Request without creating duplicates — this is why `GitHubGateway` is specified idempotent.
- The verified GitHub mechanics (which approvals count, why deploy uses a protected branch) live in
  ADR 0005 and are only relevant to later stages, but are noted so Stage 1's GitHub App is created
  with the right permission set (administration, contents, pull-requests, checks, deployments).

## Post-review hardening (applied — top 8)

Adopted from the review brief ([stage-1-review-enhancements.md](stage-1-review-enhancements.md)).
These operationalize the locked ADRs (especially resumability, ADR 0006) and close security/UX
gaps; none reopens a decision. They amend the sections named below.

1. **New module `RequestOrchestrator` (tested).** The executor that runs `RequestLifecycle`'s
   emitted intents moves out of "thin glue" into a named module sitting between the FastAPI routes
   and {RequestLifecycle, GitHubGateway, RequestRepository, AppRegistry}. It owns submit's
   save+ensureIssue and Approve's ordered three steps (ensure repo → write `SPEC.md` PR → fire
   Stage 2), persisting each result; routes keep only HTTP parsing + auth. **Added as a tested module.**
2. **`GitHubGateway` idempotent by Request id.** Rename `createIssue/createRepo/openSpecPr` →
   `ensureIssueFor/ensureRepoFor/ensureSpecPrFor`, keyed on the Request id (issue marker label,
   branch `spec/req-<id>`, repo-by-name). Treat GitHub `422 already exists` as success and adopt
   the resource; surface `403` as a defined permission error. This is the concrete form of ADR
   0006's "safe to re-run." *(amends Modules → GitHubGateway, Testing.)*
3. **Per-step Approve progress ledger.** Replace the single `Approved` flag with
   `repo_ready / spec_pr_open / stage2_fired` markers plus an intermediate `Approving` state; the
   orchestrator persists each before the next, and a re-run skips completed steps. The Issue ref
   and Work-item (branch/PR) ref become first-class columns. *(amends Schema, Submit-vs-approve.)*
4. **Submit = persist-first, then retryable Issue.** Persist the Request first (DB is source of
   truth), then `ensureIssueFor` as a separately-retryable step that writes back the Issue ref
   **captured from the `createIssue` API response** (the webhook is confirmation/reconciliation
   only). A missing Issue never blocks DB-backed admin review. *(amends Submit-time side effects.)*
5. **Webhook security.** The webhook route verifies the `X-Hub-Signature-256` HMAC over the raw
   body (constant-time) and rejects **before any DB write**; dedupes on `X-GitHub-Delivery`
   (unique constraint); responds 2xx fast; subscribes only to `issues`. The webhook receiver is a
   security boundary and is **tested** (promoted out of "thin glue"). *(amends Thin glue, Testing.)*
6. **Server-side authorization + ownership scoping.** Every admin route (approve, send-back,
   cancel, list-pending, app-registry CRUD) enforces `role==Admin` server-side from the **validated
   Entra session** (signature/issuer/audience/expiry; role from a verified claim) — never a client
   field. Every Submitter read is scoped to `submitter == authenticated user` at the
   `RequestRepository` boundary (others → 403/404). *(amends Modules → Auth, Thin glue, US13.)*
7. **SentBack loop, end-to-end.** Add the `SentBack → PendingApproval` transition. Define a
   Submitter "respond to send-back" view that surfaces the admin's note, lets them add/edit info
   (optionally a short re-interview over open slots), regenerates the Draft spec as a new
   `DraftSpec.version`, and returns the card to the queue. Track a send-back round count.
   *(amends Modules → RequestLifecycle, Schema, Frontend, US15/23/33.)*
8. **Grounded Draft spec.** `DraftSpecGenerator` consumes only the structured Request + interview
   turns and tags each line with its source (`(from: Q2)` / `(ASSUMPTION — not stated)`);
   ungrounded content becomes an explicit assumption. Emit a prominent **Open questions /
   Assumptions** section next to Approve/Send-back; a send-back note can target a specific open
   question. *(amends Modules → DraftSpecGenerator, Control center, US20/21.)*

**New / updated user stories**
- As a Submitter, when my Request is sent back, I want to see the admin's note and add the missing info (without touching GitHub), so that it can be re-reviewed.
- As a Submitter, I want to only ever see my own Requests, so that others' submissions stay private.
- As an Admin, I want each Draft-spec claim marked as submitter-stated or an assumption, so that my approval is a grounded check, not a guess.

**Testing additions**
- `RequestOrchestrator` — submit and Approve happy paths; **Approve-replay and partial-failure-replay** (fail after ensureRepo, re-run → resumes; exactly one repo / one PR / one Stage-2 trigger).
- `GitHubGateway` — `422 already exists` adopted as success; `403` as a defined error.
- `RequestLifecycle` — `SentBack → PendingApproval` edge; Submit emits only ensure-Issue (no repo/PR); rejected illegal/duplicate transitions (Approve twice, Approve from SentBack/Cancelled).
- Webhook receiver — rejects bad/missing signature; dedupes a replayed delivery GUID.
