# Left-Rail Title Prototype

## Final Decision

The prototype answered the question by rejecting the stepper itself. Do not promote any A-E title treatment. Remove the desktop rail, journey dots, mobile progress chip, prototype switcher, variant query-parameter handling, and prototype keyboard controls from `SubShell`.

Keep the top navigation, projected step content, Lenis scrolling, and navigation controls owned by the individual step pages. Remove the throwaway prototype tests after the cleanup is verified.

## Question

What should replace the Intake journey's left-rail `Describe` title now that the tracing beam is no longer wanted?

## Scope

Build a throwaway UI prototype on the existing `/submit/new` route. Five treatments are selected with the shareable `?variant=A` through `?variant=E` query parameter and a development-only floating switcher. The existing page, data flow, and form behavior stay unchanged.

All variants remove the tracing-beam track, gradient fill, glowing head, and scroll-linked beam behavior. The small journey dots remain because they communicate position and provide existing back-navigation.

## Variants

- **A — Chapter label:** `01 / DESCRIBE` in restrained editorial typography.
- **B — Vertical index:** a large `01` paired with a stacked or vertical `Describe` label.
- **C — Compact pill:** a quiet rounded marker containing `1  Describe`.
- **D — Bracket marker:** `Describe` framed by a slim corner or bracket motif.
- **E — Margin caption:** a small `Current section` eyebrow above a larger `Describe` label.

The variants must differ in structure and hierarchy, not only color or type size. They should use the existing tokens and remain legible in both themes.

## Prototype Wiring

`SubShell` reads the current route's `variant` query parameter and renders the corresponding left-rail treatment. Unknown or absent values fall back to A. The bottom-center switcher cycles A-E, updates the URL without leaving the route, and supports Left/Right Arrow keys unless focus is in a text-entry control.

The switcher is visibly separate from the product UI and only appears in development mode. No backend calls or persisted state are added.

## Review and Cleanup

Review all five options on `/submit/new` in the running Intake app. Once one treatment wins, record the choice, delete the four losing treatments and prototype switcher, and implement the selected rail treatment as production code.

**Recorded outcome:** no treatment won. The whole stepper should be removed.

## Verification

- Each `?variant=A-E` URL selects the expected title treatment.
- No tracing beam or glowing beam head is visible in any option.
- Journey dots and their existing navigation behavior remain intact.
- Arrow-key switching does not interfere with the description textarea.
- Existing Intake build succeeds.
