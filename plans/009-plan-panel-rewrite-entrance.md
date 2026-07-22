# 009 — Bridge the live plan panel's rewrite with a staggered section entrance

- **Status**: DONE (applied + live-verified 2026-07-21; not committed)
- **Commit**: `a963e53`
- **Severity**: MEDIUM
- **Category**: Missed opportunities (preventing a jarring change)
- **Estimated scope**: 1 file, ~25 lines of CSS

## Problem

The intake interview's right-hand panel is the app's signature idea: it rewrites
the plan as the submitter answers. Its own footer promises this in
`apps/intake/src/app/submitter/plan-panel.ts:74` — "A structured summary, not a
transcript. It rewrites itself as you answer."

Today the rewrite has no bridge. While the brain is thinking, the whole panel
dims via a stale class; when the new plan lands, the content **snaps** in at full
opacity with no entrance of its own:

```css
/* apps/intake/src/app/submitter/plan-panel.ts:222 — current */
.plan__live {
  transition: opacity 0.3s var(--ease);
}
.plan__live--stale {
  opacity: 0.55;
}
```

The dim-out is the only motion. There is no dim-in counterpart, because the
sections inside are not the same DOM nodes — the template tracks by section
title:

```html
<!-- apps/intake/src/app/submitter/plan-panel.ts:49 — current -->
@for (sec of sections(); track sec.title) {
  <div class="psec">
    <div class="psec__t">{{ sec.title }}</div>
```

When the rewritten plan has different section titles (the normal case — the
whole point is that the plan changes), Angular destroys every `.psec` node and
creates new ones. New nodes render instantly at final opacity. The result is a
panel that **blinks** rather than one that looks like it is thinking.

`.plan__ov` (`plan-panel.ts:162`) and `.psec` (`plan-panel.ts:168`) currently
carry no animation at all.

## Target

Give the overview paragraph and each section its own entrance, staggered, so the
new plan assembles instead of appearing. Exact end state — add to the existing
`styles` block in `plan-panel.ts`, leaving the existing `.plan__ov` / `.psec`
rules unchanged and appending these after them:

```css
/* target — append after the .psec li rules, before .plan__sh */
@keyframes psec-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
.plan__ov,
.psec {
  animation: psec-in var(--dur-s) var(--ease-out) both;
}
/* .psec are the only <div> children of .plan__live, so nth-of-type counts
   sections correctly whether or not the overview <p> is present */
.psec:nth-of-type(1) {
  animation-delay: 40ms;
}
.psec:nth-of-type(2) {
  animation-delay: 80ms;
}
.psec:nth-of-type(3) {
  animation-delay: 120ms;
}
.psec:nth-of-type(4) {
  animation-delay: 160ms;
}
.psec:nth-of-type(n + 5) {
  animation-delay: 200ms;
}
```

And extend the file's existing reduced-motion block:

```css
/* apps/intake/src/app/submitter/plan-panel.ts:239 — target */
@media (prefers-reduced-motion: reduce) {
  .plan__pulse,
  .plan__sh,
  .plan__ov,
  .psec {
    animation: none;
  }
}
```

Values and why they are these values:

- `var(--dur-s)` = `240ms` (declared `apps/intake/src/styles.css:113`). Under the
  300ms ceiling for UI motion.
- `var(--ease-out)` = `cubic-bezier(0.16, 1, 0.3, 1)` (declared
  `apps/intake/src/styles.css:110`). Decelerating — correct for entrances.
- `translateY(6px)`, not a scale: the panel is a document, and documents settle
  downward. Never `scale(0)`.
- `40ms` stagger: inside the 30–80ms band. The stagger is decorative and must
  never gate interaction — these are read-only sections, so nothing is blocked.
- The cap at `nth-of-type(n + 5)` stops the last section of a long plan from
  arriving half a second late.
- **Keyframes are correct here, not transitions.** The usual rule is that
  rapidly-retriggered motion needs transitions so it retargets instead of
  restarting. It does not apply: these nodes are destroyed and recreated on every
  rewrite, so there is never a running animation to interrupt, and the rewrite
  cadence is seconds, not milliseconds.

