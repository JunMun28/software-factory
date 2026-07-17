# Console gap analysis — the bigger picture (2026-07-16)

Frame: the factory's promise is an autonomous software line where humans gate
only the irreversible. The console is the human half of that promise. Judge it
by five questions:

1. Can an admin **trust** what they approve?
2. Can they **see the whole line** at a glance?
3. Can they **intervene fast** when something breaks?
4. Does it **survive scale** (more requests, more apps, more admins)?
5. Does it **account for what shipped** after the line moves on?

Today's console answers 2 well, 3 partially, and 1, 4, 5 poorly.

## What is genuinely strong

- One decision surface + bird's-eye board (the new Overview) matches the
  operator's real loop: decide, then scan.
- The lifecycle is deterministic and replayable; the dossier renders raw
  append-only evidence instead of a prettied summary. That is rare and good.
- Gate actions are idempotent, 409 conflicts are surfaced honestly with the
  winner's name, keyboard-first works.

## Gap 1 — The approval moment is under-evidenced (trust)

This is the core loop, and it is the weakest link.

- **Merge gates frequently show "no evidence recorded."** Live data confirms
  it (REQ-2029, REQ-2041). `supervision.evidence()` returns `None` when no
  `verification` event exists, and the UI shrugs. An admin can approve a real
  merge + deploy on zero facts. Raising the merge gate should *require* a
  verification event (or the UI should add friction: "no evidence — approve
  anyway?" as a warning state, not a quiet grey line).
- **"Review & Preview" has no preview.** B3 made produced apps run live in
  the cluster, yet the gate that ships one offers no "open the built app"
  link. The single highest-leverage feature now possible: deploy to a staging
  namespace at review time and put the URL in the evidence strip. Approving a
  deploy you can click through is a different product than approving a diff
  count.
- **No code visibility.** The gate row and dossier show repo names but no PR
  link, no diff view. The reviewer verdict is one string. Add the PR URL to
  the evidence payload and link it everywhere evidence renders.

## Gap 2 — The factory has no gauges (operations)

- **No metrics at all**: cycle time, gate-wait time, throughput, failure rate
  by stage, send-back rate. The data already exists (`stage_entered_at`,
  audit events, the append-only progress log) — it is simply never
  aggregated. The old Floor had a "— median cycle" placeholder; the redesign
  dropped it rather than filling it. A small aggregate endpoint + one quiet
  strip on Overview closes this.
- **Runner and cluster health are invisible.** The console shows only the
  "Simulated / Agents" badge. If the tick loop stalls, kind is down, or the
  in-cluster registry breaks, the only symptom is every run going "quiet."
  Expand `/api/health` (tick age, queue depth, k8s reachability, last Job
  failure) and give the shell a real status line.
- **Deploy is a black box.** Kaniko build → digest-pinned deploy → health
  probe all happen off-screen; the card shows one `last_event` string. The
  dossier's deploy chapter should carry the build log tail, the image digest,
  and the rollout status.

## Gap 3 — The queue does not survive scale (throughput)

Live seed data shows the failure mode already: **18 near-identical "Approve
to build" rows.**

- **Priority and urgency are captured at intake and never used.** The queue
  is insertion-ordered. Sort by priority, then gate age.
- **No age on queue rows.** The board shows time-in-stage; the decision queue
  (where it matters most) does not. Add an age chip + amber threshold.
- **No grouping or filters.** Ten Northwind rows should collapse under one
  app header. No filter by app/type/gate kind.
- **Identical consequence copy 16×** ("Approving accepts the spec and starts
  architecture + build.") is noise at scale. Say it once per group, or only
  on focus.
- **No batch triage.** Even with per-item evidence held sacred, approving
  five bug-fix specs one modal at a time is friction that will push admins to
  rubber-stamping — the exact opposite of grounded approval.

## Gap 4 — Identity and governance are mock (safety)

- **Operator identity is self-selected.** Studio's "Who's at the controls?"
  picker means the audit trail signs whatever profile you clicked. That was
  fine when approvals moved simulated cards; B1–B3 made approvals create
  repos, merge PRs, and deploy pods. Real auth (the planned Entra) is now a
  prerequisite for a second admin, not a nice-to-have. Roles come with it:
  who may approve deploys vs. specs.
- **No rollback.** Deploys are digest-pinned (the hard part is done), but the
  console offers no "roll back to previous digest." Shipped = irreversible in
  the UI even though the infrastructure made it reversible.
- **No master switch.** There is no "pause the line" control for incidents —
  the leader tick keeps driving stages no matter what the humans are dealing
  with.

## Gap 5 — Nothing tracks what shipped (product)

A software factory's output is *running software*, and the console loses
interest at "Done."

- Library answers "what happened to request X." Nothing answers **"what is
  live right now, at which version, and is it healthy?"** A per-app page in
  Library (live status from kube, current digest, deploy history, open
  requests) turns the console from a work tracker into a factory console.
- No in-context follow-up: an admin looking at a deployed app cannot file the
  bug they just noticed; the loop back into intake belongs on that page.

## Gap 6 — Attention depends on an open tab (liveness)

- Notifications are email with a **log-only fallback** — unconfigured SMTP
  means gate-raised pings go to the server log. A gate raised at 6pm waits
  silently until morning. Configure SMTP or add a webhook (Slack/Teams), and
  consider browser notifications for admins who live in the console.
- The floor polls; the SSE seam already exists (interview/prototype streams,
  and the Store was explicitly built as the poll→push swap point). Fine to
  defer per the anti-overbuild principle — but it is the designed next step,
  not new architecture.

## Smaller debts (worth a line each)

- Dossier trace caps at the latest 500 events with no backward cursor — the
  UI literally apologizes for it in a status row.
- Board columns are unbounded; a 30-card Intake column makes the page very
  tall. Collapse beyond ~8 with a "show all."
- Board cards are not keyboard-reachable (j/k covers the queue only).
- No browser-level e2e of the approve flow; smoke is API-only.
- Abandoned intake drafts (a request literally titled "sdf" is on the board)
  have no expiry/archival policy.

## Priority order (leverage ÷ effort, honoring "do not over-build")

1. **Evidence hardening + preview link at the merge gate** — closes the trust
   loop; mostly surfacing data and infrastructure that already exist.
2. **Queue triage** (priority sort, age chips, group-by-app) — the daily
   surface, cheap, prevents rubber-stamping.
3. **Deploy observability + rollback** (digest history, build log tail, one
   rollback action) — makes B3 operable, not just demoable.
4. **Factory gauges** (cycle/gate-wait/throughput strip + runner/cluster
   health in the shell).
5. **Real identity and roles** — required before a second real admin.
6. **Fleet view in Library** (live app status per app).

Everything above surfaces existing data or completes existing seams; none of
it requires new subsystems. That is consistent with the project's own
principle: a handful of admins, quiet by default, loud only when it matters.
