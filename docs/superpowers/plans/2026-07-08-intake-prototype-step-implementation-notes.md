# Prototype step — implementation notes

Spec: [2026-07-08-intake-prototype-step-design.md](../specs/2026-07-08-intake-prototype-step-design.md)
Research: [prototype-step-research.md](../../research/2026-07-08-prototype-step-research.md) ·
[baoyu-design-harness.md](../../research/2026-07-08-baoyu-design-harness.md)

Approved 2026-07-08 to build all phases → done + `task verify` green. Not committing (per standing rule).

## Progress

- [x] Phase 0 — model + schemas + settings + ScriptedBrain stub
- [x] Phase 1 — backend seam (PROTO_MARKER, extract_html_block, harness prompts, generate_prototype[_stream], patch apply, prototype_gen.py) + tests
- [x] Phase 2 — endpoints (prototype quartet + _stream_worker twin) + tests — **167 pytest green, ruff clean**
- [~] Phase 4 (backend half) — draft_spec now includes prototype_html as reference (build gets it)
- [x] Phase 3 — frontend: `prototype.ts` (chat+iframe+point-to-edit inspector), route, sub-shell 4-step, interview→prototype flow, api.service/models — **intake build clean**
- [x] Phase 4 (frontend half) — Review prototype preview card (sandboxed iframe) + "Edit prototype" reopen + "Add a prototype" when absent
- [x] Phase 5 — live walk (Playwright, scripted brain): 4-step wizard → auto-draft → chat edit → undo → continue → Review card, both themes, zero console errors. Final `task verify` re-run after CSP fix.

## Deviations

- **Render-time CSP injection (not just per-doc CSP).** The live walk surfaced that a prototype
  doc's own CSP meta (`default-src 'none'` without `script-src`) blocks the injected point-to-edit
  inspector's inline `<script>`. Conservative fix: added `prototypeSrcdoc()` in `@sf/shared` that
  **strips the doc's CSP and injects an authoritative one** (allow inline script/style, block ALL
  network) at render time — so the inspector always runs and network is always blocked regardless
  of what the model emitted. Also added `script-src 'unsafe-inline'` + `connect-src 'none'` to the
  scripted stub's CSP for consistency. Both prototype.ts and review.ts render through it.
- Point-to-edit's in-frame **click** couldn't be automated (the `sandbox="allow-scripts"` frame is
  opaque-origin, so Playwright/parent can't synthesize a trusted click inside it). Verified instead
  by: inspector injects + runs with no CSP error, message handler + toggle wired, and the backend
  annotation path unit-tested (`test_prototype_annotation_rides_with_instruction`).

## E2E test (2026-07-08, scripted brain via Playwright)

Full pass, **zero console errors** throughout:
- Landing → redirects to `/submit/new`. New-request form: type select, validation (correctly
  blocked on missing **Impact** — "Still needed: Impact"), all fields, Continue.
- Rail is type-aware: **New app → Describe·Clarify·Prototype·Review**; Bug/Enhancement →
  Describe·Clarify·Review (no Prototype).
- Interview → auto-advances to **Prototype** (new-app). Prototype: auto-draft in the iframe, chat
  edit → revision, point-to-edit toggle arms, undo → revert, Continue → Review.
- Review: summary + prototype card + iframe; facts strip carries all Describe data; **Edit
  prototype** round-trips; **Submit → Done** ("Request received").
- My Requests lists the submitted request (unsubmitted draft excluded); request detail opens;
  theme toggle light↔dark. Backend gating: a bug request hitting `GET /prototype?gen=true` stays
  `status=none` (never seeds).
- **Finding fixed:** the Done/confirm page stepper omitted Prototype for new-app (fixed `[step]`
  fixed at 3 → `[proto]="type==='new'"` + `[step]=4/3`).
