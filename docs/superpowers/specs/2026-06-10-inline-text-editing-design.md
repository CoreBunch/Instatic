# Inline text editing on the canvas (double-click to edit) — Design

Date: 2026-06-10
Status: **superseded in implementation** — approach 1A (parent-doc overlay) was replaced by in-place `contentEditable` editing of the real element. The module contract, the editor-store session (`activeInlineEdit` in `inlineEditSlice`), the live-commit-coalescing-into-one-undo model, and Escape-cancel-via-one-`undo()` below are all still accurate. Only the *editing surface* changed.

> ## Superseding note (implementation)
>
> The parent-document overlay editor (a `<textarea>`/`<input>` floated over the node, with computed typography mirrored from the iframe and the site's fonts injected into the parent doc) was dropped in favour of editing the **real node element in place**. `NodeRenderer` builds an `InlineEditBinding`; the module spreads `inlineEditableElementProps(binding)` (`src/modules/base/shared/inlineText.ts`) onto its own root element, making it `contentEditable="plaintext-only"`. React must NOT own that element's content — React 19 re-applies `dangerouslySetInnerHTML` on every commit, which would overwrite the user's keystrokes and reset the caret — so the element renders with no content prop and `NodeRenderer` seeds it **imperatively** once (`seedInlineEditableContent`, escaped value with `\n` → `<br>`) in the same layout effect that focuses it. Because the author edits the actual published element, fidelity is 100% — no overlay, no typography mirroring, no parent-doc font injection, no hidden/doubled text.
>
> Key facts that differ from the body below:
> - **No `InlineTextEditOverlay`, no `data-instatic-inline-editing` attribute, no canvas-chrome hide rule, no `mirrorInlineEditTypography` / `ParentDocumentSiteFontsInjector`** — all removed.
> - **Line breaks** (user's decision): the value stores newlines as `\n` and both render surfaces map each `\n` → `<br>` (`textToBreakHtml` publisher path, `rawTextToBreakHtml` canvas path; DOMPurify allows `<br>`). For multiline `base.text`, plain Enter inserts a hard break and Cmd/Ctrl+Enter commits; single-line modules commit on Enter.
> - **Read-back:** `readInlineEditableText(el)` returns `el.innerText` (resolves `<br>`/block boundaries to `\n`), fed to `applyInlineEditValue` on every `onInput`.
> - **Content ownership:** React renders the editing element with NO `dangerouslySetInnerHTML` and NO children; the canvas seeds it imperatively (`seedInlineEditableContent`) and reads it back on `onInput`. This is required — a React-owned content prop is re-applied on every commit and wipes the live edit + caret.
> - **Focus:** a `useLayoutEffect` in `NodeRenderer` seeds the content, focuses the element, and collapses the caret to the end on session start.
> - **Keyboard:** `useCanvasKeyboardShortcuts` AND the `useCanvas` space-to-pan handler both bail on `activeInlineEdit`, so Delete/Cmd+D never fire and the spacebar types a space (the iframe forwards keystrokes to the parent `document`, where the space-pan guard's `target.isContentEditable` check can't see the cross-realm editing element). The element's own `onKeyDown` owns Escape/Enter.
>
> Current behaviour lives in `docs/features/canvas-iframe-per-frame.md` → "Inline text editing (in-place `contentEditable`)".

## Goal

Double-click a text-bearing node on the canvas and edit its text in place. The editor renders a real `<textarea>`/`<input>` in the **parent document**, positioned over the node inside the breakpoint iframe — no cross-frame focus negotiation (the documented reason the old in-iframe `contenteditable` was removed; see `docs/features/canvas-iframe-per-frame.md`).

**v1 scope:** `base.text` (`text` prop), `base.button` (`label` prop), `base.link` (`text` prop, only when the node has no children — `text` renders only childless).

## Module contract

`ModuleDefinition` gains an optional field:

```ts
inlineTextEdit?: { prop: string; multiline?: boolean }
```

- `base.text`: `{ prop: 'text', multiline: true }`
- `base.button`: `{ prop: 'label' }`
- `base.link`: `{ prop: 'text' }`

Modules without the field keep the current no-op double-click. This is the extension point future modules (and plugin modules) use; no per-module special cases in canvas code.

## Editor state

New editor-store UI state (not page-tree state):

```ts
activeInlineEdit: {
  nodeId: string
  prop: string
  breakpointId: string   // the frame the user double-clicked in
  multiline: boolean
  initialValue: string
  committed: boolean     // true once any keystroke has been committed
} | null
```

Actions: `startInlineEdit(nodeId, breakpointId)` (resolves module def; no-ops if not editable), `endInlineEdit()` (commit + close), `cancelInlineEdit()` (revert + close).

## Interaction flow

1. **Start:** `CanvasRoot.onNodeDoubleClick(nodeId, e)` (currently an intentional no-op) resolves the node's module def. If `inlineTextEdit` exists — and for `base.link`, the node has no children — it calls `startInlineEdit`. Selection behavior of the preceding single-clicks is unchanged.
2. **Overlay:** a new `InlineTextEditOverlay` component (sibling of `BreakpointSelectionOverlay`, same portal pattern) renders the input positioned over the node element rect via the existing zoom-aware `measureCanvasElementRect`, tracked with the existing RAF-loop pattern so it follows pan/zoom/reflow. Typography is mirrored from the live element via `iframe.contentWindow.getComputedStyle(el)` (same-origin `srcdoc` iframes): font-family/size/weight/style, line-height, letter-spacing, color, text-align — with lengths scaled by the iframe scale factor. Transparent background, no border, focus ring from the existing canvas affordance token.
3. **Live commit:** every input event calls `updateNodeProps(nodeId, { [prop]: value })`. Single-field patches already produce the coalesce key `props:<nodeId>:<prop>`, so the whole editing burst is **one undo entry**, and all breakpoint frames preview the change live.
4. **Hide doubled text:** while a session is active, the edited node *in the session's frame* renders its text transparent (NodeRenderer sets a data attribute on the node wrapper; a canvas-injected stylesheet rule keys off it). Other frames keep showing the live-updating text.
5. **End:**
   - Enter (single-line) or Cmd/Ctrl+Enter (multiline) → commit + close. Plain Enter in multiline inserts a newline only if `base.text` actually renders newlines (verify `white-space` handling during implementation; if it doesn't, Enter commits everywhere).
   - Blur → commit + close.
   - Escape → cancel: if `committed`, call `undo()` exactly once (the burst is one history entry), then close.
6. **Force-close without committing:** node deleted externally, active page/document switched, or the frame unmounts → session clears.

## Keyboard / shortcut interplay

The input lives in the parent document, so the existing `isTextInputTarget` guard already suppresses canvas Delete/duplicate/clipboard shortcuts while typing. No new suspension mechanism needed. `e.stopPropagation()` on the overlay keeps canvas click/drag handlers out.

## Out of scope

`base.list` items, richtext, double-click-to-enter Visual Components (separately removed; not restored here), any in-iframe `contenteditable`.

## Error handling

- Module def missing or no `inlineTextEdit` → double-click stays a no-op.
- `measureCanvasElementRect` returns null (node unmounted mid-session) → force-close session.
- Prop value not a string (corrupt tree) → no-op start, `console.warn('[canvas] …')`.

## Testing

- Store tests: session lifecycle; live commit produces exactly one undo entry per burst; Escape-cancel restores the original value via single undo; force-close on node deletion/page switch; start no-ops for non-editable modules and link-with-children.
- Module tests: text/button/link declare `inlineTextEdit` with the right prop names.
- Browser smoke test (local seeded data only): double-click → type → all frames update live → Enter commits → Cmd+Z restores; Escape path; shortcut suppression while editing.
- `bun test`, `bun run build`, `bun run lint` clean.

## Docs

Update `docs/features/canvas-iframe-per-frame.md` (replace the "future double-click behaviour" notes with the implemented overlay design) and `docs/editor.md` in the same change.
