# Software Factory

An autonomous-but-governed AI pipeline that carries a unit of work through the full
SDLC — requirements → architecture → TDD implementation → review → deploy — as a chain
of narrow, single-responsibility agents handing validated artifacts to each other, with
humans gating the irreversible boundaries.

## Language

**Factory**:
The whole governed pipeline. A fixed sequence of Stages, not one autonomous mega-agent.
_Avoid_: pipeline (overloaded with CI), workflow (means the GitHub Actions file specifically).

**Stage**:
One step in the Factory: a single narrow agent with a restricted toolset that consumes one
input Artifact and emits the next. Stages are numbered 1–6 (Requirements, Architecture,
Test authoring, Implementation, Review, Deploy).
_Avoid_: step (means an agentic step inside a Stage — see Bounded autonomy), phase.

**Artifact**:
The validated file a Stage emits and the next Stage consumes — the typed interface between
Stages (e.g. `SPEC.md`, `PLAN.md`, failing tests, review report). A Stage begins by
*validating* its input Artifact before doing work.
_Avoid_: output, deliverable, document.

**Gate**:
A checkpoint between Stages that must pass before the next Stage runs. Two kinds:
- **Human gate** — a person must approve (architecture sign-off, merge, prod deploy).
- **Automated gate** — a CI/git check decides (tests fail for the right reason; implementer
  diff touched no test files). Automated gates are where machine-enforced rules live.
_Avoid_: approval (only one kind of gate), check (too generic).

