# Plan 004: Consolidate five duplicated dropdown menus into one kit pop-menu component

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 76bb314..HEAD -- web/src/app/kit/kit.ts web/src/app/admin/board.ts web/src/app/admin/settings.ts web/src/app/admin/feed.ts web/src/app/submitter/sub-shell.ts web/src/app/submitter/new-request.ts web/src/styles.css`
> Compare "Current state" excerpts against live code before proceeding; on a
> mismatch treat it as a STOP condition.
> Note: planned against `76bb314` **plus uncommitted working-tree changes** —
> `new-request.ts` gained `.dd`/`.dd-wrap` dropdown classes and
> document-level click/Esc handlers in that uncommitted work. The excerpts
> below reflect the working tree.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (touches 5 visible surfaces; mitigated by per-site visual checks)
- **Depends on**: plans/003-lint-format-gate.md (land lint first so this diff is born clean) — soft dependency, can proceed without it
- **Category**: tech-debt
- **Planned at**: commit `76bb314`, 2026-06-11

## Why this matters

The same "trigger button + floating options panel" UI is hand-rolled in five
places with five slightly different implementations: different widths,
border-radius 8 vs 9, two different dismissal mechanisms (an invisible
fixed-inset scrim in the four older sites; document-click + Esc handlers in
the newest), and — the concrete bug — two sites (`settings.ts`, `feed.ts`)
have a live styling defect where `[style.background]` bound to `''` removes
the static `background:none`, so unselected options render with the
browser's default grey button chrome. That exact bug was just fixed in
`new-request.ts`; the fix never reached the copies. One `sf-pop-menu` kit
component makes the next dropdown free and this class of bug impossible to
re-introduce.

## Current state

The five sites (all confirmed in the working tree):

1. `web/src/app/admin/board.ts:246-268` — "Group by" menu. Scrim dismissal.
   Panel: `position:absolute;top:calc(100% + 5px);left:0;z-index:20;width:184px;…border-radius:9px;box-shadow:var(--shadow-pop);…padding:5px`.
   Options carry icons + check glyph; selected state uses explicit
   `'transparent'` fallback (no grey bug here).
2. `web/src/app/admin/settings.ts:38-52` — "Daily digest at" time picker.
   Scrim dismissal. Panel width 140px, right-aligned. **Has the grey-button
   bug**: static `background:none` + `[style.background]="digest === t ? 'var(--a50)' : ''"`.
3. `web/src/app/admin/feed.ts:50-62` — "Following:" level menu. Scrim
   dismissal. Width 200px, right-aligned. **Has the grey-button bug** (same
   pattern as settings).
4. `web/src/app/submitter/sub-shell.ts:20-33` — account/role switcher.
   Scrim dismissal (z-index 29/30). Width 230px, right-aligned.
5. `web/src/app/submitter/new-request.ts` — app picker + "How often?"
   picker. NEWEST pattern: `.dd-wrap`/`.dd`/`.dd__opt` component-scoped
   classes, full-trigger-width panel (`left:0;right:0`), dismissal via
   `@HostListener('document:click')` + `document:keydown.escape` +
   mutual-exclusion in `toggleApps()`/`toggleFreq()`.

The scrim pattern used by sites 1–4 (excerpt from settings.ts):

```html
@if (digestOpen) {
  <span style="position:fixed;inset:0;z-index:19" (click)="digestOpen = false"></span>
  <span style="position:absolute;top:calc(100% + 5px);right:0;z-index:20;display:block;width:140px;background:var(--surface);border:1px solid var(--border);border-radius:9px;box-shadow:var(--shadow-pop);padding:5px">
    @for (t of digestTimes; track t) {
      <button style="…;background:none;…" [style.background]="digest === t ? 'var(--a50)' : ''" (click)="digest = t; digestOpen = false">{{ t }}</button>
    }
  </span>
}
```

- Kit conventions: shared UI atoms live in `web/src/app/kit/kit.ts` as
  multiple small standalone components in ONE file (`sf-icon`, `sf-avatar`,
  `sf-type-chip`, …). Match that: add `sf-pop-menu` to `kit.ts`, don't
  create a new file unless kit.ts would exceed ~300 lines.
- Global utility classes live in `web/src/styles.css` (`.btn`, `.seg`,
  `.kpill`…). Projected content can't be styled by a component's scoped
  styles, so the option classes go in `styles.css`.
- Design tokens: `--surface --border --shadow-pop --a50 --a700 --a600 --a400
  --fg1 --fg2 --muted --faint --surface-2 --surface-3 --dur --ease --body`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Build | `cd web && npx ng build` | exit 0 |
| Tests | `cd web && npx ng test` | all pass |
| Lint (if plan 003 landed) | `cd web && npx ng lint` | exit 0 |
| Dev servers | `make dev WEB_PORT=4300` | web on :4300 |

## Scope

**In scope**:
- `web/src/app/kit/kit.ts` (add `sf-pop-menu`)
- `web/src/styles.css` (add `.pop__opt` family of classes)
- The five site files listed above (migrate to `sf-pop-menu`)

**Out of scope**:
- `web/src/app/admin/admin-shell.ts` — its command palette and cheat-sheet
  use a CENTERED modal scrim (`palette-scrim`), a different pattern; leave it.
- Dropdown *state logic* (which signal opens which menu, mutual exclusion in
  new-request) — keep the existing signals/fields; only the template
  scaffolding moves into the component.
- The interview option-card UI in `submitter/interview.ts` — option cards,
  not a dropdown.

## Git workflow

- Branch: `advisor/004-pop-menu`
- Commits: (1) component + classes, (2..6) one commit per migrated site —
  keeps each site reviewable and revertable.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `sf-pop-menu` to kit.ts and option classes to styles.css

Component contract (signals-based, matching repo style):

```ts
@Component({
  selector: 'sf-pop-menu',
  template: `
    @if (open()) {
      <span class="pop__scrim" (click)="closed.emit()"></span>
      <span class="pop"
        [style.width]="width() === 'fill' ? null : width() + 'px'"
        [class.pop--fill]="width() === 'fill'"
        [style.left]="align() === 'left' || width() === 'fill' ? '0' : null"
        [style.right]="align() === 'right' || width() === 'fill' ? '0' : null">
        <ng-content />
      </span>
    }
  `,
  host: { '(document:keydown.escape)': 'open() && closed.emit()' },
})
export class PopMenu {
  open = input.required<boolean>();
  width = input<number | 'fill'>(200);
  align = input<'left' | 'right'>('right');
  closed = output<void>();
}
```

styles.css additions (place near the existing `.kpill`/`.chip` block):

```css
/* sf-pop-menu — the one floating options panel (plan 004) */
.pop__scrim { position:fixed; inset:0; z-index:19; }
.pop { position:absolute; top:calc(100% + 5px); z-index:20; display:block;
  background:var(--surface); border:1px solid var(--border); border-radius:9px;
  box-shadow:var(--shadow-pop); padding:5px; }
