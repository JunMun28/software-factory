# 010 — Spend the delight budget on the submission-confirmation check

- **Status**: DONE (applied + live-verified 2026-07-21; not committed)
- **Commit**: `a963e53`
- **Severity**: LOW
- **Category**: Missed opportunities (delight, rare-tier)
- **Estimated scope**: 2 files, ~20 lines of CSS + 1 class name

## Problem

`apps/intake/src/app/submitter/confirm.ts` is the end of the intake journey: the
submitter has described their idea, answered the basics, and worked through an
agent interview. This screen is the payoff, and it is seen **once per request** —
the rarest, highest-emotion moment in the app, and the only place the delight
budget is allowed to be spent.

Right now the green check circle fades in as part of one undifferentiated column
animation. Nothing marks the moment:

```html
<!-- apps/intake/src/app/submitter/confirm.ts:16-24 — current -->
<div
  class="sub-col narrow fade-in"
  style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:18px;padding-top:40px"
>
  <span
    style="width:60px;height:60px;border-radius:50%;background:var(--green-bg);display:flex;align-items:center;justify-content:center"
  >
    <sf-glyph type="check" [size]="34" color="var(--green)" />
  </span>
```

The `.fade-in` class on the wrapper (`apps/intake/src/styles.css:3003`) moves the
entire column up 5px over 240ms. The check gets no treatment of its own — it is
just one more thing in the fade.

Note: `confirm.ts` has **no `styles:` block**. It styles itself with inline
`style` attributes and global classes only. The component ends at line 83 with
`})`.

## Target

Add a reusable `.pop-check` entrance class to the global stylesheet, next to the
existing `.fade-in` / `.pop-in` entrance classes, and apply it to the check
circle. The circle scales up with a slight overshoot and lands *after* the column
has settled.

Add to `apps/intake/src/styles.css`, immediately after the `@keyframes popInFade`
block (which ends at line 3077) and before `@keyframes spin` (line 3079):

```css
/* target — apps/intake/src/styles.css, after @keyframes popInFade */

/* Success beat — for the once-per-journey confirmation mark only. Lands after
   the surrounding .fade-in column has settled, so the eye arrives to a still
   page and then the mark pops. Do not reuse on recurring UI. */
.pop-check {
  opacity: 1;
}
@media (prefers-reduced-motion: no-preference) {
  .pop-check {
    animation: popCheck 420ms var(--ease-out) 120ms both;
  }
}
@keyframes popCheck {
  from {
    opacity: 0;
    transform: scale(0.8);
  }
  60% {
    transform: scale(1.04);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
```

And in `apps/intake/src/app/submitter/confirm.ts`, add the class to the circle
`span` — this is the only change to that file:

```html
<!-- target — confirm.ts:20-24 -->
<span
  class="pop-check"
  style="width:60px;height:60px;border-radius:50%;background:var(--green-bg);display:flex;align-items:center;justify-content:center"
>
  <sf-glyph type="check" [size]="34" color="var(--green)" />
</span>
```

Values and why they are these values:

- `scale(0.8)` → `1`, never `scale(0)`. Nothing in the real world appears from
  nothing. 0.8 is below the usual 0.9–0.97 entrance band on purpose: this is the
  one rare-tier moment where a larger, more visible move is earned.
- The `60% { transform: scale(1.04) }` overshoot is the delight. Keep it at
  1.04 — a bigger overshoot reads as a cartoon, not a receipt.
- `420ms` exceeds the 300ms UI ceiling deliberately. That ceiling governs
  recurring UI; a once-per-journey celebration is the documented exception.
- `120ms` delay: the wrapper's `.fade-in` runs `var(--dur-s)` = 240ms. Starting
  the check at 120ms means it lands while the column is finishing, so the two
  read as one gesture rather than a queue.
- `var(--ease-out)` = `cubic-bezier(0.16, 1, 0.3, 1)`, declared at
  `apps/intake/src/styles.css:110`.

## Repo conventions to follow

