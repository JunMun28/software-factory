# Web app stack: FastAPI + Angular, SQLite→MSSQL, OpenAI→corporate LLM, Azure, one GitHub App

**Status:** accepted

The Intake form + Control center web app is built as a **FastAPI + uv** backend and an
**Angular** single-page frontend (API + SPA split). Most of this is conventional Microsoft-shop
alignment; the parts worth recording are the two swap-later seams and one non-obvious AI boundary.

## Two "swap-later" seams (build on the available thing now, swap to the corporate one later)

- **Database** — **SQLite for local dev only**, **Azure SQL (MSSQL)** for anything hosted/shared.
  All access goes through **SQLAlchemy** with **Alembic** migrations and stays DB-agnostic (no
  SQLite-only behaviors), so the switch is a connection-string change. SQLite is *not* used for the
  hosted prototype (its disk on App Service is ephemeral and write-unfriendly).
- **LLM** — **OpenAI raw API now**, **corporate wrapped LLM later** (no access yet). All calls go
  through one thin `LLMClient` adapter (configurable base URL/key/model). Most corporate gateways
  are OpenAI-compatible, so the swap may be a base-URL change; if not, only the adapter changes.

## The AI boundary (the non-obvious bit)

There are **two kinds of AI** and they run in different places:
- **Pre-approval AI** — the Intake interview chat and the Draft spec — runs **inside the web app**
  as direct LLM calls (a user is waiting in the browser, and for a new app **no repo exists yet**).
  So "Stage 1" is effectively a **web-app feature, not a CI Copilot agent.**
- **Stages 2–6** run as **Copilot agents in GitHub Actions (CI)**, on the repo/PR (see ADR 0001).

A future engineer would assume all stages are CI Copilot agents; this records that the pre-approval
work deliberately is not.

## Real-time, hosting, GitHub

- **Live board** — **polling now, SSE later.** GitHub webhooks → FastAPI → DB; the Angular board
  polls (~3–5s). Upgrade to Server-Sent Events when it matters; WebSockets are unnecessary.
- **Hosting** — **Azure App Service + Azure SQL**; the factory agents stay in GitHub Actions.
- **GitHub** — **one "Factory" GitHub App**, two token types: its *installation token* is the
  Builder bot (creates repos, opens PRs, commits, posts progress comments); each admin authorizes
  the same App once for a *user token* so they approve as themselves; the App's webhook feeds the
  backend. Needs administration, contents, pull-requests, checks, and deployments permissions.

## Consequences

- Two interfaces (SQLAlchemy data layer, `LLMClient`) are load-bearing — keep provider/engine
  specifics out of the rest of the app.
- Local dev needs no Azure and no MSSQL; the hosted prototype needs both.
