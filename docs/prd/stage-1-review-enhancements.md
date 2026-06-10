# Stage 1 PRD — Review & Enhancement Brief

> Output of a multi-agent review+research workflow (6 expert lenses + web research, synthesized
> and critic-pruned). All items sit **within** the locked ADRs (0001–0007) and the PRD's
> Out-of-Scope list — they deepen or operationalize locked decisions rather than reopen them.
> Source PRD: [stage-1-intake-and-spec-approval.md](stage-1-intake-and-spec-approval.md) · Linear DRE-5.
> Coverage caveat: the "comparable products / prior-art" research lens did not complete — that
> angle (Backstage, internal dev portals, AI-factory products) is the one gap to re-run.

## Top picks (highest leverage, in order)

1. **Promote the Approve/submit intent executor to a named, tested `RequestOrchestrator` module.** Today RequestLifecycle is pure (emits intents) and the executor that runs them falls into "thin glue / not tested" — but that executor owns all the hard problems (ordering, partial failure, idempotency, persisting refs). It's where ADR 0006's resumability must live, so it must be a tested module. *(architecture, high, M)*
2. **Verify the webhook HMAC (`X-Hub-Signature-256`) before any DB write, dedupe on delivery GUID.** The webhook receiver is the only internet-reachable inbound GitHub surface; with no signature check anyone can forge "issue created" events. *(security, high, S)*
3. **Enforce `role==Admin` server-side on every admin route**, from the validated SSO session — never a client field or a hidden Angular button. Because Spec approval has no GitHub-native backstop (ADR 0005), this is the *only* thing gating the irreversible repo+SPEC.md+Stage-2 action. *(security, high, S)*
4. **Make the Request id a first-class idempotency key on every GitHubGateway write**; rename `create*` → `ensure*`/find-or-create, treat GitHub `422 already exists` as success. GitHub create endpoints aren't idempotent, so re-running Approve makes a *second* issue/branch/PR. *(architecture, high, M)*
5. **Persist per-step Approve progress** (repo_ready, spec_pr_open, stage2_fired) so an interrupted Approve resumes instead of redoing all three cross-system writes. Gives ADR 0006 a concrete schema/state contract. *(gap, high, M)*
6. **Scope all Submitter reads by `submitter == authenticated user`** (close the IDOR). Story 13 implies it but the PRD never states it; without it a Submitter can enumerate ids and read others' requests. *(security, high, S)*
7. **Define the SentBack → re-enrich → PendingApproval loop end-to-end** (transition, submitter "respond to send-back" view, Draft-spec re-version, round counter). Today SentBack is a dead end with no path back — breaks the "resolve without touching GitHub" promise. *(ux, high, M)*
8. **Ground every Draft-spec line in what the Submitter actually said** — source tags `(from: Q2)` / `(ASSUMPTION)` plus an explicit Open-questions/Assumptions ledger next to Approve. The Draft spec is the cheapest place to stop a hallucinated requirement before it becomes SPEC.md. *(research-inspired, high, M)*

## Other accepted enhancements

