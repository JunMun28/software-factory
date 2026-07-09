# Intake Prototype step — design (grilling doc)

**Status:** design complete — awaiting build approval (2026-07-08)
**Author:** Jun Mun + Claude (grill-with-docs / domain-modeling)
**Related:** intake wizard (`apps/intake`), interview brain seam (ADR 0007), review/summary step.

## Why

A submitter fills the intake wizard but can't always *see* what they're asking for.
Before Review, add a **Prototype** step: the user co-designs a clickable, high-fidelity
HTML mock of the experience they expect, chatting with the assistant to shape it. The
prototype travels with the request as a shared-understanding aid.

## Revised flow

```
Describe → Interview → Prototype (NEW, new-app only) → Review → Done
```

- **Prototype** sits between Interview and Review.
- Layout: **chat on the left, live HTML prototype in an iframe on the right.**
- The user chats to update the prototype and can **annotate** a region of the preview
  to target an edit.

## Requirements (from the request)

1. Chat on the left, the prototype HTML on the right.
2. The user can chat to update the prototype.
3. An **annotation** function: the user marks the part they want to edit.
4. Generation quality copies the **baoyu-design** harness (a distillation of
   claude.ai/design) so the output looks amazing.

## Decisions log

Locked decisions become ADRs at the end; open threads drive further grilling.

### Round 1 — foundations (LOCKED)

| # | Decision | Choice | Consequence |
|---|----------|--------|-------------|
| D1 | **Role of the prototype downstream** | **Shared-understanding aid** — attached to the request as reference for the reviewer and the factory build; NOT a binding pixel contract. | The build may improve on it. Lowest coupling: a throwaway LLM mock never blocks or over-constrains the real build. Prototype persists on the request as reference. |
| D2 | **Which request types get Prototype** | **New app only.** Bug / Enhancement / Other skip straight to Review. | Wizard routing branches on `type === 'new'`. Keeps the mock where a fresh UI actually needs visualizing. |
| D3 | **Fidelity** | **Hi-fi styled prototype** (baoyu-design harness). | Real typography/color/spacing/components. Raises the generation bar → justifies copying the baoyu harness. Must be CSP-safe + single-file (see research). |
| D4 | **First draft on arrival** | **Auto-generate from the interview.** On entering the step, generate a first prototype from Describe + interview answers so there's always something to react to. | Needs a generation call on step entry (reuse the SSE streaming path). Empty-canvas cold start avoided. |

### Round 2 — scope & interaction

| # | Decision | Choice | Consequence |
|---|----------|--------|-------------|
| D5 | **Screen scope** | **Single primary screen, expandable via chat.** Seed one key screen; user grows it to more screens in the *same* self-contained HTML via in-page nav (`[data-screen-label]`). | Reliable generation, coherent edits, precise annotation. Fits CSP single-file. |
| D6 | **Gating** | **Encouraged, soft-gate.** Skippable, but "Skip / Submit without a prototype" shows a confirm. Auto-drafted on arrival; "Continue to Review" anytime. | Nudge without a hard block; a generation failure never traps the user. Routing branches on `type === 'new'`. |
| D7 | **Downstream surfacing** | **Review renders it + the build gets it.** Live preview card next to the AI summary; `prototype_html` travels with the request as reference context for the human reviewer and the factory build (reference-only, not binding). | Review UI gains a prototype card; the build's context bundle includes the HTML. End-to-end shared understanding. |
| D8 | **Generation model** | **`FACTORY_PROTOTYPE_MODEL` defaults to sonnet-5** (revised — see note). Own `PROTOTYPE_TIMEOUT` ~240 s. Opus-4.8 available via env for max quality. | Taste ≥ 7 for the most visual output in intake; haiku/codex rejected (taste too low). |

