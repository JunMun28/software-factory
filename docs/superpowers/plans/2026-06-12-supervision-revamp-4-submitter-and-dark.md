# Supervision Revamp — Plan 4: Submitter Activity Line + Dark Mode

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the submitter a calm, plain-language "what's happening now" line driven by the live trace, and add a full dark theme to both faces — default-from-system, Settings-toggleable, no flash, AA-legible — with `make verify` green and light + dark visual proof.

**Architecture:** The submitter line reuses the Plan 1 `run` block already on `RequestDetail`, translated through a pure, vitest-covered `plainActivity()` dictionary that CANNOT leak admin/GitHub vocabulary (unknown labels fall back to a safe phrase). Dark mode is a pure token swap: a `[data-theme="dark"]` block overrides the color tokens in `styles.css`; an inline pre-paint script in `index.html` sets the attribute before first paint; a tiny `Theme` service + a Settings "Appearance" control persist the choice to `localStorage`. No component markup changes for theming except tokenizing a few hardcoded hexes that would otherwise ignore the swap.

**Tech Stack:** Angular 22 + signals; pure CSS custom properties (no CSS framework). Web commands from `web/`; full gate `make verify` from repo root.

**Spec:** `docs/superpowers/specs/2026-06-12-ui-supervision-revamp-design.md` §6 (submitter transparency) + §7 (dark mode). Phase 4 of 5. Cutover (route flip, old-page deletion, vocab purge) stays in Plan 5.

**Backend contract (live):** `GET /api/requests/{id}` → `RequestDetail` carries `run: {step, of, label, health} | null` while a build is in flight. The submitter already polls this endpoint. The admin step labels that can appear (from `STEP_PLANS` in `api/app/models.py`): architecture — "reading SPEC.md", "drafting PLAN.md", "writing ADRs", "validating plan against SPEC.md"; build — "authoring failing tests", "running the RED gate", "implementing the change", "running the test suite", "refactoring", "running the test-isolation gate"; review — "running the review pass", "collecting findings", "writing the verification report".

**Repo rules:** plain submitter vocabulary — NEVER surface GitHub/PR/repo/SPEC.md/ADR/gate/stage-number/Control-center words on the submitter face (CONTEXT.md). Quiet-by-default; status by shape; tokens not hardcoded colors; keyboard parity (admin). Commits `feat(web):` / `fix(web):`. Dev stack may be up (API :8001, web :4200); the submitter side needs a submitter session — sign in via the submitter login (not the reviewer bypass) to view `/requests/:id`, or hit the route directly.

**Out of scope:** route-default flip, Board/Pipeline/old-issue deletion, vocabulary purge → Plan 5. Brand-art hexes (login hero, `--hero-grad`) stay saturated in both themes (intentional).

---

### Task 1: `plainActivity()` submitter-safe dictionary + vitest

**Files:**
- Modify: `web/src/app/core/util.ts`
- Modify: `web/src/app/core/util.spec.ts`

- [ ] **Step 1: Write the failing tests** — append to `util.spec.ts` (extend import with `plainActivity`):

```typescript
describe('plainActivity', () => {
  const run = (label: string | null, step = 6, of = 9) => ({ label, step, of, health: 'healthy' as const, seconds_since_event: 5 });
  it('translates a known admin label to plain words with progress', () => {
    expect(plainActivity(run('authoring failing tests'))).toBe('writing tests · step 6 of 9');
    expect(plainActivity(run('implementing the change'))).toBe('making the change · step 6 of 9');
    expect(plainActivity(run('running the review pass'))).toBe('reviewing the work · step 6 of 9');
  });
  it('NEVER leaks an unknown/internal label — falls back to a safe phrase', () => {
    expect(plainActivity(run('git rebase onto main'))).toBe('working on it · step 6 of 9');
    expect(plainActivity(run('SPEC.md PR #142'))).toBe('working on it · step 6 of 9');
    expect(plainActivity(run(null))).toBe('working on it · step 6 of 9');
  });
  it('omits progress when step/of are missing', () => {
    expect(plainActivity({ label: 'refactoring', step: 0, of: 0, health: 'no_signal', seconds_since_event: 1 })).toBe('tidying up');
  });
  it('returns null for no run', () => {
    expect(plainActivity(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Verify fail** — `cd web && npx ng test` → FAIL (`plainActivity` not exported).

- [ ] **Step 3: Implement in `util.ts`** — extend the models import with `RunState`, append:

```typescript
/** Admin step labels → submitter-safe phrases. Anything NOT in this map is
 *  rendered as the generic fallback, so internal/GitHub vocabulary can never
 *  leak to the submitter face (CONTEXT.md). */
