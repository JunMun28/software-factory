# PRD — Stage 1: Request Intake & Spec Approval

> Scope: the Factory's **front door** — from a Submitter's Request through the Intake interview,
> Draft spec, and Admin **Spec approval**, ending the moment the **Stage 2 trigger fires**
> (a `SPEC.md` PR exists on a fresh branch). Stages 2–6 are out of scope.
> Vocabulary follows `CONTEXT.md`; decisions respect ADRs 0001–0007.

## Problem Statement

Anyone in the org — technical or not — needs a way to ask engineering to fix a bug, enhance an
existing app, or build a new app. Today those requests arrive ad hoc and vague: there's no single
front door, no consistent shape, no early sharpening of what's actually wanted, and no clear
"someone said yes, build this" moment before work starts. Non-technical people especially have no
business being in GitHub, yet that's where the work lives. People who submit a request then have no
idea what happened to it.

## Solution

A web app with two faces. **Submitters** sign in with Microsoft SSO and fill a short form (bug fix /
enhancement / new app). An AI **Intake interview** asks a few follow-up questions in the same window
to fill gaps, then an AI writes a **Draft spec**. The Request is saved and a GitHub Issue is opened
in the **Factory control repo**. **Admins** see incoming Requests on a Kanban board, read the Draft
spec in an approval queue, and **Approve** or **Send-back**. Approving — for a new app — creates the
repo and registers it, writes the approved spec as `SPEC.md` on a fresh branch + PR (the **Work
item** is born), and fires the Stage 2 trigger. Submitters watch their Request's status the whole
time without ever touching GitHub.

## User Stories

1. As a Submitter, I want to sign in with my Microsoft account, so that I don't manage another password and the system knows who I am.
2. As a Submitter, I want to start a Request by choosing its type — bug fix, enhancement, or new app — so that I'm only asked relevant questions.
3. As a Submitter raising a bug or enhancement, I want to pick which existing app it's about from a dropdown, so that I don't need to know any repo names.
4. As a Submitter, I want to give a short title and a free-text description, so that I can explain the request in my own words.
5. As a Submitter, I want to set how urgent it is (low / medium / high), so that admins can prioritise.
6. As a Submitter raising a bug, I want to describe what happens now vs. what I expect, so that the problem is clear.
7. As a Submitter, I want to optionally attach a screenshot or link, so that I can add evidence without it being mandatory.
8. As a Submitter requesting a new app, I want to describe the problem it should solve, who will use it, and any must-have features, so that the spec starts from real intent.
9. As a Submitter, I want an AI to ask me a few clarifying questions right after I submit, so that gaps are filled while I'm still here.
10. As a Submitter, I want the follow-up questions to be short and to stop after a few, so that it never feels like an interrogation.
11. As a Submitter, I want my answers folded into my Request automatically, so that I don't repeat myself.
12. As a Submitter, I want a confirmation that my Request was received, so that I know it's in the system.
13. As a Submitter, I want to see a list of my own Requests and their status, so that I can check progress without asking anyone.
14. As a Submitter, I want to see when my Request was approved or sent back, so that I know whether to expect work or to add more detail.
15. As a Submitter whose Request was sent back, I want to see what more is needed and add it, so that it can move forward.
16. As an Admin, I want to sign in with Microsoft SSO and be recognised as an Admin, so that I get the Control center.
17. As an Admin, I want an approval queue of Requests waiting on me, so that I know what needs my decision.
18. As an Admin, I want to read the AI's Draft spec for a Request, so that I can judge whether to build it.
19. As an Admin, I want to see the original Request and the interview answers alongside the Draft spec, so that I have full context.
20. As an Admin, I want to Approve a Draft spec, so that the Factory starts building it.
21. As an Admin, I want to Send-back a Request with a note, so that the Submitter can supply what's missing.
22. As an Admin, I want a Kanban board with Intake and Spec columns, so that I can see all incoming Requests at a glance.
23. As an Admin, I want each card to show its app, type, and owner, so that I can scan the board quickly.
24. As an Admin, I want an "Approve spec" badge on cards waiting for me, so that I can spot my move instantly.
25. As an Admin, I want to filter the board to "waiting on me", so that I can focus.
26. As an Admin, I want to manage the App registry (add an app name → repo mapping), so that the dropdown stays meaningful.
27. As an Admin approving a new-app Request, I want the system to create and register the repo automatically, so that I don't set it up by hand.
28. As an Admin, I want no repo to be created for a Request I haven't approved, so that we don't accumulate orphan repos.
29. As a Submitter or Admin, I want my actions recorded in an audit trail (who submitted, who approved, when), so that decisions are traceable.
30. As the System, I want to create a GitHub Issue in the Factory control repo when a Request is submitted, so that every Request has a durable home even before its app repo exists.
31. As the System, I want to write the approved spec as `SPEC.md` on a fresh branch + PR on approval, so that the Work item is born and Stage 2 can begin.
32. As the System, I want to fire the Stage 2 trigger only after `SPEC.md` is committed, so that downstream stages have a validated artifact to consume.
33. As an Admin, I want the Draft spec to live in the app database until approval (not in a repo), so that new-app Requests work before any repo exists.
34. As a Submitter, I want my Request's status to reflect where it is (Submitted → Spec drafted → Approved / Sent back), so that the state is honest.
35. As an Admin, I want the LLM provider to be swappable, so that we can move from the OpenAI raw API to the corporate wrapped LLM without reworking the app.
36. As an operator, I want to run the whole app locally on SQLite with no Azure or MSSQL, so that development is frictionless.

## Implementation Decisions