## Repo conventions to follow

- Motion tokens are global, declared in `apps/intake/src/styles.css:108-113`:
  `--ease: cubic-bezier(0.2, 0.6, 0.2, 1)`, `--ease-out: cubic-bezier(0.16, 1,
  0.3, 1)`, `--dur-i: 80ms`, `--dur: 140ms`, `--dur-s: 240ms`. **Use the tokens;
  do not type a raw cubic-bezier or a raw ms value for these.**
- Entrances in this codebase are keyframes with `both`, defined in the component's
  own `styles` block. **Exemplar to imitate**:
  `apps/intake/src/app/submitter/interview.ts` — `.cl > .iv { animation: iv-in
  0.5s var(--ease-out) both; }` with the sibling panel delayed
  (`.cl > sf-plan-panel { animation: iv-in 0.5s var(--ease-out) 0.12s both; }`).
  That is exactly the shape this plan wants, one level finer.
- `plan-panel.ts` already owns a `@media (prefers-reduced-motion: reduce)` block
  at line 239 listing the animations it kills. Extend that block — do not add a
  new `no-preference` wrapper, which would not match this file.

## Steps

1. Open `apps/intake/src/app/submitter/plan-panel.ts`. Find the `styles:` block.
2. Locate the `.psec li` rules (around line 188). After the last `.psec`-related
   rule and **before** `.plan__sh` (around line 205), insert the
   `@keyframes psec-in` block and the `.plan__ov, .psec` + `nth-of-type` rules
   exactly as written in the Target section above.
3. Find the existing reduced-motion block at line 239. Add `.plan__ov,` and
   `.psec,` to its selector list so it reads exactly as the Target section shows.
4. Do not touch the template, the `.plan__live` / `.plan__live--stale` rules, or
   any TypeScript.

## Boundaries

- Do NOT touch any file other than
  `apps/intake/src/app/submitter/plan-panel.ts`.
- Do NOT change the `@for (sec of sections(); track sec.title)` tracking
  expression. Switching to `track $index` would make sections morph instead of
  re-enter — that is a different design decision and is out of scope.
- Do NOT change markup or structure. Motion properties only.
- Do NOT remove or weaken the existing `.plan__live--stale` dim; it is the
  outgoing half of this transition and must stay.
- Do NOT add dependencies.
- If the code at the cited lines does not match the excerpts above (drift since
  commit `a963e53`), STOP and report rather than improvising.

## Verification

- **Mechanical**:
  - `npx ng test intake` → expect `10 passed (10)` test files,
    `98 passed (98)` tests. No test asserts on these styles, so the count must
    not change.
  - `npx ng build intake` → completes with no new errors.
  - `npx prettier --check apps/intake/src/app/submitter/plan-panel.ts` → passes.
    (If it fails, run `npx prettier --write` on that one file.)
- **Feel check**: the API must run in api-brain mode for the plan to actually
  rewrite. Start it with `preview_start` config `api-brain` (port 8000) and the
  `intake` config (port 4201), then at `http://localhost:4201` submit a
  description, answer the three basics, and answer two interview questions while
  watching the right-hand panel. Confirm:
  - Each new plan **assembles top-down** — overview first, then sections — rather
    than the whole block appearing at once.
  - The old plan dims *before* the new one arrives; the two do not visibly
    double-expose.
  - The stagger is felt but not counted. If you can count the sections arriving,
    the delay is too long.
  - In DevTools → Animations, set playback speed to 10% and confirm each `.psec`
    rises 6px and fades, with no horizontal movement and no scale.
  - In DevTools → Rendering, enable `prefers-reduced-motion: reduce`, answer
    another question, and confirm the new plan appears with **no** movement while
    the stale dim still works.
- **Done when**: the plan rewrite reads as the panel thinking and re-forming, the
  three mechanical checks pass, and reduced-motion drops the movement.
