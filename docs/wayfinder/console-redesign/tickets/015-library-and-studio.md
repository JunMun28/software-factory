---
id: 015
title: "Slice 9: Library + Studio registry"
labels: [ready-for-agent, wayfinder:task]
status: closed
assignee: claude+codex
blocked-by: [007]
user-stories: "29, 31"
---

## Parent

[Spec: Console redesign — The Floor (PRD)](../spec-the-floor-prd.md) · design spec: docs/superpowers/specs/2026-07-11-console-redesign-design.md · visual reference: mockups/console-floor-family.html

## What to build

The remaining two surfaces. Library: every request past and present as compact rows (state word, title, app, decided-by/updated, cycle time), filterable by app and state via query params so filtered views are shareable URLs. Studio: registry app cards with create/edit (honest about what verification means), alongside the profile and notification sections from earlier slices.

Hard invariants: progress_event is append-only (ADR 0008); single uvicorn worker; gate semantics preserved; work on the `console-redesign` worktree branch; never commit/push without the user's ask.

## Acceptance criteria

- [ ] Library lists all requests; app/state filters live in the URL and survive reload/sharing
- [ ] Drill-down links from Floor lanes and Recently land on the right Dossier; filter links land on the filtered Library
- [ ] Registry create/edit works from Studio cards and reaches other browsers within a poll cycle
- [ ] Family direction at 1440/390, light + dark; component tests cover filter-from-URL

## Blocked by

[Slice 1](007-shell-and-readonly-floor.md)

## Resolution (2026-07-13)

Implemented by codex gpt-5.6-sol, reviewed by fable-5, committed on
`console-redesign`. New `library/library-page.ts` at `/library` (was a stub):
every request as compact rows (statusPill shape+word, title+ref, app,
updated/requester, cycle time), with app + state filters read from and written
to the URL query params (`?app=<key>&state=<needs-you|in-flight|shipped|
sent-back|cancelled|human-owned>`) via `route.queryParamMap.subscribe` +
`Router.navigate({queryParamsHandling:'merge'})` — so a filtered view is a
shareable, reload-surviving link. Rows deep-link to `/requests/:id`. Studio
gained a Family-styled registry section (app cards with repo/owner/provisioning,
create + edit wired to POST/PATCH /api/apps, honest copy that registration
records the mapping but does not itself verify repo access) alongside the intact
profile + notification sections; both re-fetch on the revision-driven
`poll.version()`.

Review notes: no fixes needed. Codex heeded the slice-8 NG0203 lesson — the
Library reads query params via `subscribe` (with OnDestroy cleanup), not a
`toSignal` field initializer, so the route mounts cleanly. It left angular.json
untouched; its sandbox build failure was the esbuild/malloc toolchain crash.

Verified live: `/library?state=shipped` mounts filtered (4/13); `?state=in-flight`
shows the "No requests" empty state; unfiltered = 13/13 with every row linking to
its Dossier; a filter-chip click updates the URL (`?state=in-flight`); Library
dark + light at 1440. Studio registry cards + "Register an app" form render with
honest copy; POST /api/apps created "Payroll Service" (revision 1->2) and PATCH
edited it — the new app then converged into the Library's app filter on the next
poll. pytest 185, console 70 (10 files, 5 Library/Studio), lint green; console
build green.
