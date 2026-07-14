# The operator console uses a four-surface information architecture

**Status:** Accepted

## Context

ADR 0015 organized supervision across eight console surfaces, with Mission control as
the operator home. ADR 0016 added a separate Factory-map lens and a bounded cockpit
visual language. As the factory gained signed decisions, conflict-safe actions,
recovery, honest steering, runner visibility, and notifications, those separate lenses
split one request's operational story across too many places.

The console is used by a small team supervising autonomous work, not by a large team
pulling tickets through a human-owned board. Its information architecture should put
human consequences first, keep the complete story of one request together, and expose
administration without creating another operational dashboard.

## Decision

The console has four surfaces in the Micron Atlas visual system:

- **The Floor** (`/`) is home. It puts gates and escalations first, then active lanes,
  recent signed outcomes, and honest operational summaries.
- **Dossier** (`/requests/:id`) tells one request's complete story through a semantic
  timeline, evidence, comments, steering state, and scoped action verbs.
- **Library** (`/library`) is the filterable list of all requests. App and state filters
  live in the URL so views can be shared and linked.
- **Studio** (`/studio`) contains the app registry, named operator profile, and persisted
  notification preferences.

The old Mission control, Factory map, Gates queue, Needs-me inbox, All requests,
per-app Feed, Registry, Settings, and old request-detail surfaces are removed. Permanent
client-side redirects preserve their `/admin/*` URLs and route them into the four new
surfaces. The shell is a slim top bar plus command palette; there is no sidebar.

The supporting operating model is:

- Operator identity is a server-side named profile. There are no passwords yet; the
  client stores only the selected operator id, leaving a seam for real authentication.
- State-changing actions use atomic compare-and-set updates. Exactly one racing action
  wins; losers receive structured `409` responses containing the actor, time, and
  resulting state. The system uses no claims, leases, or presence.
- Recovery stays scoped to explicit verbs. **Take over** stops automation and moves the
  request to `human_owned`; **send back to stage** selects an earlier runner stage and
  records why work must be redone. Retry and cancel retain their existing meanings.
- Steering is honest: a note is **queued** until the runner acknowledges it, then becomes
  **heard** at a step boundary. Acknowledgment is derived from new append-only events;
  steer rows and prior events are never rewritten.
- Real runners emit stage-step summaries, and the shell displays the actual runner mode
  and CLI rather than inferring them from an impossible value.
- Email is sent only for a raised human gate or an escalation/stall, using per-operator,
  per-app subscriptions and a Dossier deep link. Missing SMTP configuration degrades to
  log-only delivery and is reported honestly in Studio.
- The existing event cursor remains the main convergence path. A lightweight revision
  counter covers registry, operator, and preference mutations that emit no progress
  event, so browsers converge without WebSockets.

The following invariants remain unchanged:

- `progress_event` is append-only, as defined by ADR 0008.
- The API runs with a single uvicorn worker.
- Spec approval and merge approval remain the two human gates; their semantics and the
  one-winner protection around irreversible effects are preserved.

## Consequences

- The codebase and navigation now describe one four-surface console instead of keeping
  hidden fallback implementations.
- Operators can begin with consequences on The Floor and move to one Dossier without
  translating between competing board, map, queue, inbox, and feed projections.
- The Factory-map cockpit exception ends with the removed map surface. Purple remains
  the console's single accent, with amber, red, and green reserved for status meaning.
- Coordination remains deliberately lightweight for one to five concurrent runs:
  polling, SQLite write serialization, compare-and-set conflicts, and one server worker.
- Legacy URLs remain compatible through redirects, although HTTP 301/308 behavior is a
  hosting concern rather than an Angular router guarantee.

## Supersedes

- ADR 0015, in full.
- ADR 0016, for the Factory-map surface and its visual exception.
