# Point-to-edit — how Cursor / v0 / Lovable do it, and our redesign

*Research 2026-07-09 for the Prototype-step point-to-edit redesign.*

## How the leading tools do element-select-to-edit

- **Cursor** (browser visual editor, Cursor 2.x): hover highlights an element, **click references
  it in chat**, then you describe the change in plain language ("make this bigger", "turn this
  red"). Also offers a style sidebar for direct manipulation.
  ([blog](https://cursor.com/blog/browser-visual-editor), [docs](https://cursor.com/docs/agent/tools/browser))
- **v0 Design Mode**: toggled from the composer toolbar; the cursor becomes a selection tool,
  hover highlights, **click shows selection handles + a floating design panel**; Layers +
  Properties panels. ([docs](https://v0.app/docs/design-mode))
- **Lovable Visual Edits**: a **"Select elements" button / shortcut `S`**; click an element → it
  **attaches as a reference chip to the chat input**; **Cmd/Ctrl-click multi-selects**; type the
  instruction → applies to all selected. ([blog](https://lovable.dev/blog/visual-edits))

**Convergent pattern:** enter a *select mode* from a toolbar button (with a keyboard shortcut) →
hover-highlight the element (often with a label) → click **attaches the element as a chip to the
composer** → type the natural-language edit. Multi-select via modifier-click. v0/Cursor add style
panels for direct manipulation, but those belong to source-editing tools; our edits are
natural-language on a throwaway mock, so the chip-to-composer model (Lovable) is the right fit.

## What was wrong before

The old control was a **switch toggle labelled "Point to edit"** — the switch overlapped the
label (visual bug), the selection gave no label feedback, was single-only, and cleared on pick.

## Our redesign (shipped 2026-07-09)

- **Entry:** a clean **"Select to edit"** icon button (target icon) in the preview toolbar;
  highlighted (accent) and reads **"Selecting…"** when active. Keyboard: **`S`** toggles, **`Esc`**
  exits. A hint banner appears while active ("Click an element to edit it · Cmd/Ctrl-click for
  several · Esc to stop").
- **Hover:** accent outline + a **floating label** with the element's text/tag (devtools/v0 style).
- **Click:** the element gets a **persistent outline** and attaches as a **chip** to the composer;
  **Cmd/Ctrl-click multi-selects** → multiple chips. Removing a chip re-syncs the outlines.
- **Handoff:** the picked element(s) ride with the next instruction as scoped context — one dict,
  or a **list** when multi-selected (backend `annotation: dict | list`; the edit prompt scopes
  "change only this / these").
- **Mechanics:** the inspector is injected into the `iframe srcdoc` at render (CSP-safe), stamps a
  `data-pid` when missing, and talks to the Angular parent via `postMessage` (`sf-inspect` arm /
  `sf-sync` selection / `sf-annot` report); parent validates `event.source === iframe.contentWindow`.

## Related redesign shipped the same day
- **Review** page widened to two columns (spec left, prototype right, ~1180px) with a **structured
  spec** (Overview + sections: Who it's for / Core features / How it works / Constraints / Success
  measure), replacing the flat overview+highlights.
- **Prototype full-screen** overlay (button in the Review card + the Prototype toolbar) for review.