**Merge gate** (Stage 5 human gate):
The approval that lets a Work item's PR merge into `main`. A native GitHub protected-branch
required approval: an **Admin** approves the PR as themselves (from the Control center), and
GitHub independently requires all CI checks (RED/GREEN/Test-isolation) to pass. Works on the
**Team plan + private repos**.
_Avoid_: code review (that's the Stage 5 `reviewer` agent producing a report, not the gate).

**Deploy gate** (Stage 6 human gate):
The approval that ships to production — implemented as a **protected-branch promotion**, not a
GitHub Environment reviewer (Environment "required reviewers" and custom protection rules are
not available for private repos on the Team plan). To deploy, the Factory opens a PR promoting
`main` → a protected **`production` branch**; an Admin approves it as themselves; merging it
triggers the deploy. Same mechanism as the Merge gate — one idea ("a protected branch needs
approval") powers both human gates, enforced natively by GitHub with no Enterprise upgrade.
_Avoid_: release approval, environment gate.

**Subject**:
The codebase the Factory operates *on* — distinct from the Factory itself (the agents,
configs, workflows). For an existing-app Request the Subject is the app's GitHub repo (found
via the App registry); for a new-app Request the Subject is a fresh repo the Factory creates
at Spec-approval time. The MVP gate spike uses an embedded sample project (`sample/`,
uv + pytest). The Factory never tangles its own config with the Subject's `src/`/`tests/`.
_Avoid_: target, project, repo (ambiguous — could mean the Factory repo).

**App registry**:
A small admin-managed list mapping each app name → its GitHub repo (and owner). It fills the
form's "Which app?" dropdown and tells the Factory which repo (Subject) a bug/enhancement
Request targets. A new-app Request adds a new entry when the Factory creates its repo.
_Avoid_: catalog, inventory.

**Submitter / Admin** (Intake roles):
Everyone signs in with **Microsoft SSO** (Entra ID); each app (Intake, Control center) has its own
sign-in (separate Entra app registrations). A **Submitter** files
Requests and sees their own; they never touch GitHub. An **Admin** also runs the Control center,
performs **Spec approval**, and approves the human gates (Merge gate, Deploy gate). Because the
human gates are real GitHub approvals, each Admin **links their GitHub account once** (one-time
OAuth on top of SSO) so they approve **as themselves** — real human attribution in GitHub, and
GitHub natively enforces "can't approve your own work." Submitters need no GitHub account.
_Avoid_: user (ambiguous), reviewer (the Stage 5 `reviewer` agent is a different thing).

**Factory Builder bot**:
The single GitHub App identity the Factory acts under when it *writes*: it opens branches/PRs,
runs the Stage agents, and posts Progress reporting comments. It **never approves** a gate
(GitHub blocks an identity from approving its own PR, and approvals must be a human Admin). Its
counterpart is the Admin, who approves. Not the Actions `GITHUB_TOKEN` bot (whose reviews never
count) — a dedicated App with repo write access.
_Avoid_: service account, CI bot.

**Request**:
What a user submits through the Intake form — the raw thing they want. One of three kinds:
a **bug fix** or an **enhancement** to an existing app, or a **new app**. A Request is the
input to Stage 1; the `requirements-analyst` turns it into a `SPEC.md`.
_Avoid_: ticket, ask, feature (a Request may be a bug, not a feature).

**Intake form**:
The Submitter-facing app that is the front door of the Factory — a standalone deployable with its
own auth surface, separate from the Control center. Flow: a user submits a Request →
the **Intake interview** asks a few follow-up questions in the same window → then it saves the
enriched Request to its own database (for a dashboard/record) and creates a GitHub Issue
(which triggers Stage 1). Non-technical users never touch GitHub directly.
_Avoid_: portal, dashboard (the dashboard is one view of the Intake form's data).

**Intake interview**:
A short, real-time AI chat that runs right after a user submits the form. It reads the Request
and asks up to ~3–4 follow-up questions to fill gaps, while the user is still there. It stops
once it has enough or hits the cap. Its answers are added to the Request before the GitHub
Issue is created. Same Stage 1 brain that later writes the spec.
_Avoid_: interrogation, survey (it's short and adaptive).

**Track**:
The shape of one Submitter's intake journey — which steps it includes and how deep the
Intake interview goes. Derived by the Intake form from the inferred Request type *plus* how
rich the description already is; shown to the Submitter as a visible, correctable chip. A
Track can lengthen or shorten mid-journey (escalation/demotion) without the Request type
changing. Intake-app vocabulary only — the Factory consumes the Request type, never the Track.
_Avoid_: path (too generic), flow (means the whole intake UX), type (the stored Request fact).

**Attachment**:
A file a Submitter uploads to a **Request** as evidence — an image (e.g. an error-message
screenshot) or a document (logs, a PDF/Word/Excel). It belongs to the Request as a flat set
(added on the Describe step or during the Intake interview; not bound to a single interview
turn). The Stage 1 brain reads attachments as **first-class source material** when drafting the
spec — the same standing as the typed description and interview answers — and an **Admin** can
open the original while reviewing the Draft spec, to check the brain read it right. Mutable
while the Request is a pre-approval draft (the Submitter may add or remove); frozen once the
Request is submitted into the Factory. Lives in its own store, **not** the append-only
`progress_event` log.
_Avoid_: upload (that's the action, not the thing), file (too generic), enclosure.

**Control center**:
The Admin-facing app — mission control for the whole Factory. It is a **separate app** from the
Intake form (Intake = front door for Submitters; Control center = where Admins run things),
sharing one backend API and a common domain/UI library (`@sf/shared`). An Admin who files a
Request does so in the Intake app (same SSO). Its jobs:
- **Kanban board** — one unified board; every Request is a card moving across **stage columns**
  *Intake → Spec → Architecture → Build → Review → Deploy → Done*. The column shows *where* a card
  is; an **attention badge** shows whether it is the Admin's move — **Approve spec** (Stage 1),
  **Sign ADRs** (Stage 2), **Approve merge** (Stage 5), **Approve deploy** (Stage 6), or a red
  **Needs human** (failed/stuck). Admins can filter to "waiting on me". Pre-approval cards
  (Intake, Spec) are database-backed; from Approval on, a card is backed by its Work item PR. A
  card shows its app, type (new / existing / bug fix), and owner.
- **Approval queue** — read Draft specs and Approve/Send-back (Spec approval).
- **Progress timeline** — each card shows a running list of milestone summaries from the agents
  (see Progress reporting), so you watch the build happen without opening GitHub.
- **Progress feed** — the same progress grouped per-app (Subject), Slack-style (channel → thread →
  message); a second view of the same log.
- **Needs-me inbox** — the clearable list of items waiting on this Admin (the human Gates + Needs-human).
- **Code-change view** — see the diffs/commits an agent produced for a Request.
- **Act on gates** — Admins approve the Merge gate and Deploy gate from here. The buttons call
  GitHub using the Admin's **linked GitHub identity**, so the action is attributed to the human
  and GitHub still enforces all checks. The Control center never bypasses a GitHub gate — it is
  a friendlier front-end on top of them.
_Avoid_: dashboard (one part of it), admin panel, console.

**Progress reporting**:
How agents tell the Control center what is happening. At the **end of each stage/milestone**,
the agent's last action is to write a **short summary** of what it did and how it went
(e.g. "implemented cart totals; all 8 tests pass; touched no test files"). The summary is posted
as a **PR comment**, which the Control center receives via GitHub webhook and records as one entry
in a single append-only progress log (keyed by both Work item and Subject). That one log is read two
ways: per–Work item (the **Progress timeline** on a card) and per-app (the **Progress feed**).
Milestone summaries only — not moment-to-moment streaming (that stays a future optional add-on).
Gate events, Escalation, and Recovery actions share the same log, so there is one source of truth.
_Avoid_: streaming, logs (these are summaries, not raw output).

**Progress feed** (per-app, Slack-style):
The per-app view of progress in the Control center: **channel = app (Subject)**, **thread = Work item /
Request**, **message = milestone summary**. It is the same data as the per–Work item Progress timeline,
grouped by Subject instead — a second view, not a second pipeline. Most summaries stay in-thread;
Gate events and Needs-human **broadcast** to the channel top. Ambient (an unread dot), never a count to
clear to zero.
_Avoid_: chat, channel (use "feed"; "channel" is only the app-grouping metaphor).

**Needs-me inbox**:
The clearable attention surface in the Control center holding **only** items waiting on a specific
Admin — the human Gates (Approve spec, Sign ADRs, Approve merge, Approve deploy) and red Needs-human.
It is the "waiting on me" filter promoted to a badge-counted, mark-readable, clearable surface. Distinct
from the **Progress feed**, which is ambient and never "done". The attention badge is the only push.
_Avoid_: notifications (too broad), alerts.

**Status type**:
A coarse Linear-style type tagged onto each stage column so views/filters run off the type, not seven
column names: **Triage** (Intake), **Started** (Spec→Deploy), **Completed** (Done), **Canceled** (a
Cancelled Request). **Needs-human is a blocked _overlay_, not a column or a type.**
_Avoid_: status (ambiguous with stage/column), state.

**Factory control repo**:
One shared GitHub repo that owns all Request issues and the Factory's own config/workflows —
separate from the app (Subject) repos. It exists because a new-app Request has no app repo yet,
so its issue and records need a home that always exists.
_Avoid_: factory repo (too vague), meta repo.

**Draft spec**:
The AI's first write-up of the Request, produced by the Stage 1 brain after the Intake
interview. It lives in the **intake app's database** (shown in the dashboard) until approved —
not yet a repo file. Works the same for existing- and new-app Requests.
_Avoid_: SPEC.md (that name is reserved for the approved file committed to the repo).

**Spec approval** (Stage 1 human gate):
Before the Factory builds anything, an **admin/reviewer** (not the submitter) reads the
Draft spec in the **dashboard** and clicks Approve or Send-back. The dashboard is the approval
queue. Approve does three things in order: (1) for a new app, create the repo and register it;
for an existing app, use its repo; (2) write the approved spec as `SPEC.md` on a fresh
branch + PR (the Work item is born here); (3) start Stage 2 (Architecture). Send-back returns
the Request for more info. No repo is created for an unapproved Request.
_Avoid_: sign-off (reserved for ADRs in Stage 2).

**Work item**:
The atom the Factory processes: one **branch + pull request**. It is **born at Spec approval**
(when the approved `SPEC.md` is committed to a fresh branch). Stages write their Artifacts as
commits on the branch; Gates are evaluated against the PR (human gates = protected-branch
approvals — Merge gate, Deploy gate; automated gates = CI checks). One Work item flows through
Stages 2–6.
_Avoid_: ticket, task, job, run.

**Validation**:
The machine-checkable test an Artifact must pass before the consuming Stage runs:
(1) **structural** — required frontmatter/sections present; (2) **referential** — every
path/ADR/test the Artifact names exists in the repo. Runs as an automated gate that fails
closed. An agent may also reason about the Artifact, but the gate is the validator script,
not the agent's judgement. The schema is minimal and owned by this repo (not Spec Kit).
_Avoid_: review (that's a Stage), lint.

**Escalation**:
The **stop event**: when a Stage exceeds its bound (CI `timeout-minutes`) or fails its gate, the
workflow **stops advancing** and the Work item's PR is flagged `factory/needs-human` (a red
**Needs human** badge on the board). There is **no automatic retry** — Escalation just stops and
flags; a human then picks a Recovery action.
_Avoid_: rollback. (Retry/Take over are Recovery actions, not Escalation itself.)

**Recovery action**:
What an Admin picks from on a `needs-human` card to get it moving again:
- **Retry** — re-run the same Stage fresh (timeout / flaky failure).
- **Retry with a note** — add a short steering instruction, then re-run (agent went the wrong way).
- **Send back** — bounce to an earlier Stage to redo its Artifact (e.g. Spec or Architecture);
  later work is discarded and redone.
- **Take over** — a human does that Stage by hand in the PR, then hands control back.
- **Cancel** — abandon the Request: close the PR, mark it won't-do, notify the Submitter.
_Avoid_: fix, resolve.

**Resumability** (core requirement):
The Factory can **re-enter from any Stage** against the current PR state — it is not a one-shot
start-to-finish run. Retry, Send back, and Take over all depend on this. It works because every
Stage begins by *validating its input Artifact* and operates on the repo as it currently is, so
"run Stage N again on this PR" is always well-defined. Every Stage must therefore be
re-runnable/idempotent against current state.
_Avoid_: restart (implies from the beginning), checkpoint.

**Enforcement layer**:
*Where* a rule is actually guaranteed. This Factory enforces its rules at the
**orchestration / git layer** (CI checks, CODEOWNERS, branch protection) — runtime-agnostic
and checked against the Artifact, not the agent's good behavior. Agent-permission config
(e.g. OpenCode `deny`) is a future *second* enforcement layer, not the primary one.

**RED gate**:
The automated gate on the Test-authoring Stage. Passes only if the new tests (1) collect
cleanly (no import/syntax/collection errors), (2) fail as assertions (not runtime errors
before the assertion), and (3) leave the pre-existing suite green. Catches *broken* tests;
*wrong* tests (collect + fail but assert the wrong behavior) are caught by the human gate at
review. "Fail for the right reason" = this gate.
_Avoid_: failing tests (ambiguous about why).

**GREEN gate**:
The automated gate on the Implementation Stage: the full suite passes **and** the
Test-isolation gate holds (the implementer's diff touched no test files).

**Test-isolation gate** (the load-bearing rule):
The automated gate guaranteeing the Implementation Stage cannot weaken or rewrite the tests
it must satisfy. Enforced by an automated gate that rejects any implementer change touching
the test files. This is what makes the Factory resistant to reward hacking.
_Avoid_: anti-reward-hacking rule (describes the why, not the mechanism).

## Example dialogue

> **Dev:** The implementer made the tests pass — are we green?
> **Lead:** Did it pass the *test-isolation gate*? An automated gate, not the agent's say-so.
> **Dev:** Right — CI checks the implementer's diff touched no test files. Tests were frozen
> by the test-author Stage two commits back.
> **Lead:** Good. That's the Artifact contract doing its job. Now it waits at the human gate
> for merge.