.pop__opt { display:flex; align-items:center; gap:8px; width:100%; text-align:left;
  padding:7px 10px; border:none; border-radius:6px; background:none; cursor:pointer;
  font-family:var(--body); font-size:13.5px; color:var(--fg2);
  transition:background var(--dur) var(--ease); }
@media (hover:hover) { .pop__opt:hover { background:var(--surface-2); } }
.pop__opt:active { background:var(--surface-3); }
.pop__opt.on { background:var(--a50); color:var(--a700); font-weight:600; }
.pop__group { font-size:10px; font-weight:600; letter-spacing:.1em;
  text-transform:uppercase; color:var(--faint); padding:5px 9px 4px; }
```

The HOST SITE must wrap trigger + `<sf-pop-menu>` in a
`position:relative` container (all five already have one).

**Verify**: `cd web && npx ng build` → exit 0 (component compiles, unused so far).

### Step 2: Migrate settings.ts (smallest site, has the grey bug)

Replace the scrim+panel spans with:

```html
<sf-pop-menu [open]="digestOpen" [width]="140" (closed)="digestOpen = false">
  @for (t of digestTimes; track t) {
    <button class="pop__opt" [class.on]="digest === t" (click)="digest = t; digestOpen = false">{{ t }}</button>
  }
</sf-pop-menu>
```

Add `PopMenu` to the component's `imports` array. Remove the now-dead inline
styles. NOTE: `[class.on]` replaces the buggy `[style.background]` binding —
this is the bug fix.

**Verify**: build passes; in the dev server (reviewer role →
`/admin/settings`) the digest dropdown opens, options have a white
background with hover, selected shows the purple tint, clicking outside and
Esc both close it.

### Step 3: Migrate feed.ts ("Following:" menu)

Same transformation, `[width]="200"`. Keep the check glyph inside the
button: `@if (follow() === lvl) { <sf-icon name="check" [size]="14" color="var(--a600)" /> }`.

**Verify**: build; visual check on `/admin/apps/northwind` (open the
Following menu — white options, outside-click + Esc close).

### Step 4: Migrate sub-shell.ts (role switcher)

`[width]="230"`. The single option keeps its avatar content; give it
`class="pop__opt"` and drop the duplicated inline styles. Watch the z-index:
sub-shell used 29/30 — if anything overlaps the new 19/20, bump only via a
style override on the host (`<sf-pop-menu style="z-index:30">` is NOT enough
since the classes carry z-index; if an overlap shows up, treat as a STOP).

**Verify**: build; visual check on any submitter page — avatar menu opens,
"Switch to Kim P." works, outside-click closes.

### Step 5: Migrate board.ts (Group-by menu)

`[width]="184"` `[align]="'left'"`. Its header line becomes
`<div class="pop__group">Swimlanes by</div>`. Options keep their icons and
check; selected state via `[class.on]`. The font-size difference (13.5 vs
13) is intentional consolidation — accept the shared 13.5px.

**Verify**: build; visual check on `/admin/board` — group-by switches
swimlanes, menu closes on selection/outside/Esc.

### Step 6: Migrate new-request.ts (app + frequency pickers)

Replace `.dd`-class panels with `<sf-pop-menu [open]="appsOpen()" width="fill" (closed)="appsOpen.set(false)">`
(and the freq equivalent). Options become `class="pop__opt"`
(`[class.on]` for the selected app/freq); keep the `#` hash span and the
empty-state div (give it the old `.dd__empty` styling inline or a
`.pop__empty` class). Then REMOVE from this component: the
`@HostListener('document:click')`/`onDocClick`, the `document:keydown.escape`
host listener, and the now-unused `.dd*` styles — the component's scrim+Esc
replace them. KEEP `toggleApps`/`toggleFreq` mutual exclusion and the seg
wrap styles (`.seg { flex-wrap:wrap }`) — those are unrelated.