- Shared entrance classes are global, in `apps/intake/src/styles.css`, grouped
  near the end of the file: `.fade-in` (line 3003), `.pop-in` (line 3021),
  `.spin` (line 3084). `.pop-check` belongs in that same group.
- **Exemplar to imitate**: `.pop-in` at `apps/intake/src/styles.css:3021-3062`.
  Note its exact shape — a base rule setting the settled state (`opacity: 1`), a
  `@media (prefers-reduced-motion: no-preference)` wrapper holding the
  `animation` declaration, and the `@keyframes` outside the media query. Copy
  that three-part structure exactly.
- The reduced-motion convention in this file is the `no-preference` wrapper, so
  the animation simply never runs when motion is reduced. The blanket
  `prefers-reduced-motion: reduce` rule at line 3087 is a backstop, not the
  mechanism — do not rely on it alone.
- Motion tokens: `--ease-out` and `--dur-s` are declared at
  `apps/intake/src/styles.css:108-113`. Use the token for the curve. The `420ms`
  and `120ms` here are intentionally off-scale (see above) and are written as
  literals.

## Steps

1. Open `apps/intake/src/styles.css`. Find `@keyframes popInFade` (line 3071) and
   its closing brace (line 3077).
2. Immediately after it, and before `@keyframes spin` (line 3079), insert the
   `.pop-check` rule, the `no-preference` wrapper, and `@keyframes popCheck`
   exactly as written in the Target section, comment included.
3. Open `apps/intake/src/app/submitter/confirm.ts`. On the `<span>` at line 20,
   add `class="pop-check"` as the first attribute, before the existing `style`
   attribute. Change nothing else in this file.
4. Do not add a `styles:` block to `confirm.ts` — this component deliberately has
   none.

## Boundaries

- Do NOT touch any file other than `apps/intake/src/styles.css` and
  `apps/intake/src/app/submitter/confirm.ts`.
- Do NOT animate the heading, the receipt card, or the stage tracker on this
  page. The restraint is the point: one thing moves, everything else is calm.
- Do NOT apply `.pop-check` anywhere else in the codebase. It is scoped to the
  rare tier by intent, and the comment in the CSS says so.
- Do NOT convert `confirm.ts`'s inline styles to classes. Out of scope.
- Do NOT change the existing `.fade-in` on the wrapper — the check's timing is
  calculated against it.
- Do NOT add dependencies.
- If the code at the cited lines does not match the excerpts above (drift since
  commit `a963e53`), STOP and report rather than improvising.

## Verification

- **Mechanical**:
  - `npx ng test intake` → expect `10 passed (10)` test files,
    `98 passed (98)` tests.
  - `npx ng build intake` → completes with no new errors.
  - `npx prettier --check apps/intake/src/styles.css apps/intake/src/app/submitter/confirm.ts`
    → passes. (If it fails, run `npx prettier --write` on those two files.)
- **Feel check**: reaching this page for real requires completing an interview.
  The faster route is to navigate directly to a confirmed request's URL —
  `confirm.ts` reads the request from the route, so any submitted request id
  works. Confirm:
  - The column fades up first; the check lands **just after**, not with it. If
    they start together, the 120ms delay was dropped.
  - The overshoot is felt as a soft settle, not a bounce. If it reads as springy
    or cartoonish, the 1.04 keyframe was overshot.
  - The check scales from its own centre, not from a corner. (No
    `transform-origin` is set, so the default `50% 50%` is correct — verify it
    was not overridden.)
  - In DevTools → Animations, set playback to 10% and confirm the mark grows from
    0.8, overshoots slightly past 1, and settles — and that it never starts from
    invisible-zero size.
  - In DevTools → Rendering, enable `prefers-reduced-motion: reduce`, reload, and
    confirm the check is simply **present** at full size with no scaling, while
    the page still fades in.
- **Done when**: the confirmation reads as a small moment of arrival rather than
  a page load, and the three mechanical checks pass.