> **D8 revised during the live walk (2026-07-08):** originally opus-4.8, but on this *interactive*
> step opus is thinking-heavy and slow, so its short prose preamble didn't stream visibly — the
> live "typewriter" stalled (user-reported). **sonnet-5** clears the taste≥7 bar AND token-streams
> smoothly (confirmed: first delta at ~2 s), matching the interview. Opus stays one env var away
> (`FACTORY_PROTOTYPE_MODEL=claude-opus-4-8`) for anyone who prefers quality over streaming/latency.
| D9 | **Reopen from Review** | **Reopenable.** Review's prototype card has "Edit prototype" → routes back to the Prototype step, state intact, edits persist, Review preview updates. | Mirrors the interview's "Add more detail" reopen. Adds a route back + a `reopen`-style allowance. |

Still being grilled (one at a time): required vs skippable · does the prototype travel into
Review + the downstream build · model/taste-vs-cost for generation · finish + reopen.

### Research landed (2026-07-08) — see the two research docs

The `prototype-step-research` workflow (6 agents) produced a full blueprint grounded in our
seams. Docs: [prototype-step-research.md](../../research/2026-07-08-prototype-step-research.md)
and [baoyu-design-harness.md](../../research/2026-07-08-baoyu-design-harness.md).

**Key finding on the harness:** the *real* `jimliu/baoyu-design` (fetched, 41 KB
`system-prompt.md`) defaults to **multi-file React+Babel over HTTP with CDN scripts** — which our
strict CSP (no network) + `iframe srcdoc` would refuse to render. So we base generation on
Anthropic's single-file/CSP-native **`artifact-design`** skill, and harvest baoyu's *design craft*
+ its **"Review context"** annotation convention (DOM-node id stamped on the live node +
`[data-screen-label]`) — which independently matches our planned `data-pid` inspector.

**Technical defaults ADOPTED from research** (recorded now; say the word to override any):

- **A1 Generation model:** rewrite/patch/chat **triarchy**, model picks per turn. First draft =
  rewrite; edits = patch by default; questions = chat (no new revision).
