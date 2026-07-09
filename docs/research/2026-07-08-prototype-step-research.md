# Prototype Step — Research Synthesis + Implementation Blueprint

*Produced by the `prototype-step-research` workflow (6 agents, 2026-07-08): parallel
briefs on v0, Lovable, Claude Design, and in-preview annotation UX, plus a harness study,
synthesized against our real seams: `api/app/agent_exec.py` (CLI seam),
`api/app/interview_gen.py` + `summary_gen.py` (background-gen), `api/app/routers/requests.py`
`_stream_worker` (SSE), `apps/intake/src/app/submitter/interview.ts` (EventSource), and
`api/app/models.py` `Request`. See the companion harness doc:
[baoyu-design-harness.md](2026-07-08-baoyu-design-harness.md).*

---

## 1. How the reference tools actually work

**v0 (Vercel)** is a *hybrid*: full regeneration by default, but a **QuickEdit** patch
path for "small changes… 1–20 lines, 1–3 steps," and it "only edits the relevant files…
DOES NOT rewrite all files for every change." Its Design Mode toggles from the toolbar
(`Cmd/Ctrl+I`), hover-highlights, click-selects, and — critically — "automatically attaches
a screenshot of the selected element along with your instructions," then serializes edit +
instruction into a new **version** (diffable, revertable). Restore is *linear*: "restoring
an old version creates a new, most recent version."
([design-mode docs](https://v0.app/docs/design-mode), [versions](https://v0.app/docs/versions))

**Lovable** splits **Agent Mode** (LLM patches specific files, diff engine "update[s] only
precisely modified lines") from **Visual Edits** (mostly non-LLM). Its key trick: a
compile-time Vite/Babel plugin stamps every JSX element with a **stable id**, so a DOM click
traces to the exact source node — true bidirectional mapping, no fragile coordinates. Simple
text/style edits skip the LLM entirely; *Select* and *Draw annotation* call the model. It
also separates **Chat/Plan Mode** (writes no code) from **Agent Mode**, with a
clarifying-**questions** tool before generating.
([visual-edits](https://lovable.dev/blog/visual-edits), [chat-mode](https://lovable.dev/blog/chat-mode-and-questions))

**Claude Artifacts / Claude Design** is the closest analog: one self-contained file per
message, a hidden decision step for create-vs-update, and a **create / update / rewrite**
triarchy. `update` is a surgical `old_str`→`new_str` replace where `old_str` "must match
exactly once" (silent failure otherwise — a documented bug); `rewrite` regenerates the whole
file. Guidance: "use update when only a small fraction changes; rewrite for major changes."
The `update` path is what made edits feel "lightning-fast." Its **single-file, no-network
constraint** is *identical in spirit to our strict CSP*. Refinement has three channels: chat
(structural), **inline comments/annotations** ("click directly on a specific part of the
canvas and request a targeted change"), and direct manipulation. Documented pitfall:
annotations "can disappear before Claude reads them."

**Annotation serialization patterns** distill to four: (a) DOM/selector overlay (DevTools,
v0, Lovable); (b) click-to-pin coordinate (Figma — *drifts* when layers rearrange, our exact
failure mode after regen); (c) marquee region over a screenshot (Stitch, Figma drag);
(d) handoff = source-node id (Lovable) *or* NL note + cropped screenshot to a multimodal
model (v0, Stitch) *or* selection as scoped context (Framer). Cross-tool consensus for a
document **we own and can inject JS into**: **anchor to the element, never bare x/y**, stamp
stable ids at generation, report via `postMessage`.

**Convergent lessons:** patch beats full-regen for edits (Claude/v0/Lovable all agree), but a
blind string-replace fails silently if the anchor drifts — validate uniqueness server-side
and fall back to rewrite. Never stream partial HTML into a live iframe (broken intermediate
DOM). Version once per turn, linear restore. Anchor annotations to elements + a text snippet.

---

## 2. Implementation blueprint for OUR stack

### 2.1 Data model (on/around the Request row)

Add a **`PrototypeTurn`** table modeled on `InterviewTurn` (append-only, ordered,
lazy-loaded — *not* eager in `to_out`, so `request_detail` polls stay cheap):

```
PrototypeTurn(id, request_id, order,
  instruction: Text|null,   # user's chat message (null for the auto first-draft)
  annotation:  JSON|null,   # {pid, selector, tag, textSnippet, outerHTML_excerpt, rect}
  mode:        str,         # 'rewrite' | 'patch' | 'chat'
  note:        Text|null,   # the assistant's short prose preamble (the streamed part)
  html:        Text|null,   # resulting full document; null on mode='chat'
  created_at)
```

Denormalize a small cache on `Request` (mirrors the existing `summary: JSON` freshness pattern):

- `prototype_html: Text|null` — current document, for cheap iframe hydration + downstream Review/build.
- `prototype_status: str` — `none | draft | edited | skipped`.
- First-draft freshness keyed like `summary.at_turns`: auto-draft only while `PrototypeTurn`
  count is 0; once the user has any turn, never auto-regenerate (don't clobber their work).

Why a table, not JSON-on-Request: each hi-fi doc is 10–50 KB; storing N revisions in one JSON
column bloats the hot Request row every detail poll loads. **Current prototype = latest turn
with non-null `html`.**

### 2.2 Chat loop — first-draft rewrite, edit-turn patch

Adopt Claude Design's **rewrite / patch / chat** triarchy, dispatched by the model per turn:

- **First draft (step entry):** always a full **rewrite** from Describe + interview Q&A (D4).
- **Edit turns:** default to **patch** (short `find`/`replace` ops the server applies).
- **Chat turns:** `mode='chat'` produces no new revision — just an assistant message
  ("what font is this?" must not regenerate the doc).

**Reply contract — reuse the interview's prose-first + marker + JSON-tail machinery**
(`_question_prompt` / marker / `_visible_prose` / `extract_json` in `agent_brain.py`). Define
`PROTO_MARKER = "===PROTO==="`:

```
<1–2 sentence prose preamble: what I'm changing and why>   ← streamable
===PROTO===
{"mode":"patch","note":"...","ops":[{"find":"<short unique snippet>","replace":"<new snippet>"}]}
```

For `mode:"rewrite"` the tail JSON is `{"mode":"rewrite","note":"..."}` and the **full
document follows in a single fenced ```html block** (never JSON-embed a 40 KB doc). Add a tiny
`extract_html_block()` sibling to `extract_json()`. Prose before the marker streams to chat;
the tail/HTML is parsed server-side and applied atomically.

**Patch robustness (the Claude `update` bug):** each `find` must occur **exactly once**. On
zero/multiple match, or if the result loses `<html`/`<body`, **abort and auto-fall-back once
to a forced rewrite**; if that also fails, keep the previous revision and post a soft message.
A bad turn must never destroy the working doc.

### 2.3 Annotation — ONE mechanism: injected element-inspector → scoped context

We own and generate the document, so we exploit that (Lovable's insight without their AST/Vite stack):

1. **Stamp anchors at generation.** The harness instructs the model to put `data-pid="…"` on
   meaningful nodes; the injected inspector back-fills any missing pid on load, so click→target
   is deterministic.
2. **Inject a thin inspector at render time only** (Angular concatenates
   `stored_html + INSPECTOR_SNIPPET` into `srcdoc`; the **stored** HTML stays clean so
   Review/build see a pure prototype). An explicit **toggle** in the preview toolbar
   ("Point to edit"); on: `pointerover` draws an overlay, click selects; a **drag-marquee** is
   the "this whole area" escape hatch.
3. **Anchor to the element, never x/y.** On pick, `postMessage` to the parent:
   `{pid, selector, tagName, textSnippet, outerHTML_excerpt (~600 chars), rect}`. Parent
   validates `e.source === iframeEl.contentWindow`.
4. **Annotation is additive to the chat turn** (a composer chip "Editing: *Hero heading*"); the
   annotation JSON rides with the next POST as scoped context; the edit prompt says "change only
   this element, preserve everything else."

**Screenshot: skip for v1.** Both CLIs are text-first; a CSP-safe in-browser crop is hard. The
outerHTML anchor is a stronger, cheaper signal. Multimodal cropping (codex `--image`) is a later
upgrade.

### 2.4 iframe sandbox + CSP

- `<iframe srcdoc sandbox="allow-scripts">` — `allow-scripts` **only**; never with
  `allow-same-origin` (that combo escapes the sandbox). Null-origin frame still runs its JS +
  the inspector and can `postMessage`, but can't touch parent DOM/cookies.
- Inject a defense-in-depth CSP `<meta>`: `default-src 'none'; style-src 'unsafe-inline';
  script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'`.
- Lightweight server-side scrub of external `src`/`href` before store. Sandbox + injected CSP
  are the real enforcement.

### 2.5 Streaming (reuse the SSE plumbing verbatim)

Clone `_stream_worker` + `/interview/stream` into a `/prototype/stream` twin, and the frontend
`openStream()`:

- Stream **`delta` = the prose preamble only** — *never the HTML* (partial HTML into a live
  iframe = broken DOM).
- Terminal **`state` event** carries the applied revision; the iframe `srcdoc` swaps atomically.
- **codex path degrades identically to today's interview:** no token stream, a "thinking…" row,
  then terminal state. claude path streams the preamble.

### 2.6 Background generation (reuse `interview_gen`/`summary_gen`)

Add `prototype_gen.py` mirroring those modules: in-process `_lock` + `_inflight`,
`acquire`/`release`, daemon thread, shared **`SYNC`** mode for tests/smoke. Single-worker
uvicorn makes the in-process registry sufficient. `ensure_first_draft(rid)` kicks generation
only when `PrototypeTurn` count is 0. Reuse `_run_with_attachments` so a mockup image attached
in Describe/Interview grounds the first prototype.

### 2.7 Brain seam methods

Extend the ADR-0007 seam (`get_brain()`), adding to `ScriptedBrain` (offline static mock) and
overriding in `AgentBrain`:

- `generate_prototype(req, instruction, annotation, current_html) -> {mode, html|ops, note}` (batch).
- `generate_prototype_stream(req, …)` yielding `{'type':'delta',…}` then `{'type':'done','revision':…}`.

Give the prototype its own **`PROTOTYPE_TIMEOUT`** (180–240 s; a full hi-fi doc is a bigger
generation than a 120 s interview question).

### 2.8 Endpoints (mirror the interview quartet)

- `GET  /api/requests/{rid}/prototype?gen=` → `{html, turns, thinking, status}`.
- `GET  /api/requests/{rid}/prototype/stream` → SSE prose deltas + terminal state.
- `POST /api/requests/{rid}/prototype` → `{instruction, annotation?}`; records the turn, kicks
  generation, returns `thinking`.
- `POST /api/requests/{rid}/prototype/skip` and a "Continue to Review" action.
- (optional) `POST /api/requests/{rid}/prototype/restore` `{order}` for undo/restore.

### 2.9 Versioning & gating

- **One revision per build turn**; chat turns add none. **Linear** history; **restore = append
  a new latest revision** copying the target (v0's rule — no branching). v1 ships **undo-last**;
  a full dropdown is a later add.
- **New-app only** (D2) — add `submit/:id/prototype` between interview and review; branch on
  `type === 'new'`.
- **Skippable, never required** — the prototype is a shared-understanding aid (D1); auto-draft on
  entry (D4), iterate or "Continue to Review" anytime, plus "Skip prototype" that advances with
  nothing attached. Never block submission.

### 2.10 Model / taste note

The default brain model is `claude-haiku-4-5` — fine for a one-line interview question,
**under-powered for a hi-fi prototype where the harness is the entire point** (user rule:
user-facing work needs taste ≥ 7). Run the prototype seam on a higher-taste model
(`FACTORY_PROTOTYPE_MODEL` override; opus/sonnet on claude, or route through codex/gpt-5.5). A
build decision, not a silent default.

---

## Files to touch (from the synthesis)

`api/app/models.py` (PrototypeTurn + Request cache cols), `api/app/prototype_gen.py` (new),
`api/app/agent_brain.py` + `interview.py` (seam methods, harness prompts), `api/app/agent_exec.py`
(`extract_html_block`, `PROTO_MARKER`), `api/app/routers/requests.py` (prototype endpoints +
`_stream_worker` twin), `api/app/schemas.py`, `api/app/settings.py` (`PROTOTYPE_TIMEOUT`,
`FACTORY_PROTOTYPE_MODEL`), `apps/intake/src/app/app.routes.ts`,
`apps/intake/src/app/submitter/prototype.ts` (new), `packages/shared/src/lib/api.service.ts` + `models.ts`.