const ACTIVITY_WORDS: Record<string, string> = {
  'reading SPEC.md': 'reading your request',
  'drafting PLAN.md': 'planning the work',
  'writing ADRs': 'planning the work',
  'validating plan against SPEC.md': 'checking the plan',
  'authoring failing tests': 'writing tests',
  'running the RED gate': 'writing tests',
  'implementing the change': 'making the change',
  'running the test suite': 'running the tests',
  refactoring: 'tidying up',
  'running the test-isolation gate': 'running the tests',
  'running the review pass': 'reviewing the work',
  'collecting findings': 'reviewing the work',
  'writing the verification report': 'finishing the review',
};

/** The submitter's "what's happening now" line, derived from the live run.
 *  null when nothing is running. Safe by construction — unknown labels become
 *  "working on it", never the raw label. */
export function plainActivity(run: RunState | null): string | null {
  if (!run) return null;
  const phrase = (run.label && ACTIVITY_WORDS[run.label]) || 'working on it';
  if (run.of > 0 && run.step > 0) return `${phrase} · step ${run.step} of ${run.of}`;
  return phrase;
}
```

- [ ] **Step 4: Run tests** — `cd web && npx ng test` → PASS (55 + plainActivity cases). Lint clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/util.ts web/src/app/core/util.spec.ts
git commit -m "feat(web): plainActivity — submitter-safe translation of the live run, no vocab leak"
```

---

### Task 2: Submitter detail "what's happening now" line

**Files:**
- Modify: `web/src/app/submitter/request-detail.ts`

- [ ] **Step 1: Wire it in** — import `plainActivity` from `../core/util`. In the `timeline()` computed, the "Building · the Factory is on it" row (the `approvedPast` branch where `stageIdx < 2`) should use the live activity when present:

Find:
```typescript
          : {
              glyph: 'ring',
              fill: 0.4,
              color: 'var(--a500)',
              title: 'Building',
              meta: 'the Factory is on it',
            },
```
Replace `meta` with the live line, falling back to the calm default:
```typescript
          : {
              glyph: 'ring',
              fill: 0.4,
              color: 'var(--a500)',
              title: 'Building',
              meta: plainActivity(r.run) ?? 'the Factory is on it',
            },
```

Also update the "In review" row (the `stageIdx >= 2 && r.stage !== 'done'` branch, `title: 'In review'`) similarly: `meta: plainActivity(r.run) ?? 'final checks'`.

(The submitter `RequestDetail` already carries `run` — Plan 3 added it to the type. No new fetch; the existing poll refreshes it.)

- [ ] **Step 2: Web gate + leak check**

