# Left-Rail Title Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five URL-switchable left-rail `Describe` title treatments to the existing Intake route and remove the tracing beam from every treatment.

**Architecture:** Keep the throwaway prototype inside the existing `SubShell`, because that component owns the rail on every Intake step. Derive a validated A-E variant from the route query parameter, render one of five isolated title fragments, and expose a development-only fixed switcher that updates the URL while preserving the current route. Retain Lenis scrolling and journey dots, but delete all beam DOM, styles, refs, listeners, and calculations.

**Tech Stack:** Angular 22 standalone components, signals, Angular Router, Vitest, inline templates and styles.

---

## File Map

- Modify `apps/intake/src/app/submitter/sub-shell.ts`: variant selection, five title treatments, development-only switcher, keyboard navigation, and tracing-beam removal.
- Create `apps/intake/src/app/submitter/sub-shell.prototype.spec.ts`: focused prototype behavior tests without changing unrelated shell coverage.

### Task 1: Lock the variant behavior with tests

**Files:**
- Create: `apps/intake/src/app/submitter/sub-shell.prototype.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create a focused TestBed suite that provides router routes for a host component containing `<sub-shell [step]="0" [proto]="true">content</sub-shell>`. Assert:

```ts
expect(fixture.nativeElement.querySelector('[data-rail-variant="A"]')).toBeTruthy();
expect(fixture.nativeElement.querySelector('.rail__track')).toBeNull();
expect(fixture.nativeElement.querySelectorAll('.mini')).toHaveLength(4);
```

Navigate to `/?variant=C`, run change detection, and assert:

```ts
expect(fixture.nativeElement.querySelector('[data-rail-variant="C"]')).toBeTruthy();
expect(fixture.nativeElement.querySelector('.proto-switcher__label').textContent).toContain(
  'C — Compact pill',
);
```

Dispatch `ArrowRight` on `document` and verify the router URL becomes `/?variant=D`. Focus a textarea, dispatch `ArrowRight` again, and verify the URL stays unchanged.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx ng test intake --watch=false --include='**/sub-shell.prototype.spec.ts'
```

Expected: FAIL because the `data-rail-variant` nodes and prototype switcher do not exist, while the existing `.rail__track` is still rendered.

- [ ] **Step 3: Commit the failing test**

```bash
git add apps/intake/src/app/submitter/sub-shell.prototype.spec.ts
git commit -m "test(intake): specify rail title prototype"
```

### Task 2: Remove tracing-beam behavior without disturbing scrolling

**Files:**
- Modify: `apps/intake/src/app/submitter/sub-shell.ts`

- [ ] **Step 1: Remove beam-only template and CSS**

Delete:

```html
<div class="rail__track">
  <div class="rail__fill" #beamFill><i class="rail__head"></i></div>
</div>
```

Delete the `.rail__track`, `.rail__fill`, and `.rail__head` rules. Keep `.rail__minis`, `.mini`, the responsive `.railchip`, and the existing rail positioning.

- [ ] **Step 2: Remove beam-only TypeScript**

Delete `beamFill`, `onHostScroll`, `updateBeam()`, and the native scroll listener registration/removal. Keep `scrollHost`, Lenis creation, `scrollToEl()`, and Lenis destruction. Update the class comment and `initScroll()` comment so neither claims a tracing beam exists.

- [ ] **Step 3: Run the focused test and confirm the beam assertion passes**

Run:

```bash
npx ng test intake --watch=false --include='**/sub-shell.prototype.spec.ts'
```

Expected: tests still fail on missing variants, but `expect(...querySelector('.rail__track')).toBeNull()` passes.

- [ ] **Step 4: Commit the beam removal**

```bash
git add apps/intake/src/app/submitter/sub-shell.ts
git commit -m "refactor(intake): remove tracing beam"
```

### Task 3: Implement five title treatments and switcher

**Files:**
- Modify: `apps/intake/src/app/submitter/sub-shell.ts`

- [ ] **Step 1: Add variant state and names**

