# 011 — Fade the plan panel's fact chips in instead of popping them

- **Status**: DONE (applied + live-verified 2026-07-21; not committed)
- **Commit**: `a963e53`
- **Severity**: LOW
- **Category**: Missed opportunities (preventing a jarring change)
- **Estimated scope**: 1 file, ~12 lines of CSS

## Problem

The live plan panel shows the settled basics as pill-shaped fact chips —
"Request: Build a new app", "Who will use it? My team", "Expected benefit: 400
hours saved/year". They are appended one at a time as the submitter answers the
basics wizard:

```html
<!-- apps/intake/src/app/submitter/plan-panel.ts:32-41 — current -->
@if (facts().length) {
  <div class="plan__facts">
    @for (f of facts(); track f[0]) {
      <span class="pfact"
        ><i>{{ f[0] }}</i
        >{{ f[1] }}</span
      >
    }
  </div>
}
```

`.pfact` carries no entrance of any kind:

```css
/* apps/intake/src/app/submitter/plan-panel.ts:145 — current */
.pfact {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg1);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 11px;
}
```

Each new chip therefore materialises at full opacity and, because
`.plan__facts` is a wrapping flex row (`plan-panel.ts:139-144`), shoves its
siblings sideways or onto a new line with no warning. It is a small jolt in a
panel whose whole job is to feel considered.

**This is the lowest-leverage of the three intake motion findings.** It is worth
doing only because it is nearly free and sits in the same file as plan 009. If
scope has to be cut, cut this one.

## Target

Give each chip a short fade-and-settle. Add to the existing `styles` block in
`plan-panel.ts`, immediately after the `.pfact i` rule (which ends at line 161):

```css
/* target — append after .pfact i, before .plan__ov */
@keyframes pfact-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
}
.pfact {
  animation: pfact-in var(--dur) var(--ease-out) both;
}
```

And extend the file's reduced-motion block:

```css
/* apps/intake/src/app/submitter/plan-panel.ts:239 — target */
@media (prefers-reduced-motion: reduce) {
  .plan__pulse,
  .plan__sh,
  .pfact {
    animation: none;
  }
}
```

Values and why they are these values:

- `var(--dur)` = `140ms` (declared `apps/intake/src/styles.css:112`), **not**
  `var(--dur-s)` (240ms). These are small chips in a short row; a long entrance
  on a three-item row reads as sluggish rather than considered.
- `scale(0.96)` sits in the 0.9–0.97 entrance band. A chip is a small solid
  object, so it scales; it does not rise like a paragraph.
- **No stagger.** There are only ever about three chips, and they arrive at
  human speed as the submitter answers — they are already naturally staggered by
  the user's own pace. Adding a CSS stagger on top would double-delay them.
- `var(--ease-out)` = `cubic-bezier(0.16, 1, 0.3, 1)`, declared at
  `apps/intake/src/styles.css:110`.

## Repo conventions to follow

- Motion tokens are global, declared in `apps/intake/src/styles.css:108-113`.
  Use `var(--dur)` and `var(--ease-out)` — never a raw ms value or a hand-typed
  cubic-bezier.
- Entrances in this codebase are keyframes with `both`, declared in the
  component's own `styles` block. **Exemplar to imitate**: `.cl > .iv {
  animation: iv-in 0.5s var(--ease-out) both; }` in
  `apps/intake/src/app/submitter/interview.ts`.
- `plan-panel.ts` already owns a `@media (prefers-reduced-motion: reduce)` block
  at line 239. Extend it rather than introducing a `no-preference` wrapper — that
  is the convention inside this file.

## Steps

1. Open `apps/intake/src/app/submitter/plan-panel.ts`. Find the `styles:` block.
2. Find the `.pfact i` rule (lines 157-161). Immediately after its closing brace
   and before `.plan__ov` (line 162), insert the `@keyframes pfact-in` block and
   the `.pfact { animation: … }` rule exactly as written in the Target section.
   Leave the existing `.pfact` rule at line 145 untouched — the new rule is a
   separate declaration that adds only the animation.
3. Find the reduced-motion block at line 239 and add `.pfact,` to its selector
   list.
4. Do not touch the template or any TypeScript.

## Boundaries

- Do NOT touch any file other than
  `apps/intake/src/app/submitter/plan-panel.ts`.
- Do NOT add an exit animation for chips. Facts are only ever appended or
  rewritten in place during intake; an exit path would be dead code.
- Do NOT add a stagger — see the Target rationale.
- Do NOT change the `@for (f of facts(); track f[0])` tracking expression.
- Do NOT change markup or structure. Motion properties only.
- Do NOT add dependencies.
- If this plan is executed alongside plan 009 (same file), apply both edits and
  make sure the final reduced-motion block lists all four selectors:
  `.plan__pulse, .plan__sh, .plan__ov, .psec, .pfact`.
- If the code at the cited lines does not match the excerpts above (drift since
  commit `a963e53`), STOP and report rather than improvising.

## Verification

- **Mechanical**:
  - `npx ng test intake` → expect `10 passed (10)` test files,
    `98 passed (98)` tests.
  - `npx ng build intake` → completes with no new errors.
  - `npx prettier --check apps/intake/src/app/submitter/plan-panel.ts` → passes.
    (If it fails, run `npx prettier --write` on that one file.)
- **Feel check**: start the API with the `api-brain` preview config (port 8000)
  and the `intake` config (port 4201). At `http://localhost:4201`, submit a
  description and answer the three basics one at a time, watching the right-hand
  panel. Confirm:
  - Each chip fades and settles into place rather than snapping in.
  - The motion is quick enough that it never delays reading the chip. If you
    notice it as an animation rather than as softness, `--dur` was replaced with
    something longer.
  - When a chip wraps to a second line and pushes its neighbours, the shove is
    softened rather than instant.
  - In DevTools → Animations, set playback to 10% and confirm each chip scales
    from 0.96 — not from zero, and with no vertical travel.
  - In DevTools → Rendering, enable `prefers-reduced-motion: reduce`, restart the
    flow, and confirm chips appear with no scaling.
- **Done when**: the fact row assembles softly as the basics are answered, and
  the three mechanical checks pass.
