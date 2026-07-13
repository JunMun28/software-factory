# E2E Browser Test — Results (2026-07-13)

**Plan:** [2026-07-13-e2e-browser-test-plan.md](2026-07-13-e2e-browser-results.md) · **Driver:** agent browser (`mcp__Claude_Browser__*`) + HTTP · **Verdict: GO** (one bug found and fixed during the run)

**Environment:** the 5-dev-server cap (4 held by parallel chats) left only 1 slot, so a `dist` build of each Angular app was served **same-origin by the running FastAPI api** (a temporary SPA mount, since reverted) — the whole stack ran in one slot. Backend: `FACTORY_BRAIN=scripted` + sync pregen (deterministic). All temporary scaffolding (SPA mount, launch configs, scratch proxy) reverted; tree clean; `task verify` green.

## Result by suite

| Case | What was checked | Result |
|---|---|---|
| **A1** Composer | hero + animated composer render, attach button, ⌘↵ hint | ✅ (screenshot) |
| **A2** Classify + chip | bug desc → chip "Bug fix · quick path" **confident, cards collapsed**; click chip → cards expand; pick "Improve an app" → chip "Enhancement · short path", basics re-shape | ✅ |
| **A3** Basics per-track | bug: app picker (registry apps) + evidence "Link added" + frequency; enh: **rings picker live count** ("A department · 10–50 people") + **impact card reveals estimate input**; later sections **staged/locked** until earlier answered | ✅ |
| **A4** Interview | thread + AI question bubble + composer/skip; **live Plan panel** updates with seeded facts; bug reaches done at **ceiling 3** | ✅ (screenshot) |
| **A6** Review | **compact `.review--compact`** for bug (short track), no full-layout aside, shared "what happens next" footer + Submit | ✅ (screenshot) |
| **A7** Done | "Request received" + REQ-2120 + lifecycle stepper + Track/File-another | ✅ (screenshot) |
| **A8** My Requests | list renders, just-filed request at top ("updated now · Spec drafted"); reviewer-question respond card | ✅ (screenshot) |
| **B1** Mission control | gate cards (SPEC/MERGE gate) with Approve/Send back/Open | ✅ (screenshot) |
| **B2** Approval queue | queue list + select request 88 + **Approve spec → confirm modal → approved** | ✅ (screenshot) |
| **B5** Map | SVG spatial lens renders | ✅ |
| **B6** Inbox | renders | ✅ |
| **B7** Registry | 4+ apps listed; registry apps appear in intake picker (cross-app) | ✅ |
| **B8** Settings | renders | ✅ |
| **C** Full lifecycle | submitter compose→submit (REQ-2120) **then** admin approve spec → `status=approved, stage=architecture`; merge/deploy gates via smoke test | ✅ (cross-app, browser) |
| **D1** Theme | light + dark both render cleanly (both apps) | ✅ |
| **Every screen** | zero console errors, no failed API calls | ✅ |

**Not driven in-browser:** A5 prototype step (new-app), full merge/deploy gate clicks — covered by the `task verify` smoke lifecycle and component tests. Full light/dark × mobile matrix abbreviated due to the single-slot constraint.

## Bug found and fixed during the run

**Stale interview question after a Track correction.** A request classified as one type, then corrected in Basics (or via an accepted escalation), kept the question **pre-generated for the old type** — a bug corrected to an enhancement was still asked the bug script's opener ("What did you expect to happen instead?"). Root cause: the type-change PATCH cleared the cached summary but not `pending_question`.

**Fix** (committed `47d9ea9`): clear `pending_question` on an actual type change in `update_request` and `escalate_interview`. Added 3 regression tests. Confirmed live (bug→enh correction now regenerates the enhancement opener) and full api suite green (182 passed).

## Minor observations (non-blocking)

- The `IntakeDraft` singleton is not reset when re-navigating to `/submit/new` via SPA nav mid-draft (stale draft persists). Normal entry ("File another" / fresh load) resets it. Worth a reset on the composer's `ngOnInit` or the "New request" nav.
- (Test-harness note, not an app defect) automated coordinate-clicks and `type` didn't always reach the signal-based buttons / ngModel; `form_input` and direct DOM `.click()` were reliable.
