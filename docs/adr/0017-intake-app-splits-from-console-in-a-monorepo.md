# The web app splits into two — a standalone Intake app and the Control center — in a monorepo

**Status:** accepted (amends the "single web app" framing of ADR 0007 and CONTEXT.md; keeps
0007's stack + swap-later seams. Auth wiring, CORS/two-origin deploy, and Azure hosting are
deferred to separate decisions.)

The single Angular app that held both the **Intake form** (the Submitter world) and the
**Control center** (the Admin world) splits into **two independently deployable Angular apps in
one monorepo** — `apps/intake` and `apps/console` — sharing **one source-level library**
(`@sf/shared`) and the **one FastAPI backend**. The driver is an audience + auth boundary:
Submitters and Admins are different audiences, the Intake app must stay **very stable**, and it
should own its **own auth surface** rather than ride inside the console.

## What changes

- **Two apps, one repo.** A single Angular CLI workspace with three projects: `intake`,
  `console`, and the `shared` library. `apps/intake` ← today's `submitter/`; `apps/console` ←
  today's `admin/`.
- **One shared library, source-shared.** `@sf/shared` holds the domain model (`models.ts`), the
  API client (`api.service`), `util`, `poll`, `theme`, and the UI **kit** — consumed via a
  TypeScript path alias (no publish/build step). App-only code stays in its app: the console keeps
  `store`, `map-view`, and the admin guard.
- **Each app authenticates on its own.** The mock `Session`, the `sub-shell` role switch, and the
  `world-switch` go away. Both apps sign in via Entra ID with **separate app registrations**; the
  console's "New request" becomes an outbound deep-link to the Intake app (same SSO session).
- **One backend, two origins.** The FastAPI backend is unchanged and shared; it now serves two
  browser origins (CORS for both; bearer-token auth).
- **Cross-platform orchestration.** The Unix-shell `Makefile` is replaced by a `Taskfile.yml`
  (the primary dev box is Windows; Task embeds its own shell, so recipes run without WSL/Git Bash).

## Why recorded

- **Hard to reverse** — one app becoming two apps + a shared library + a monorepo layout is a
  structural change; merging back is a full restructure, not a config flip.
- **Surprising without context** — ADR 0007 and CONTEXT.md state the Intake form and Control
  center are the *same* web app. This deliberately breaks that, so it must be a named decision
  rather than silent drift.
- **Real trade-off** — the alternatives were (a) keep one app with a cleaner internal route
  boundary, or (b) duplicate the shared kit/model into two apps. We chose **split + one shared
  library** to get an independent, very-stable Intake deployable with its own auth surface,
  accepting the cost of a **build-time shared dependency** between the two apps.

## Keeping the Intake app stable (the load-bearing choice)

`@sf/shared` stays **plain in-repo source** (not a versioned/published package). Stability is
enforced by two cheap levers, not by pinning:

- **CODEOWNERS** on `apps/intake/` and `packages/shared/` — no change reaches those paths without
  the owner's approval.
- **A CI gate** — any PR that touches `@sf/shared` must pass the **Intake app's full verify**
  (build + unit + smoke) before it can merge.

Version-pinning the library (or tier-splitting it into a contract lib + a UI lib) is deferred
until/unless the kit churns enough to make the gate noisy.

## Scope and what is deferred

This ADR covers the **frontend split + monorepo structure + orchestration** only. Explicitly
deferred to their own later decisions, so this structural refactor stays low-risk:

- Real **Entra auth** wiring (MSAL.js + the three app registrations: intake SPA, console SPA, API
  scope). The mock session stays during the refactor.
- **CORS + two-origin deploy** topology (two static front-ends + the API).
- **Azure hosting + DB** specifics — governed by **ADR 0007** (FastAPI + Angular on Azure; hosted
  DB = Azure SQL via DB-agnostic SQLAlchemy). The backend remains **single-process** (the tick
  loop + pipeline threads assume one worker — ADR 0013); this split does not change that.

## Migration (incremental, structural-only)

Three `verify`-green phases, each its own PR, no behavior change:

1. **Extract `@sf/shared`** inside the current single app (move kit/model/services into the library
   project, path-alias it, rewrite imports). App still runs as one; behavior identical.
2. **Split into two apps** — generate `intake` + `console` projects, move `submitter/` and `admin/`
   in, wire each app's routes; drop the role switch + world switch; the console "New request"
   deep-links out.
3. **Tooling + guardrails** — `Taskfile.yml` (`task dev` / `task verify`), `CODEOWNERS`, and the CI
   gate (a `@sf/shared` change runs the Intake app's verify).

## Consequences

- ADR 0007's "single web app" framing is **amended** (two apps now); its stack choices and
  swap-later DB/LLM seams stand.
- CONTEXT.md's **Intake form** and **Control center** definitions are updated — they are no longer
  "the same web app."
- `@sf/shared`'s public surface becomes a **load-bearing contract**: a change ripples to both apps
  at build time, which is exactly why the CI gate above exists.
- `make verify` becomes `task verify`; CI builds **two** apps and runs the shared-library gate.
- The Intake app can now be deployed, scaled, and (later) re-authed independently of the console —
  the point of the split.