Run: `cd web && npx ng test && npx ng lint && npx ng build` — green.
Manual leak audit: grep the rendered phrases — the only strings that can appear are the `ACTIVITY_WORDS` values + "working on it" + the existing plain-stage words. Confirm no admin label can reach the DOM (it can't — `plainActivity` maps or falls back).

- [ ] **Step 3: Visual check** (submitter session, dev stack): drive a request to Building (approve its spec in the admin Gates, let the sim run), open `/requests/:id` as the submitter — the Building row reads e.g. "making the change · step 3 of 6" and advances calmly as the sim ticks, never showing GitHub/SPEC.md/ADR words.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/submitter/request-detail.ts
git commit -m "feat(web): submitter sees a calm live activity line while the Factory builds"
```

---

### Task 3: Dark theme tokens + no-flash pre-paint

**Files:**
- Modify: `web/src/styles.css`
- Modify: `web/src/index.html`

- [ ] **Step 1: Add the dark token block** to `web/src/styles.css`, directly AFTER the `:root { … }` block (so it overrides). Use exactly these values (warm near-black, brand-tinted, AA-tuned):

```css
[data-theme='dark'] {
  /* neutrals — warm near-black, never #000 */
  --bg: #131019;
  --surface: #1b1722;
  --surface-2: #241f2e;
  --surface-3: #2e2839;
  --fg1: #f3f1f7;
  --fg2: #c9c4d4;
  --muted: #9b94a8;
  --faint: #847d92; /* ~4.5:1 on --bg */
  --border: #322c3e;
  --border-strong: #473f58;
  --hairline: #272130;

  /* accent — keep the vivid ramp for fills/strokes; flip the LIGHT tints to
     dark wells, and brighten link/text-accent so purple reads on dark. */
  --a50: #2a1140;
  --a100: #371a52;
  --accent-tint: #2a1140;
  --accent-tint-bd: #4a2a6e;
  --accent-link: #d78bf9;
  /* --a200..--a900, --a500/--a600 (button bg with white text), --accent,
     --accent-hover, --accent-active stay as in :root — white-on-purple AA holds. */

  /* status — backgrounds darken, text lightens; bases brighten for dark */
  --amber: #e0962a;
  --amber-bg: #36280f;
  --amber-tx: #f0c474;
  --amber-line: #7a5a1e;
  --red: #e0655a;
  --red-bg: #371915;
  --red-tx: #f1a99f;
  --red-line: #7a352c;
  --green: #46b07a;
  --green-bg: #15301f;
  --green-tx: #84d3a4;
  --info: #4a90d0;
  --info-bg: #142838;

  /* elevation — deeper on dark */
  --shadow-pop: 0 6px 22px -8px rgba(0, 0, 0, 0.55), 0 2px 6px -3px rgba(0, 0, 0, 0.45);
  --shadow-overlay: 0 24px 60px -18px rgba(0, 0, 0, 0.66), 0 6px 18px -8px rgba(0, 0, 0, 0.5);
  --shadow-panel: -18px 0 44px -24px rgba(0, 0, 0, 0.55);
}
```

Leave `--hero-grad` and the type/radii/motion tokens unchanged (theme-agnostic).

- [ ] **Step 2: Add a `color-scheme` hint** so native form controls/scrollbars match. In the same dark block add `color-scheme: dark;` and add `color-scheme: light;` to `:root`.

- [ ] **Step 3: No-flash pre-paint** — in `web/src/index.html`, add an inline script in `<head>` BEFORE the app loads (inline so it runs before first paint):

```html
    <script>
      (function () {
        try {
          var t = localStorage.getItem('sf-theme') || 'system';
          var dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
          document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        } catch (e) {}
      })();
    </script>
```

- [ ] **Step 4: Build + a first dark smoke** — `cd web && npx ng build && npx ng lint`. Temporarily set `localStorage.setItem('sf-theme','dark')` in the browser (or add `data-theme="dark"` on `<html>` via devtools) and load `/admin/mission` — the whole shell flips to dark. It will have rough edges (hardcoded hexes, maybe low-contrast purple chips) — those are Task 5. Confirm the bulk (bg/surface/text/borders) is correct and readable.

- [ ] **Step 5: Commit**

```bash
git add web/src/styles.css web/src/index.html
git commit -m "feat(web): dark theme token set + no-flash pre-paint attribute"
```

---

### Task 4: Theme service + Settings "Appearance" control

**Files:**
- Create: `web/src/app/core/theme.service.ts`
- Modify: `web/src/app/admin/settings.ts`

- [ ] **Step 1: Create `web/src/app/core/theme.service.ts`**

```typescript
import { Injectable, signal } from '@angular/core';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'sf-theme';

/** Single source of truth for the color theme (spec §7). The choice persists to
 *  localStorage; 'system' follows prefers-color-scheme live. The resolved value
 *  is written to <html data-theme>, matching the index.html pre-paint script. */
@Injectable({ providedIn: 'root' })
export class Theme {
  choice = signal<ThemeChoice>(this.read());
  private mq = matchMedia('(prefers-color-scheme: dark)');

  constructor() {
    this.mq.addEventListener('change', () => {
      if (this.choice() === 'system') this.apply();
    });
    this.apply();
  }

  set(choice: ThemeChoice) {
    this.choice.set(choice);
    try {
      localStorage.setItem(KEY, choice);
    } catch {
      /* private mode — in-memory only */
    }
    this.apply();
  }

  /** The resolved light|dark actually in effect. */
  resolved(): 'light' | 'dark' {
    const c = this.choice();
    return c === 'dark' || (c === 'system' && this.mq.matches) ? 'dark' : 'light';
  }

  private apply() {
    document.documentElement.dataset.theme = this.resolved();
  }
  private read(): ThemeChoice {
    try {
      const v = localStorage.getItem(KEY);
      if (v === 'light' || v === 'dark' || v === 'system') return v;
    } catch {
      /* ignore */
    }
    return 'system';
  }
}
```

- [ ] **Step 2: Add an Appearance control to `web/src/app/admin/settings.ts`** — inject `Theme`; add a section above or below Notifications (match the page's existing section markup — eyebrow/h2 + rows). A 3-way segmented control:

```html
        <div class="card" style="margin-top:18px;padding:18px 20px">
          <h2 style="font-size:20px">Appearance</h2>
          <div class="row" style="margin-top:14px;gap:8px">
            <div class="seg">
              <button [class.on]="theme.choice() === 'light'" (click)="theme.set('light')">Light</button>
              <button [class.on]="theme.choice() === 'dark'" (click)="theme.set('dark')">Dark</button>
              <button [class.on]="theme.choice() === 'system'" (click)="theme.set('system')">System</button>
            </div>
            <span style="font-size:12.5px;color:var(--muted)">Follows your device when set to System.</span>
          </div>
        </div>
```

Reuse the existing `.seg` segmented-control styles (the view toggle uses `.seg` — confirm it's global in styles.css; if it's component-scoped in admin-shell, add a minimal local `.seg` style or lift it). Add `protected theme = inject(Theme);` to the class (import `inject` + `Theme`).

- [ ] **Step 3: Web gate + behavior** — `cd web && npx ng test && npx ng lint && npx ng build` green. In the browser: Settings → Appearance → Dark flips the app instantly and persists across reload (no flash on reload — the pre-paint script reads the same key); System follows the OS setting; toggling the OS theme while on System updates live.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/core/theme.service.ts web/src/app/admin/settings.ts
git commit -m "feat(web): Theme service + Settings appearance control (light/dark/system)"
```

---

### Task 5: Dark contrast pass — tokenize breaking hexes + fix purple-on-dark

The token swap leaves two classes of problem: (a) hardcoded hexes that ignore the theme, (b) accent tokens used as TEXT on the now-dark `--a50`/`--accent-tint` wells. Fix both, verified by dark screenshots.

**Files:**
- Modify: `web/src/styles.css` (add tokens + dark overrides)
- Modify: the component files holding the breaking hexes (see Step 1)

- [ ] **Step 1: Inventory** — run `grep -rnE "#[0-9A-Fa-f]{6}" web/src/app --include="*.ts"` and identify hexes that sit on theme-flipping surfaces. Known offenders to tokenize (NOT the brand-art ones in `login.ts`/`--hero-grad`):
  - avatar default colors `#6E5A8A` / `#7A6E9A` (used in issue.ts, feed.ts, request-detail.ts, kit.ts, my-requests.ts) → add `--avatar: #6E5A8A;` to `:root` and a dark value `--avatar: #8b73b0;` to the dark block; replace the literals with `var(--avatar)`.
  - the green confirmation border `#BCDBC9` in `submitter/request-detail.ts:73` → replace with `var(--green-line, #BCDBC9)`; add `--green-line: #bcdbc9;` to `:root` and `--green-line: #2c5a3f;` to dark.
  - any escalation/spec hardcoded hexes in `kit.ts` (EscalationBox/SpecLines) that sit on `--red-bg`/`--amber-bg` → tokenize against the existing `--red-line`/`--amber-line` (now themed).
  Leave purely decorative brand hexes (login art, hero gradient) alone.

- [ ] **Step 2: Purple-on-dark text** — find accent text that sits on the flipped wells and would lose contrast: `--a700`/`--a600` used as TEXT on `--a50`/`--accent-tint` backgrounds (e.g. `.msn-stagepill` color `--a700` on bg `--a50`; `.rd-row__ack` `--a700` on `--a50`; queue/issue purple chips). For each such pairing, in the DARK block introduce a light-purple text token and point those rules at it: add `--accent-on-tint: var(--a700);` to `:root` and `--accent-on-tint: #e9b8fb;` to dark, then change those specific `color: var(--a700)` rules (only the ones on tint wells) to `var(--accent-on-tint)`. Verify each in a dark screenshot.

- [ ] **Step 3: Dark screenshots + fix loop** — with `data-theme="dark"`, screenshot and eyeball AA on: `/admin/mission` (gate cards, run rows, stage pills, ack chip), `/admin/requests/:id` (trace rows, evidence strip, gate-event amber, steer chip), `/admin/queue` (merge evidence, triage), `/admin/apps/:key` (feed cards), and the submitter `/requests/:id` (timeline, the green confirmation card, amber send-back card). Fix any element where text drops below ~4.5:1 or a hardcoded hex stayed light. Repeat until clean.

- [ ] **Step 4: Web gate** — `cd web && npx ng test && npx ng lint && npx ng build && npm run format:check` green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(web): dark-mode contrast pass — tokenize avatar/green/escalation hexes; purple-on-dark text"
```

---

### Task 6: Full verification + light/dark visual proof

- [ ] **Step 1: `make verify`** from repo root — lint + pytest + vitest + build + smoke all green. (Run `npm run format:check` in web first; prettier-write + fold a `style(web):` commit if needed.)

- [ ] **Step 2: Visual proof** — dev stack up. Capture BOTH themes at 1440 and the submitter at 390:
  1. `/admin/mission` — light AND dark (toggle via Settings or localStorage). Bands legible in both; one-amber/one-red discipline holds in dark.
  2. `/admin/requests/:id` (an in-flight request) — light AND dark. Trace + evidence legible in dark.
  3. Submitter `/requests/:id` of a Building request — the live activity line ("making the change · step N of M"), at 390px, light AND dark. Confirm NO admin/GitHub vocabulary.
  4. Reload in dark mode — confirm NO white flash before paint.

- [ ] **Step 3: Report** the light/dark screenshots + any deviations. Done = verify green + both themes legible + no vocab leak + no flash.

---

## Self-review notes (already applied)

- **Spec coverage:** §6 submitter transparency = live activity line from `run`, plain words, no leak ✓ (T1/T2); §7 dark mode = `[data-theme]` token swap ✓ (T3), system default + Settings toggle + localStorage persist ✓ (T4), pre-paint no-flash ✓ (T3), AA + tokenized hexes ✓ (T5), both faces ✓ (submitter inherits the same attribute/key — no submitter toggle needed; admin owns the control).
- **Safety:** `plainActivity` is leak-proof by construction (map-or-fallback) and vitest-pinned with adversarial inputs ("SPEC.md PR #142" → "working on it").
- **No-flash:** the index.html inline script and the Theme service read the SAME `sf-theme` key and resolve identically, so reload paints the stored theme immediately.
- **Risk acknowledged:** dark mode is the broadest-blast-radius change; T5 + T6 are explicit visual-verification gates rather than blind edits. Brand-art hexes (login, hero gradient) intentionally stay saturated in both themes.
- **Deferred:** Plan 5 still owns the route flip, old-page deletion, vocab purge, and repointing the remaining old-issue links (admin-shell new-issue redirect, list.ts, board.ts).
- **Type consistency:** `plainActivity(RunState|null)` (T1) consumes the same `RunState` the detail page already holds via `r.run`; `Theme` choice type `'light'|'dark'|'system'` matches the localStorage values the pre-paint script reads.