**Verify**: build + `npx ng test`; visual check on `/submit/new`: bug-fix
type → app picker opens/white options/selected tint/outside-click + Esc
close; "How often?" same; enhancement type → reach/impact segs unaffected.

### Step 7: Sweep for leftovers

`grep -n "shadow-pop" web/src/app --include="*.ts" -r` — remaining hits must
be only: `pipeline.ts:94` (a hover shadow, not a dropdown), `feed.ts:127`
(a floating "jump to latest" button, not a dropdown), and admin-shell's
palette (out of scope). No `position:fixed;inset:0` scrims should remain in
the five migrated sites: `grep -n "position:fixed;inset:0" web/src/app/admin/board.ts web/src/app/admin/settings.ts web/src/app/admin/feed.ts web/src/app/submitter/sub-shell.ts` → no matches.

**Verify**: both greps as stated; `cd web && npx ng build && npx ng test` → green.

## Test plan

No new unit tests (component is template scaffolding; the repo has no
component-test harness). The regression net is: plan 002's service specs
(unaffected), the build, and the per-site visual checks in steps 2–6. In
your final report list each site with a one-line confirmation of the visual
check.

## Done criteria

- [ ] `sf-pop-menu` exists in `web/src/app/kit/kit.ts`; `.pop__*` classes in `web/src/styles.css`
- [ ] All five sites use it; the two greps in Step 7 return exactly the stated results
- [ ] `cd web && npx ng build && npx ng test` exit 0 (and `npx ng lint` if plan 003 landed)
- [ ] The settings + feed grey-button defect is gone (visual check noted in report)
- [ ] `git status` shows only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Any site's open-state logic turns out to live partly in a parent component
  (state you'd have to lift) — the migration should be template-local.
- A z-index conflict appears that the fixed 19/20 scale can't solve at a
  site (notably sub-shell at 29/30) — report rather than inventing per-site
  z-index overrides.
- `input.required<boolean>()` / `output()` APIs are unavailable in this
  Angular version (they are expected in v22 — if the build disagrees, stop).
- The visual check at any site shows layout regressions you can't attribute
  to a one-line fix.

## Maintenance notes

- Every future dropdown should use `sf-pop-menu`; if a new variant is needed
  (e.g. a fixed-position flavor for table rows), extend the component, don't
  fork the template.
- Reviewer should scrutinize step 6 most: it deletes the document-level
  listeners added very recently — confirm outside-click and Esc still work
  on /submit/new through the component's scrim instead.
- Deferred deliberately: admin-shell's palette modal (different pattern),
  and converting the interview option cards (not a dropdown).
