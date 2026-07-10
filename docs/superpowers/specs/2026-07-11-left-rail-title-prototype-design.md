# Left-Rail Title Prototype

## Final Decision

The prototype answered the question by rejecting the stepper itself. Do not promote any A-E title treatment. Remove the desktop rail, journey dots, mobile progress chip, prototype switcher, variant query-parameter handling, and prototype keyboard controls from `SubShell`.

Keep the top navigation, projected step content, Lenis scrolling, and navigation controls owned by the individual step pages. Remove the throwaway prototype tests after the cleanup is verified.

## Question

What should replace the Intake journey's left-rail `Describe` title now that the tracing beam is no longer wanted?

## Prototype Scope (Historical)

Build a throwaway UI prototype on the existing `/submit/new` route. Five treatments are selected with the shareable `?variant=A` through `?variant=E` query parameter and a development-only floating switcher. The existing page, data flow, and form behavior stay unchanged.

All variants remove the tracing-beam track, gradient fill, glowing head, and scroll-linked beam behavior. The small journey dots remain because they communicate position and provide existing back-navigation.

## Variants Tested (Historical)

- **A — Chapter label:** `01 / DESCRIBE` in restrained editorial typography.
- **B — Vertical index:** a large `01` paired with a stacked or vertical `Describe` label.
- **C — Compact pill:** a quiet rounded marker containing `1  Describe`.
- **D — Bracket marker:** `Describe` framed by a slim corner or bracket motif.
- **E — Margin caption:** a small `Current section` eyebrow above a larger `Describe` label.

The variants must differ in structure and hierarchy, not only color or type size. They should use the existing tokens and remain legible in both themes.

## Prototype Wiring (Historical)

`SubShell` reads the current route's `variant` query parameter and renders the corresponding left-rail treatment. Unknown or absent values fall back to A. The bottom-center switcher cycles A-E, updates the URL without leaving the route, and supports Left/Right Arrow keys unless focus is in a text-entry control.

The switcher is visibly separate from the product UI and only appears in development mode. No backend calls or persisted state are added.

## Review Outcome and Cleanup

All five options were made available on `/submit/new`. No treatment won. Delete every variant and the prototype switcher, then remove the whole stepper.

## Verification

- No desktop rail, journey dots, mobile progress chip, or prototype switcher is rendered.
- `variant` query parameters do not change the page UI or enable keyboard shortcuts.
- The description textarea and page-level keyboard behavior remain unaffected.
- Top navigation, projected step content, and Lenis scrolling continue to work.
- Existing Intake build succeeds.