Inject `ActivatedRoute`, import `isDevMode`, `computed`, and `signal`, then define:

```ts
readonly prototypeVariants = [
  ['A', 'Chapter label'],
  ['B', 'Vertical index'],
  ['C', 'Compact pill'],
  ['D', 'Bracket marker'],
  ['E', 'Margin caption'],
] as const;
readonly showPrototypeSwitcher = isDevMode();
private readonly queryVariant = signal('A');
readonly railVariant = computed(() =>
  this.prototypeVariants.some(([key]) => key === this.queryVariant())
    ? this.queryVariant()
    : 'A',
);
```

Subscribe to `route.queryParamMap` with `takeUntilDestroyed()` and update `queryVariant` from `params.get('variant') ?? 'A'`.

- [ ] **Step 2: Render five structurally distinct title fragments**

Replace the single `.rail__cur` fragment with an `@switch (railVariant())` block. Give each root `data-rail-variant="A"` through `E` and use the current step number and label:

```html
@case ('A') { <div class="rail-title rail-title--chapter" data-rail-variant="A">…</div> }
@case ('B') { <div class="rail-title rail-title--vertical" data-rail-variant="B">…</div> }
@case ('C') { <div class="rail-title rail-title--pill" data-rail-variant="C">…</div> }
@case ('D') { <div class="rail-title rail-title--bracket" data-rail-variant="D">…</div> }
@default { <div class="rail-title rail-title--caption" data-rail-variant="E">…</div> }
```

Use existing design tokens only. A is an inline editorial `01 / DESCRIBE`; B emphasizes a large number with stacked label; C is a bordered rounded pill; D uses CSS pseudo-elements for two bracket corners; E stacks a muted `Current section` eyebrow above the label.

- [ ] **Step 3: Add shareable switcher behavior**

Add `cycleVariant(direction: -1 | 1)` to wrap across A-E and call:

```ts
this.router.navigate([], {
  relativeTo: this.route,
  queryParams: { variant: nextKey },
  queryParamsHandling: 'merge',
  replaceUrl: true,
});
```

Add a document keydown handler that returns early when the target is an `input`, `textarea`, `select`, or `[contenteditable]`, then cycles on `ArrowLeft` and `ArrowRight`.

- [ ] **Step 4: Render and style the development-only switcher**

Under the shell content, render the fixed bottom-center bar only when `showPrototypeSwitcher` and `step() === 0`. Include previous/next buttons and a `.proto-switcher__label` with the current key and name. Give buttons explicit `aria-label`s and style the bar as a high-contrast pill using existing tokens and `var(--shadow-pop)`.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
npx ng test intake --watch=false --include='**/sub-shell.prototype.spec.ts'
```

Expected: PASS.

- [ ] **Step 6: Commit the five-option prototype**

```bash
git add apps/intake/src/app/submitter/sub-shell.ts apps/intake/src/app/submitter/sub-shell.prototype.spec.ts
git commit -m "feat(intake): prototype rail title variants"
```

### Task 4: Verify the prototype in context

**Files:**
- Modify: none

- [ ] **Step 1: Run Intake tests**

```bash
npx ng test intake --watch=false
```

Expected: all Intake unit tests pass.

- [ ] **Step 2: Run the Intake production build**

```bash
npx ng build intake
```

Expected: build succeeds; because it is a production build, the prototype switcher is omitted.

- [ ] **Step 3: Review all five URLs**

Open `/submit/new?variant=A` through `/submit/new?variant=E` at desktop width. Confirm each treatment is distinct, the tracing beam is absent, the journey dots remain, and both light and dark themes stay legible. Confirm Left/Right Arrow changes variants while the description textarea does not have focus and does nothing while it does.

- [ ] **Step 4: Record the selection before cleanup**

After user review, add the winning key and reason to `docs/superpowers/specs/2026-07-11-left-rail-title-prototype-design.md`, delete the losing variants and switcher, and retain only the selected production treatment.
