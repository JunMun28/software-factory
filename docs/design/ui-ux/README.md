# AIRES — UI/UX Design Documentation

> Design document only — **no code yet**. Research-backed (Linear + Slack + best practice), produced by a multi-agent design workflow. Respects ADR-0004 (milestone summaries, not streaming), ADR-0007 (FastAPI + Angular, polling now), ADR-0008 (two-axis progress_event log).

## Brand: Micron alignment

The accent is **Micron purple `#BD03F7`** (Micron's current official brand color, per
[brand.micron.com](https://brand.micron.com/brand-guidelines/color.html) — black/white base + a vivid
purple accent "used minimally but intentionally"). This maps cleanly onto our restrained, single-accent
system. Rules:

- **Accent = Micron purple `#BD03F7`** (focus ring `#CE57F9`; for small text on light backgrounds use a
  deeper `accent-strong #9B02C9` to hold WCAG AA). Used only for primary actions, focus, active/selected
  state, the `Started` status, and brand moments.
- **Base = black + white neutrals** (already our foundation: near-black dark canvas, off-white light).
- **Gradients: sparing — brand moments only** (login hero, empty states, logo lockup). Working surfaces
  (board, feed, forms, detail) stay flat for legibility.
- **Functional status colors are kept and are NOT brand:** amber `#9A6700` (a gate needs you), red
  `#D1242F` (Needs-human), green `#1A7F37` (done / gate passed) — the light-theme (default) values;
  the dark opt-in uses brighter equivalents (`#E3B341` / `#F2545B` / `#3FB950`). These carry meaning;
  purple never replaces them.

Everywhere below, read the former "indigo" accent as Micron purple `#BD03F7`.

## Documents

- **README.md** (this file) — design foundation: principles, design system, navigation, flows.
- **[design-system.md](design-system.md)** — consolidated tokens + reusable component inventory.
- **[screens.md](screens.md)** — full design spec for all 15 screens.
- **[image-prompts.md](image-prompts.md)** — one render-ready prompt per screen (for visualization).
- **[claude-design-brief.md](claude-design-brief.md)** — the mockup handoff brief.

## Recommended reading / build order

1. Open with a shared FOUNDATION section (before any screen) that pins the cross-cutting contracts every screen references, so they stop being re-litigated per-spec: (a) Vocabulary table — the audience fork for Canceled/Cancelled and Needs human/Needs a human, the Admin-only terms (Subject, Work item, Draft spec, send-back, gate, status_type, Triage), and the fixed Submitter plain-stage set {Submitted, Spec drafted, Approved, Building, In review, Deployed, Needs a human, Cancelled}; (b) Status-type → glyph mapping (one authoritative table: Triage=dotted, Started=ring, Completed=check, Canceled=strike; Needs-human=red overlay); (c) Color/attention tiering (amber=gate, red=Needs-human, the green add/remove exception); (d) The Streaming boundary statement (S2 only); (e) Shared shell/token notes (two faces of one system, light-default Admin (light is the default for both faces; dark is an opt-in), light-default Submitter).
2. Then order screens by the two user journeys, Submitter first (the front door, the simpler face), Admin second (the dense workhorse), each in lifecycle order — this matches how a reviewer walks the product and how a card flows.
3. SUBMITTER JOURNEY: S0 Login/SSO → S1 New Request form → S2 Intake interview → S3 Submission confirmation → S4 My Requests list → S5 Request detail + respond-to-send-back. (Login first because it is the shared pre-fork front door; place it under Submitter since it renders in the light/Submitter register by default.)
4. ADMIN JOURNEY, shell-then-surfaces: C0 Control-center shell (the frame everything lives in — must come first) → C1 Board → C2 List view → C3 Approval queue/Triage (the Stage-1 workhorse) → C4 Request/Work-item detail side-panel → C5 Per-app Progress feed → C6 Needs-me inbox → C7 App registry → C8 Settings/Notifications. (Rationale: shell defines the inverted-L and keyboard layer all others inherit; Board is the default landing; Approval queue + Detail are the daily gate work; Feed/Inbox are the attention surfaces; Registry/Settings are low-frequency reference/config last.)
5. Add a closing GAPS & DEFERRED section listing the explicitly-out-of-scope-for-Stage-1 surfaces that other screens reference but don't yet exist — S6 Notifications (email + in-app notice component), Admin GitHub-identity linking, the Submitter cancel-notice flow, and the Progress timeline/Code-change/Recovery LATER halves of C4 — so their absence is documented as intentional, not missing.
6. Within each screen spec, keep the existing field order (purpose → layout → keyComponents → states → interactions → borrows → responsive → accessibility → imagePromptSeed → claudeDesignNotes) — it is consistent and works; do not restructure individual specs, only prepend the shared Foundation so per-spec 'borrows'/notes can reference it instead of repeating the same restraint/streaming/glyph rules ~16 times.

---

I have all the research I need. The task is to condense it into one tight design foundation. Writing it now.

# AIRES — Design Foundation

The single source of truth every screen spec builds on. App = **Intake form** (Submitters: MS SSO, conditional form, AI interview, draft spec) + **Control center** (Admins: Kanban, Approval queue/Triage, per-app Progress feed, Needs-me inbox, Request/Work-item detail, App registry). North star: **Linear's speed + restraint, Slack's feed legibility, milestone summaries not streaming, polling now.** Built for a handful of Admins — do not over-build.

---

## 1. Design principles (the UX north star)

1. **Quiet by default, loud only when it matters.** The whole UI lives in a calm neutral+Micron purple register. Only two things are allowed to be loud: **a gate waiting on you** (amber) and **Needs-human** (red). Tier by consequence everywhere — Tier-1 (gates, Needs-human) interrupts via the Needs-me inbox; Tier-2 (feed activity) is an ambient unread dot; Tier-3 (a card merely changing column) is nothing.
2. **Structure felt, not seen.** Hairline low-contrast borders, whitespace and the 8px rhythm carry hierarchy — not boxes and rules. Chrome (sidebar, rails) recedes; the work (a board, a Draft spec under review, a Progress thread) sits at full contrast.
3. **Keyboard-first, mouse-optional.** Cmd+K, G-nav, and single-key gate actions are the primary input model for Admins. Hover-to-reveal-shortcut tooltips graduate users from mouse to keyboard. Every primary Admin action has keyboard parity.
4. **Density with grouping, not noise.** One scannable line carries app · type chip · stage glyph · attention badge · owner. Group related info; separate zones with whitespace. Optimize for the daily-repeat expert, not the novice.
5. **Felt speed without a sync engine.** Optimistic UI on gate actions + signal-based granular re-render + diff-merge polling (keyset `?after=<event_id>` cursor) = ~80% of Linear's feel on a polling FastAPI+Angular stack. Never whole-board refresh-flash; only changed cards transition.
6. **Grounded approval beats fast approval.** Provenance tags `(from: Q2)`/`(ASSUMPTION)` and a pinned Open-questions/Assumptions block are the anti-rubber-stamp mechanism — kept unavoidable in the reviewer's eye-path. Friction is good at exactly one place: the irreversible Approve.
7. **Status type by shape, status by color.** A glyph (dotted/ring/check/strike) carries the type so it reads color-blind; color is a signal layered on top, never the only cue (WCAG 1.4.1). Needs-human is a red overlay badge, not a column or a type.
8. **Two faces, one system.** Submitter (guided, light-friendly, 16px, mobile-first, plain-stage vocabulary) and Admin (dense, light-default, 14px, keyboard) are forked shells under one auth + one token set. Submitters never see GitHub, the Draft spec internals, or Control-center words.
9. **Hold the ADR-0004 line.** The Slack metaphor must not smuggle back streaming: no presence, no typing, no per-milestone push, no `chat.update` on historical summaries. Milestone summaries are immutable; only the per-thread status header edits in place.
10. **Restraint as a feature.** Skip WIP limits, reviewer rotation/honeypots, push infra, OR-filters, user-authored views, predictive widgets, IndexedDB sync. Build the keyboard-fast core; defer the rest.

---

## 2. Design system

**Token architecture.** Three tiers: primitive → **semantic** (intent-named, theme-aware: `bg-canvas`, `text-primary`, `border-subtle`, `accent`, `focus-ring`) → component. Plain CSS custom properties; `:root` = light, `[data-theme="dark"]` = dark, default from `prefers-color-scheme`. Components reference only semantic tokens, so a non-compliant pair can't be wired and theming is a variable swap. Linear-style three conceptual knobs: **base / accent / contrast**.

**Palette** — directional hex; verify pairs to 4.5:1 text / 3:1 non-text before locking. Neutrals carry a faint cool/Micron purple tint (never pure gray). **Light is the primary/default theme for both Submitter and Admin; dark is an opt-in.**

*Dark (opt-in):*
| token | hex | use |
|---|---|---|
| `bg-canvas` | `#0B0C0E` | app background (near-black, not pure black) |
| `bg-surface` | `#141518` | cards, columns, panels |
| `bg-surface-raised` | `#1B1D21` | popovers, menus, modals, Cmd+K |
| `bg-input` | `#202329` | inputs, hover wells |
| `border-subtle` | `#23252A` | hairline dividers, card edges |
| `border-strong` | `#33363D` | input borders, focused edge |
| `text-primary` | `#F2F3F5` | headings/copy (off-white, never `#FFF` — avoids glare) |
| `text-secondary` | `#9DA3AE` | labels, metadata, timestamps |
| `text-tertiary` | `#6B7079` | disabled, faint hints |
| `accent` | `#BD03F7` | brand/primary action (Micron purple) |
| `focus-ring` | `#CE57F9` | focus-visible outline (>3:1 all surfaces) |

*Light (secondary):* `bg-canvas #FBFBFC` · `bg-surface #FFFFFF` · `border-subtle #E8E9ED` · `border-strong #D0D2DA` · `text-primary #16181D` · `text-secondary #5A606B` · `accent #BD03F7`.

*Semantic/status (map to `status_type` + gates; always paired with glyph/label):*
| token | dark | light | meaning |
|---|---|---|---|
| `status-triage` | `#8A8F98` | `#6B7079` | Intake / Triage |
| `status-started` | `#BD03F7` | `#BD03F7` | Spec→Deploy in progress |
| `status-completed` | `#3FB950` | `#1A7F37` | Done / gate passed |
| `status-canceled` | `#6B7079` | `#9DA3AE` | cancelled |
| `attention-gate` | `#E3B341` (amber) | `#9A6700` | **Needs me** — gate waiting |
| `attention-blocked` | `#F2545B` (red) | `#D1242F` | **Needs human** (escalation overlay) |

Amber and red are the **only** loud colors in the whole product.

**Typography.** `"Inter var", "Inter", "Segoe UI", system-ui, sans-serif` (Segoe first = native to the Windows shop). Mono: `"Cascadia Code", "JetBrains Mono", ui-monospace, Consolas, monospace` for PR refs, branches, diffs, SPEC.md. Weights kept tight: `400` body, `500` UI labels/buttons/emphasis, `600` headings (no heavier). Negative tracking on large sizes is the Linear tell.

| token | size/line-height | tracking | use |
|---|---|---|---|
| `display` | 32/1.25 | -0.02em | Intake hero |
| `h1` | 24/1.33 | -0.015em | detail title, Request title |
| `h2` | 20/1.4 | -0.01em | section headings |
| `h3` | 16/1.5 | -0.005em | card titles, panel headings |
| `body` | 14/1.6 | 0 | **Admin default** — board, feed, forms |
| `body-lg` | 16/1.6 | 0 | **Submitter default** — form copy, Draft-spec reading |
| `caption` | 13/1.5 | 0 | metadata, timestamps, feed context line |
| `micro` | 11/1.4 | +0.01em | badge/pill labels (uppercase) |

**Spacing.** 4px base, 8px-rhythm bias: `0·4·8·12·16·20·24·32·40·48·64·80`. Card padding 16/24; element gap 8/12; column gutter 16; section gap 48+. Centered views max ~1200px; the board is full-bleed horizontal.

**Radii.** `xs 2px` (pills/badges) · `sm 6px` (inputs, buttons, menu items, nav) · `md 8px` (popovers, small cards) · `lg 12px` (cards, modals, columns) · `full 9999px` (avatars, dots). Small and crisp, never bubbly.

**Elevation.** Dark = surface-lightness + a 1px inset hairline border as the real depth cue (shadows read weakly on near-black). Light = true soft shadows. `elev-0` flat+`border-subtle`; `elev-1` inset border + `0 2px 4px rgba(0,0,0,.4)` dark / `0 1px 3px rgba(16,24,40,.10)` light; `elev-2` `0 4px 24px rgba(0,0,0,.6)`+inset / `0 8px 24px rgba(16,24,40,.12)` light.

**Motion.** Animate **only `transform` + `opacity`** (compositor-only). Asymmetric: summon instant, dismiss fade. Durations: `instant 80` (hover/press) · `fast 120` (**default** — menus, tooltips, state/badge changes, card hover) · `base 160` (popover/drawer open, optimistic card move) · `slow 220` (modal/palette/route). Stay in the 100–150ms band. Easing: `ease-out cubic-bezier(0.16,1,0.3,1)` (default entrances), `ease-in-out cubic-bezier(0.65,0,0.35,1)` (state-to-state, card sliding columns), `ease-in cubic-bezier(0.4,0,1,1)` (exits). Motion is feedback, not decoration. **Mandatory `prefers-reduced-motion` guard** — swap slides/scales for opacity cross-fades, don't just kill transitions. **The poll must never auto-animate on every 3–5s refresh** — diff-merge so only changed cards transition.

**Iconography.** De-iconified, monochrome line icons inheriting `currentColor`, scaled down, no colored backgrounds. Status-type glyphs are the load-bearing set: **dotted circle = Triage**, **progress ring (fill = position in the 6-stage run) = Started**, **solid check = Completed**, **strike = Canceled**. Needs-human = red overlay badge on the glyph. ≥24px hit area even when visually smaller (WCAG 2.5.8).

**Accessibility floor.** WCAG 2.2 AA: 4.5:1 text / 3:1 non-text enforced at token level; color never alone; global `:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px }`; focus not obscured by sticky headers/overlays (2.4.11); ≥24px targets (2.5.8); reduced-motion honored. Ship a high-contrast theme cheaply via the three-token model.

---

## 3. Navigation model + full screen list

**Two shells, one auth, one design system.** Role from the validated Entra session forks the experience at login.

- **Submitter shell:** minimal top bar, no sidebar, no Cmd+K. Two destinations: New Request, My Requests. Mobile-first, one-and-done.
- **Admin shell (Control center):** the inverted-L — persistent **left sidebar** + **top header** (filters + list/board toggle + Cmd+K) framing one **dense center**, with the Request/Work-item detail opening as a **right side-panel in place** (not a route change, board stays as context). Same shell reused for Kanban, Approval queue, feed, inbox — only the center swaps.

**Admin sidebar (top→bottom):** (1) **Needs me** (badge-counted, the only interrupt) · (2) **Approval queue / Triage** (the Stage-1 workhorse) · (3) **Board / List** toggle (shared filter state) · (4) **Saved views**: Waiting on me · Needs human · Active builds · Per app (3–4 built-ins, flat AND-only filters, no user-authored views) · (5) **Apps** (App registry + per-app Progress feed channels) · (6) **Settings** (minimal). Chrome dimmed so the center advances.

**Keyboard grammar.** **Cmd+K** over the already-loaded local list: jump to app/Request, filter to Waiting-on-me, approve/send-back/cancel, @-assign, open a thread. **G-nav:** `G I` inbox · `G T` triage/approval · `G B` board · `G F` feed · `G A` apps. **Single-key on focused item:** `A` approve · `S` send-back · `C` cancel · `J/K` move selection · `Enter` open detail. **Hover-reveal shortcut tooltips** throughout.

**Full screen list** ([NOW] = Stage 1, [LATER] = skeleton built now, fills in Stages 2–6):

*Submitter:* S0 Login (MS SSO, shared, role routes) [NOW] · S1 New Request form (type-first conditional fields) [NOW] · S2 Intake interview chat (same window, ~3–4 follow-ups) [NOW] · S3 Submission confirmation (plain-stage tracker primed) [NOW] · S4 My Requests (scoped to self, plain stages) [NOW] · S5 Request detail (Submitter, plain) [NOW] · S5b Respond-to-send-back (first-class, not a hidden mode) [NOW] · S6 Submitter notices (in-app + email on approved/sent-back only) [NOW].

*Admin:* C0 Control-center shell + nav [NOW] · C1 Board/Kanban (Intake+Spec live; later columns inert placeholders) [NOW] · C2 List view [NOW] · C3 Approval queue/Triage [NOW] · C4 Request/Work-item detail (pre-approval half NOW; build half LATER) · C5 Per-app Progress feed (writes `progress_event` from Stage 1, reads thin until builds run) [LATER-surfacing] · C6 Needs-me inbox (Approve-spec only now; more gates later) [NOW thin] · C7 App registry [NOW] · C8 Settings/notifications (3 coarse follow levels + digest now; GitHub linking, tiers later) [NOW minimal] · C9 Audit panel (on C4) [NOW].

*Shared:* Command palette (Cmd+K) [NOW] · Empty/loading/error/unauthorized states [NOW].

---

## 4. Linear/Slack pattern cheatsheet (named, reuse verbatim)

- **Inverted-L shell** — left rail + top header + dense center + in-place right side-panel.
- **Status-type glyph** — dotted/ring/check/strike; shape=type, color=status; all filters/views query the type, never the 7 column strings.
- **Attention badge** — accent-colored icon+label on a card/row (Approve spec / Sign ADRs / Approve merge / Approve deploy). The one loud thing on a calm row.
- **Needs-human overlay** — red border/flag on the card wherever it sits; never a column, never a type.
- **Command palette (Cmd+K)** — turns the product into one search bar over local state; jump + act.
- **G-nav + single-key actions + hover-reveal tooltips** — the keyboard discoverability loop.
- **Kanban column** — group-by-stage; one filterable collection regroupable by Subject/owner; list⇄board toggle; cards move themselves (Admins don't drag between stages); no WIP limits.
- **Triage queue** — list + preview pane, single-keystroke verbs with inline comment, items live outside the pipeline until accepted. Our Approval queue is a literal Triage clone (Approve/Send-back/Cancel).
- **Grounded preview** — Draft spec with inline `(from: Q2)`/`(ASSUMPTION)` tags + pinned Open-questions/Assumptions block beside the buttons.
- **Feed message card (Block Kit)** — gutter (actor avatar + stage/kind + relative timestamp) · header block (headline) · 2-column `fields` (Stage · Status · PR# · Tests · Files) · muted context line · single right-aligned GitHub link accessory · status-type-colored left edge. No reactions, no composer, no emoji.
- **Thread / channel mapping** — channel = app (Subject), thread = Work item/Request, message = milestone summary. Thread-footer metadata ("N milestones · last update Xh ago" + stage chip) = triage without opening. Two-pane split (feed left, timeline right).
- **Reply-broadcast** — `broadcast: true` only for gate-boundary + Needs-human (lifts to channel top + drives the rail badge). Quiet by default, loud when it matters.
- **Collapse repeated noise** — a Retry loop collapses into one expandable group ("Retried 3×"), never 3 broadcast cards.
- **Ambient unread dot** — per-app rail uses a binary dot, never a count to clear. The feed is never "done."
- **Clear-to-zero inbox** — Needs-me is the only badge-counted, mark-readable, snoozable surface; Tier-1 only; filter chips by gate type. Sharply distinct from the ambient feed (the one place to diverge from Slack).
- **Status header (the only edit-in-place surface)** — per-thread/Work-item header mutates with current stage/gate; every milestone beneath is immutable.
- **Optimistic gate action + diff-merge poll** — apply locally, render instantly, reconcile on next `?after=<cursor>` poll, roll back only on failure.
- **Three-state discipline** — skeleton (structure) / spinner (activity) / progress bar (measurable) / optimistic (remove the wait); teaching empty states ("No specs waiting on you — you're clear"); specific recoverable errors naming the failed Approve step.

---

## 5. Visual style statement (for image generation — shared look across all per-screen prompts)

> A calm, dense, engineering-grade internal tool in the **Linear lineage**. **Light mode is the default** for all screens (warm near-white `#FBFBFC` canvas, `#FFFFFF` cards); a dark mode is available as an opt-in. Neutral palette with a faint cool/Micron purple tint — never pure gray, never pure black or white; primary text is near-black `#16181D`, never pure black. A single restrained **Micron purple accent** (`#BD03F7`); the only other colors permitted are **amber** for a gate-waiting badge and **red** for Needs-human — used sparingly, one per screen at most, so they read as alarms. Typography is **Inter**, tight weights (400/500/600), with negative tracking on large headings; PR refs and code in **Cascadia Code** mono. **High information density** packed onto single scannable rows (app · type chip · status glyph · badge · owner) on an 8px rhythm. **Structure is felt, not seen:** hairline `#E8E9ED` borders, generous whitespace, soft 6–12px corner radii, depth from a 1px inset border plus a faint shadow rather than heavy drop-shadows. **Status-type glyphs** — dotted circle, partial progress ring, solid check, strike — appear on cards. Mood: **quiet, precise, fast, professional — mission-control restraint, not consumer flashiness.** No gradients, no glassmorphism, no decorative illustration, no marketing gloss. Sharp `:focus-visible` Micron purple focus ring visible on the active row. Slack-style feed cards have a colored left edge and a structured 2-column field grid. Overall: it should look like a tool a senior engineer would trust and operate all day by keyboard.

---

**Grounding files (absolute):** `CONTEXT.md` · `/docs/prd/stage-1-intake-and-spec-approval.md` · `/docs/design/control-center-linear-slack.md` · `/docs/adr/0004-progress-reporting-via-milestone-summaries.md` · `/docs/adr/0007-web-app-stack.md` · `/docs/adr/0008-two-axis-progress-event-log.md`


## Guardrails (must hold)

- ADR-0004 (milestone summaries, not streaming) is well-held on the Admin side: C4 Detail and C5 Feed both explicitly render milestone cards as immutable/historical, restrict edit-in-place to the status header only, and ban presence/typing/reactions/composer. Strong adherence — keep the explicit 'status header is the ONLY edit-in-place surface' callout in every timeline spec.
- The S2 streaming exception is correctly scoped and justified (Submitter-side, synchronous in-app LLM per PRD line 75) and is NOT smuggled into any Control-center surface. The only risk is documentation drift — see the inconsistency about centralizing the streaming boundary into one statement.
- Notification restraint (Linear over Slack volume) is well-respected: C6 Needs-me is the single clear-to-zero badge-counted surface (Tier-1 only); C5 feed uses a binary ambient unread dot, never a count; C8 caps settings to 3 coarse classes × 3 channels + per-app follow level, with Tier-1 in-app locked-on. This matches the brief's 'two surfaces, three coarse settings, zero push infra' exactly. Do not let any spec add per-event toggles or a second badge-counted feed.
- Polling-now (ADR-0007) is consistently honored: every Admin surface specifies the 3–5s diff-merge poll with 'never a whole-board/feed flash', optimistic-then-reconcile, and an 'Updated Ns ago' whisper; the Submitter side uses a gentler cadence. No spec assumes SSE/websockets. Keep the keyset '?after=<cursor>' framing so the SSE seam stays drop-in.
- 'Handful of admins — do not over-build' is respected: AND-only flat filters, 3–4 built-in saved views (no user-authored views), no WIP limits, no OR-filters, no multi-team, mobile explicitly de-prioritized for Admin surfaces. The control-center brief's 'Rejected by critic' (a separate cross-app Activity inbox) is correctly absent. Hold this line against any future request for custom views or a dense activity console.
- Color-as-signal discipline (amber=gate, red=Needs-human, one loud thing per surface) is stated in every spec and reinforced by status-by-SHAPE glyphs for color-blind legibility — strong and consistent. The one place to police: the diff view in C4 is the SANCTIONED exception where green/red mean add/remove (paired with +/- glyphs); ensure no other surface reuses green/red for add/remove semantics, and that S3's single green hero check is the only green in the Submitter app.
- Persist-first / resilience (PRD hardening #4, ADR-0006) is correctly surfaced as UX: S2/S3 state the Request is safe even mid-spec-generation, S3 documents the GitHub-Issue-pending step as INVISIBLE to the Submitter, and C3/C4 show the per-step Approve ledger (repo_ready → spec_pr_open → stage2_fired) with idempotent Retry-from-failed-step. This faithfully translates the resumability ADR into recovery UX — keep it.


## Consistency fixes to apply (from the critic)

- **Status-type spelling is split across the set. CONTEXT.md 'Status type' glossary and ADR-0008's enum both spell it 'Canceled' (one L); RequestLifecycle's state and the Submitter plain-stage vocabulary use 'Cancelled' (two L). Admin specs (C0, Board, List) label the strike glyph 'Canceled', while S4 My Requests uses 'Cancelled'. Same product, two spellings — a design-system smell.** → Pin the canonical pair: status_TYPE enum = 'Canceled' (Admin glyph/status, matches CONTEXT.md + ADR-0008); the Submitter plain-stage label and the RequestLifecycle state = 'Cancelled' (matches PRD). State this fork explicitly in the doc's vocabulary table so reviewers don't 'fix' one into the other.
- **Needs-human label drifts between audiences without being named as a deliberate fork. CONTEXT.md Admin overlay = 'Needs human'; US14 Submitter plain-stage = 'Needs a human'. S4/S5 (Submitter) correctly say 'Needs a human'; C0/Board/List/Approval/Detail/Feed/Inbox (Admin) say 'Needs human'. Correct per audience, but several specs reference both forms interchangeably in prose.** → Document the two labels as an intentional audience fork (Admin: 'Needs human' overlay; Submitter: 'Needs a human' plain-stage) in the shared vocabulary section, and audit each spec's copy to use only its audience's form.
- **S2 Intake interview's live token streaming risks reading as a contradiction of ADR-0004 unless the boundary is stated at the doc level, not just inside S2. S2 correctly notes streaming is legitimate here (PRD line 75, in-app LLM, user waiting) and ILLEGITIMATE on the Control-center feed — but C5 Progress feed, C4 Detail timeline, and C0 shell each separately re-assert 'no streaming'. The rule lives in 6 places with no single source.** → Add one 'Streaming boundary' guardrail statement to the document's shared-foundation section: the Intake interview (S2) is the ONLY streaming surface (Submitter-side, synchronous LLM); every Control-center progress surface is milestone summaries, edit-in-place on the status header only. Have each screen reference it rather than restating it.
- **'Subject' vs 'app' usage is inconsistent. CONTEXT.md reserves 'Subject' as the codebase the Factory operates on, and explicitly maps channel=app(Subject). Admin specs correctly use Subject (Board group-by, Feed channel=Subject, registry subject_id). But the Submitter specs must NEVER expose 'Subject' — most are clean, yet S1/S5 prose and keyComponents occasionally say 'Subject' where the Submitter sees only a friendly app name.** → Confirm 'Subject' is an Admin-only term in the vocabulary table; sweep Submitter specs (S1, S3, S4, S5) so neither labels nor helper copy nor visible chips use 'Subject' — only the friendly app name. Keep 'Subject' in Admin-facing keyComponents/data notes.
- **S5 (Request detail, Submitter) invents a friendly '#142' display id ('a display id, not the GitHub Issue number'). The PRD data model has no such field — Request carries the GitHub Issue ref and the Work-item ref, and S3 uses 'REQ-2041'. So the set now has THREE reference formats for one Request: 'REQ-2041' (S3), '#142' (S5), and the real Issue ref (Admin).** → Standardize one Submitter-facing reference token across S3/S4/S5 (recommend 'REQ-2041' style, clearly NOT the GitHub Issue number) and note in the doc that this is a display-only id with no backing data-model field yet, OR drop it from S5 and reuse S3's token. Flag to product that a stable human reference id is an implied new schema field.
- **Attention-badge naming is mostly consistent but C8 Settings introduces 'Gate events' as an umbrella class that bundles 'Approve spec · Sign ADRs · Approve merge · Approve deploy', while every other Admin screen treats those four as distinct named badges. A reviewer could read 'Gate events' as a fifth badge type.** → In C8, label the row 'Gate events' explicitly as a settings-only grouping of the four named gate badges (already done in the sub-caption) and add a one-line note in the vocabulary section that 'Gate events' is a notification-class umbrella, not a board badge, so it isn't mistaken for a new attention badge.
- **Send-back round terminology leaks toward the Submitter in one place. CONTEXT/PRD keep 'send-back' and 'round count' as Admin/internal; S5 correctly renames it 'Needs your input'/'Action needed' and hides the round count — but S5's imagePromptSeed and one state show a 'Round 2' chip in the SUBMITTER status header, and S5b prose says round count is 'kept calm' rather than hidden.** → Decide and state: the 'Round N' send-back chip is Admin-only (Approval queue / Detail). On the Submitter S5, remove the 'Round 2' chip from the header entirely (the spec already says 'send-back round count is NOT shown loudly' — make it 'not shown'). Keep round count exclusively on Admin surfaces.
- **Status-type glyph mapping for Intake/Triage is described two ways. Most specs map dotted-circle = Triage = Intake. But S4 (Submitter) maps 'dotted = Submitted/Spec drafted (Triage-ish)' AND the Board spec says Spec-column cards use the progress RING (Started), while Approval queue says every pending-spec card shows the dotted Triage circle. So a Spec-stage card is dotted in the Approval queue but a ring on the Board — same item, two glyphs.** → Reconcile the glyph rule precisely: status_TYPE drives the glyph (Intake=Triage=dotted; Spec→Deploy=Started=ring; Done=check; Cancel=strike). A spec waiting for approval is still stage=Spec, status_type=Started → it should be a RING everywhere, including the Approval queue. Fix the Approval-queue spec (and its imagePromptSeed) to use the Started ring, not a dotted Triage circle, OR explicitly define a Triage sub-state for pending-approval and apply it consistently on the Board too.


## Known gaps / open questions

- No Admin GitHub-identity-linking screen or state anywhere — correct for Stage 1 (PRD line 78 defers it; gates are in-app), but the doc should explicitly note 'no GitHub OAuth linking in Stage 1' so its absence reads as a deliberate scope boundary, not an oversight. C4/C0 mention 'act through linked GitHub identity' for LATER gates without flagging that linking itself is unbuilt.
- Cancel flow is underspecified for the Submitter. US38 lets an Admin cancel and 'notify the Submitter'; the Admin side has Cancel everywhere, but no spec defines what the Submitter sees when their Request is Cancelled beyond a strike pill in S4 and a 'received status' note in S5. There is no 'your request was cancelled (with admin reason?)' state/empty-flow for the Submitter, and no notification (S6) spec for the cancel notice.
- S6 (email / in-app notices) is referenced repeatedly as a deep-link source (S4 'toast/inline notice slot', S5 'email/in-app notice deep-link', confirmation 'we'll email you') but there is NO S6 screen spec in the set. The notification surface that several screens depend on is named but never specified — at minimum the in-app toast/notice component and the email template content (approved / sent-back, and per the gap above, cancelled) are missing.
- App registry has no 'edit blast radius / repo change' confirmation flow when an app is ALREADY linked to in-flight Work items beyond a read-only note. C7 mentions 'shows linked-Requests so admin understands blast radius' and blocks Remove when Requests are linked, but editing the repo mapping of an app with active builds (which would point the feed/Subject at a different repo mid-flight) has no guard state — a real data-integrity hazard.
- No spec for the Submitter 'session expired mid-interview' recovery in S2 beyond 'queued and retried' — but S1 and S5 both define an unauthorized/session-expired overlay. S2 (the one streaming surface, mid-LLM-call) should explicitly define what happens to an in-flight interview turn when the Entra session lapses, since persist-first only guarantees the Request, not the unsent answer.
- The Board, List, and Detail specs all reference Architecture→Done columns/stages as inert Stage-1 placeholders, but there is no defined behavior for a Request that an Admin Cancels while it is still pre-approval (Intake/Spec). Does a Cancelled-at-intake card show the strike glyph in the Intake column, move to a Done-ish state, or leave the board? CONTEXT says Cancel→Canceled status_type with no column — the visual placement of a pre-approval cancel is unspecified.
- No empty/zero state defined for the Approval queue's sibling relationship with the Needs-me inbox when an item is acted on in ONE surface while open in the OTHER. C3 (Approval queue) and C6 (Needs-me inbox) hold the same Approve-spec items; C3 defines a 'stale / poll-conflict' state for cross-admin actions but neither defines what happens to the OTHER surface (inbox badge, queue card) when YOU approve from one of them — the optimistic decrement must propagate across both views.
- Digest email content/format (C8 defines cadence Off/Hourly/Daily/Off-hours and a preview line) has no corresponding artifact spec — what the batched digest email actually looks like is undefined, and it ties to the missing S6 notification spec. For a handful of admins this is low-risk but the cadence control implies a deliverable that isn't specified.