- **A2 Reply contract:** reuse interview's prose-first + `===PROTO===` marker + JSON tail; full
  docs in a fenced ```html block (add `extract_html_block()`); patch = unique `find`/`replace`,
  fail → forced-rewrite once → else keep prior + soft message.
- **A3 Annotation:** ONE mechanism — a thin element-inspector injected into the iframe at render
  time (toggle in the preview toolbar), `data-pid` stamped at generation + back-filled on load,
  `postMessage {pid, selector, tag, textSnippet, outerHTML_excerpt, rect}` to the parent. Anchor
  to the element, never x/y. v1 = text anchor (no screenshot).
- **A4 Sandbox/CSP:** `iframe srcdoc sandbox="allow-scripts"` (never with `allow-same-origin`) +
  injected CSP `<meta>` + lightweight server scrub.
- **A5 Streaming/背景:** clone `_stream_worker`/`/interview/stream` → `/prototype/stream` (stream
  prose deltas only); add `prototype_gen.py` mirroring `interview_gen`/`summary_gen` (SYNC mode,
  in-process lock, first-draft only when 0 turns).
- **A6 Versioning:** one revision per build turn; linear history; **undo-last in v1** (restore =
  append a copy); full version dropdown later.

### Round 3+ — open judgment calls (grilling continues)

## Domain model (ubiquitous language)

- **Prototype** — a single self-contained HTML document (inline CSS/JS, no external
  network) rendered in the right-hand `iframe srcdoc`; a high-fidelity mock, not real software.
  The *current* prototype = the latest **revision** with non-null HTML.
- **Prototype turn** (`PrototypeTurn`, append-only, ordered) — one exchange. Carries
  `instruction` (user chat msg; null for the auto first-draft), optional `annotation`, a
  `mode` (`rewrite | patch | chat`), the assistant `note` (streamed prose), and the resulting
  `html` (null for `chat`). Modeled on `InterviewTurn`; the log is append-only (never mutate).
- **Revision** — a turn whose `mode` produced HTML (rewrite or a successful patch). `chat`
  turns add none. History is **linear**; **undo-last** = append a copy of revision N−1.
- **Annotation** — a marker anchoring an edit to a DOM element (never x/y):
  `{pid, selector, tag, textSnippet, outerHTML_excerpt, rect}`. Produced by the injected
  inspector; rides with the next instruction as scoped context.
- **Harness** — the generation prompt bundle: Anthropic `artifact-design` (single-file/CSP base)
  + harvested baoyu-design craft + baoyu's "Review context" annotation convention. Two prompts:
  **B1** first-draft (rewrite), **B2** edit turn (patch/rewrite/chat). See the harness doc.
- **`prototype_html` / `prototype_status`** (`none|draft|edited|skipped`) — denormalized cache
  on `Request` (mirrors `summary: JSON`) for cheap iframe hydration + downstream Review/build.

State machine: `none → draft` (first auto-rewrite) `→ edited` (any user build turn) ; `→ skipped`
(soft-gate skip). Reopen from Review returns to `edited`/`draft` without losing revisions.

## Proposed ADRs (to write at build time)

1. **Prototype step is a shared-understanding aid, not a binding spec** (D1) — the build reads
   it as reference context only; it never gates or over-constrains downstream work.
2. **Revisions are append-only `PrototypeTurn` rows; the current doc is a denormalized cache**
   (extends the append-only log ethos; keeps the hot Request row light).
3. **Generation reuses the ADR-0007 brain seam + interview SSE/background-gen plumbing**, on a
   dedicated `FACTORY_PROTOTYPE_MODEL` (opus-4.8) + `PROTOTYPE_TIMEOUT` (D8).
4. **Prototypes are rendered in a locked-down `iframe srcdoc sandbox="allow-scripts"` under an
   injected `default-src 'none'` CSP**; annotation via an injected inspector + `postMessage`.

## Implementation plan (phased) — build only after approval

- **Phase 0 — model + docs.** `PrototypeTurn` + Request cache cols (auto-migrate ADD COLUMN),
  `schemas.py`, ADRs 1–4. Deterministic `ScriptedBrain.generate_prototype` stub (static mock).
- **Phase 1 — backend seam.** `PROTO_MARKER` + `extract_html_block()` in `agent_exec.py`; B1/B2
  harness prompts + `generate_prototype[_stream]` on `AgentBrain`; patch apply + forced-rewrite
  fallback; `prototype_gen.py` (mirror `interview_gen`/`summary_gen`, SYNC mode). Unit tests.
- **Phase 2 — endpoints.** `GET /prototype(?gen)`, `GET /prototype/stream`, `POST /prototype`,
  `POST /prototype/skip`, `POST /prototype/restore`; `_stream_worker` twin. Router tests.
- **Phase 3 — frontend.** `submit/:id/prototype` route (branch `type==='new'`); `prototype.ts`
  (chat-left / iframe-right / annotation toggle / composer chip / undo); inspector snippet;
  `api.service.ts` + `models.ts`. Reuse the interview's EventSource `openStream`.
- **Phase 4 — Review + build wiring.** Prototype preview card + "Edit prototype" reopen on
  Review; include `prototype_html` in the request/build context bundle.
- **Phase 5 — verify.** `task verify` green; live walk (auto-draft → chat edit → annotate-edit →
  undo → skip/continue → Review shows it), light + dark.

## Open questions carried into build (non-blocking, research-flagged)

- Token budget per edit turn (resend full HTML for coherence vs lean on patch ops) — cost knob.
- Multimodal annotation (cropped-rect screenshot → codex `--image`) — deferred to a later fidelity pass.
- Marquee/multi-select annotation — v1 is single-element click; marquee is the "whole area" escape hatch.
- Patch-fallback UX copy when both patch and forced-rewrite fail.