- **Two layers** (per ADR 0007): the web app (FastAPI + uv backend, Angular SPA) is the Intake form +
  Control center; GitHub holds the Factory control repo, Subject repos, and the Stage 2+ engine. Stage 1
  is a **web-app feature**, not a CI Copilot agent — its AI runs as direct LLM calls because a user is
  waiting and a new app has no repo yet.
- **Deep modules (built/tested in isolation):**
  - `LLMClient` — single adapter for all LLM calls (`complete(messages) → text`); the OpenAI→corporate
    swap seam. Configurable base URL / key / model.
  - `IntakeInterview` — `next(request, history) → questions | done`; owns the follow-up logic, capped at
    ~3–4 questions; wraps `LLMClient`.
  - `DraftSpecGenerator` — `generate(request) → DraftSpec`; turns an enriched Request into a Draft spec;
    wraps `LLMClient`.
  - `RequestLifecycle` — the Stage 1 **state machine**: `Draft → Submitted → PendingApproval →
    Approved | SentBack | Cancelled`, and which side-effects each transition fires (e.g. Submitted →
    create Issue; Approved → create repo if new app, write `SPEC.md` PR, fire Stage 2 trigger). Pure
    logic, no I/O.
  - `AppRegistry` — `list()`, `resolve(name) → repo`, `register(app) → repo`.
  - `GitHubGateway` — `create_issue()`, `create_repo()`, `open_spec_pr()`; wraps the single Factory
    GitHub App via its installation token (the **Factory Builder bot** identity).
  - `RequestRepository` — persistence for Requests, draft specs, status history, audit; SQLAlchemy
    behind a clean interface.
  - `Auth` — Microsoft SSO (Entra); resolves `{user, role}` with role ∈ {Submitter, Admin}.
- **Thin glue (not isolated):** FastAPI routes (submit, interview-step, my-requests, admin list-pending,
  approve, send-back, registry CRUD) and a webhook receiver (confirms Issue creation).
- **Approval side-effect ordering** (per ADR 0003): on Approve — (1) new app → `create_repo` +
  `AppRegistry.register`; existing app → `resolve`; (2) `open_spec_pr` writing `SPEC.md`; (3) fire Stage 2
  trigger. None of this happens for an unapproved Request.
- **Spec approval is an in-app gate, not a GitHub gate.** It happens in the Control center against the
  Draft spec in the database. (The GitHub-identity human gates — Merge, Deploy — belong to Stages 5–6 and
  are out of scope here, so admins do **not** need to link a GitHub account for Stage 1.)
- **Persistence seam** (per ADR 0007): all data access via SQLAlchemy + Alembic; DB-agnostic so SQLite
  (local) → Azure SQL / MSSQL (hosted) is a connection-string change.
- **Schema (entities, not columns):** `User` (sso id, role), `Request` (type, app ref, title, description,
  urgency, status, submitter, type-specific fields), `InterviewTurn` (question/answer history),
  `DraftSpec` (content, version, linked to Request), `AppRegistryEntry` (name → repo, owner),
  `AuditEvent` (actor, action, target, timestamp).
- **API contracts (shape, not paths):** submit-Request returns a Request id + status; interview-step takes
  prior answers and returns next questions or done; admin approve/send-back take a Request id (+ note);
  list endpoints are role-scoped (Submitters see their own; Admins see the queue/board).
- **Live updates:** GitHub webhook → FastAPI → DB; the Angular board **polls (~3–5s)** for Stage 1 (SSE is
  a later upgrade).

## Testing Decisions

- **What makes a good test here:** assert **external behavior** through a module's public interface, not
  its internals. Mock at the system boundary only — the `LLMClient` and the GitHub API — never the module
  under test. Tests are written with `pytest` (run via `uv`).
- **Modules under test** (confirmed):
  - `RequestLifecycle` — the highest-value target. Table-driven tests over every transition and the
    side-effects each one is expected to fire; pure logic, no mocks needed.
  - `IntakeInterview` — with a stubbed `LLMClient`: stops at the cap, stops when satisfied, folds answers in.
  - `DraftSpecGenerator` — with a stubbed `LLMClient`: produces a Draft spec from a representative Request.
  - `AppRegistry` — resolve/register/list behavior, including the new-app registration path.
  - `GitHubGateway` — against a **mocked GitHub API**: asserts the right calls (issue/repo/PR) with the
    right inputs, and that nothing is created on the unapproved path.
- **Not tested:** the thin FastAPI route/glue layer and Angular UI components (covered indirectly; no
  isolated unit tests this round).
- **Prior art:** none — greenfield repo. Establish the boundary-mock pattern (stub `LLMClient`, mock
  GitHub API) as the convention for the rest of the Factory.

## Out of Scope (TODO — future grilling sessions)

- Stages 2–6 of the Factory engine (architect, test-author, implementer, reviewer, release-manager).
- Control center features for build stages: Progress timeline, Code-change view, Recovery actions.
- The Merge gate and Deploy gate (and therefore admin GitHub-identity linking).
- Notifications (pinging the right Admin when a gate/`needs-human` needs them).
- Admin permission tiers (who may approve what).
- SSE live-push (polling only for now).

## Further Notes

- **Two swap-later seams** are deliberate and isolated: `LLMClient` (OpenAI → corporate wrapped LLM) and
  the SQLAlchemy layer (SQLite → MSSQL). Keep provider/engine specifics out of every other module.
- **Open question carried forward:** whether Copilot CLI exposes a per-run turn/step cap. Not relevant to
  Stage 1 (its AI is web-app LLM calls), but it affects Stages 2–6; CI `timeout-minutes` remains the
  primary bound there.
- Relevant records: `CONTEXT.md` (glossary), ADR 0003 (draft-spec-in-DB), ADR 0007 (web-app stack),
  ADR 0001/0002 (runtime & orchestration the front door hands off to).