**Reliability / correctness**
- Submit = persist-Request-first, then **retryable Issue creation, capturing the Issue ref from the API response** (not only the webhook, which GitHub doesn't auto-retry). *(gap, high, M)*
- **LLM timeout/retry/degraded contract** for the synchronous interview + Draft-spec calls: on failure return `done`/save-what-exists rather than hanging or losing the Request. *(gap, high, M)*
- **Optimistic concurrency (compare-and-set)** on transitions so two admins on the polling board can't double-approve. *(gap, high, M)*
- **Pin the "fire Stage 2 trigger" contract** — mechanism (repository_dispatch / PR-open), success confirmation, retry. It's the literal scope boundary yet undefined. *(gap, high, S)*
- **Submit-endpoint idempotency key** to prevent duplicate Requests on double-click/retry. *(gap, medium, S)*
- **Structural validation of Draft-spec output** before store/show (mirrors CONTEXT.md Validation; regenerate-or-flag on failure). *(gap, medium, S)*
- **AppRegistry = pure name→repo→owner record**; the orchestrator owns create-repo-then-register ordering so a failed Approve never publishes a dangling dropdown entry. *(architecture, medium, S)*

**Security**
- **Treat user/interview text as untrusted data** — fixed system prompt, user content delimited/role-separated; the human Spec-approval gate is a genuine grounded review, not a rubber stamp. *(security, high, M)*
- **Secrets in Azure Key Vault / App Service config**, never committed/logged; mint **short-lived installation tokens** on demand. *(security, medium, S)*
- **Bind audit actor to the validated SSO identity; write AuditEvent in the same transaction** as the status change; append-only; bot's PR body references Request id + approving Admin. *(security, medium, S)*
- **Validate the Entra session/token** (signature, issuer, audience, expiry; role from a verified claim) — underpins every other auth control. *(security, medium, S)*
- **Down-scope installation tokens per operation** (submit needs only issues:write on the control repo; Approve scoped to the one target repo; never request checks/deployments in Stage 1). *(security, medium, S)*

**Spec quality (research-inspired)**
- **EARS + GIVEN/WHEN/THEN as the fixed Draft-spec template**, scaled to Request type — pre-satisfies the future SPEC.md structural Validation gate and feeds Stage 3 test generation. *(research-inspired, high, M)*
- **Information-gain interview stop rule** over a per-type slot set (bug/enhancement/new_app), ~3–4 as a hard ceiling; neutral, non-leading, one-thing-at-a-time questions. Makes "when enough" objective and unit-testable. *(research-inspired, medium, M)*

**UX / testing**
- **Reconcile Story 14's status ladder** with real Stage-1 states — add "Needs your input (sent back)" and "Cancelled"; defer/grey the Stages 2–6 tail the backend can't drive yet. *(ux, medium, S)*
- **Contract tests for the two load-bearing seams** (`LLMClient`, `RequestRepository`) — neither is currently a confirmed test target; run RequestRepository against SQLite *and* a real MSSQL container in CI so "DB-agnostic" is enforced. *(testing, medium, M)*
- **Expand RequestLifecycle/GitHubGateway tests** to non-Approve branches (Submit emits only create-Issue; SentBack/Cancelled emit no/limited GitHub writes — guards Story 28/ADR 0003), conflict (422) handling, and an **Approve-replay / partial-failure-replay** test. *(testing, medium, M)*
- **Decide Story 6 attachment scope** — paste-a-link for Stage 1, or add an attachment field + admin display. Currently half-specified. *(ux, low, S)*

## Challenges to locked decisions (gaps, NOT re-litigation)

These were flagged as *consequences the PRD under-specifies*, not as reasons to reopen an ADR:
- **Approve concentrates three irreversible cross-system writes into one click** — needs an explicit per-step resume contract, not "idempotent where possible" (→ top picks 1, 4, 5).
- **Persistence-after-interview causes silent data loss** if the interview is abandoned. ADR 0003 only governs *repo*-creation timing — persisting the Request *record* earlier respects the ADR (→ "persist at form-send").
- **Story 14's status vocabulary** commits the UI to Stages 2–6 states the Stage-1 backend can't produce.
- **The App permission set (checks/deployments granted up front)** carries scopes Stage 1 never uses — address via down-scoped per-operation tokens, not reopening the single-App decision.
- **In-app-only approval has no GitHub backstop** — raises the stakes on server-side authz + audit integrity (→ top picks 3, audit-binding).

## Rejected by the critic

- *"Same-app duplicate hint for Admins"* — unsourced product scope creep; competes for Admin attention; full dedup is out of scope. (The submit-idempotency-key half was kept separately.)
- *"Optional grounded recap + Submitter confirmation step"* — lowest leverage, no user story, overlaps the Admin gate, risks re-adding form friction; its grounding value is already delivered by the source-tagged Draft spec (top pick 8).

## Key sources

- Interview stop rule: SAGE-Agent / structured-uncertainty clarification (arXiv 2511.08798); survey non-leading-question methodology.
- Spec quality: EARS (alistairmavin.com/ears), Gherkin/BDD, AWS Kiro spec-to-production, Martin Fowler SDD tooling, "anatomy of a good spec in the age of AI".
- Grounding/anti-hallucination: cite-as-you-generate (arXiv 2512.12117, 2503.04830), promptfoo hallucination guide.
- GitHub integration: docs.github.com webhook signature validation, best-practices-for-creating-a-github-app, handling-failed-webhook-deliveries, REST rate-limit best practices, choosing-permissions.
