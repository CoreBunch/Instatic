# Canvas: iframe-per-viewport rendering

How the visual editor canvas renders page trees inside isolated per-viewport iframes, and how the design and live views are built on top of that foundation.

Each viewport frame runs in its own `<iframe>` with its own `<html><body>`. The page tree portals into the iframe body, so user CSS, combinators (`>`, `+`, `:nth-child()`), and viewport units behave exactly as on the published page — no selector rewriting, no scoping, no impedance mismatch.

---

## TL;DR

- `IframeFrameSurface` is the iframe primitive. It boots from an empty `srcDoc`, captures the iframe document, and mounts children via `createPortal(tree, iframeDoc.body)`.
- **Design mode** renders one `IframeFrameSurface` per framed viewport context inside `CanvasTransformLayer` (pan/zoom). All frames mount as soon as the page document is in the store — the tree is already in memory, so there is nothing to stagger; `CanvasTransformLayer` renders skeleton frames only while the document itself hasn't loaded yet (`page === null`). **Live mode** renders a single real-size `IframeFrameSurface` inside `CanvasLiveSurface` (normal scroll).
- Both modes are fully editable — click-to-select, properties panel, structural edits all work. Neither is a read-only preview.
- CSS arrives in each iframe via three injectors: `EditorChromeInjector` (unlayered), `ClassStyleInjector` (`@layer user-authored`), `UserStylesheetInjector` (`@layer user-authored`).
- Wheel, pointer, and keyboard events are forwarded from inside the iframe to the parent's gesture / reorder-drag / shortcut handlers. `Tab` is blocked to prevent tab-walking inside the design preview.
- Plugin canvas modules use a separate, sandboxed `ModuleSandboxFrame` (not `IframeFrameSurface`).

---

## Why iframes

Without iframes, each viewport frame was a `<div>` inside the editor's document. Two structural mismatches made the canvas unreliable:

1. **`body` was the editor chrome.** `body { background: black }` painted the entire editor.
2. **NodeWrapper divs between authored elements.** CSS combinators (`>`, `+`, `~`, `:nth-child()`) saw wrapper divs, not authored elements, so authored selectors didn't match.

The iframe gives each frame its own real `<body>`. User CSS works unchanged. Modules spread editor-plumbing props (`data-node-id`, click/hover handlers) directly onto their root element — no `<div display:contents>` wrapper between siblings.

---

## IframeFrameSurface

Source: `src/admin/pages/site/canvas/IframeFrameSurface.tsx`

```text
IframeFrameSurface
  <iframe srcDoc="<!doctype html><html>…">
    (inside iframe document, via createPortal)
    ├── EditorChromeInjector   (head: unlayered editor chrome CSS)
    ├── ClassStyleInjector     (head: @layer user-authored — publisher reset + class registry)
    ├── UserStylesheetInjector (head: @layer user-authored — user-uploaded stylesheets)
    ├── {children}             (body: React node tree via NodeRenderer)
    └── RuntimeScriptInjector (body: opt-in runtime scripts when "Run scripts" is on)
```

### Interaction modes

`interaction` prop controls two distinct behaviours:

| Mode | `interaction` value | Height | Scroll | Wheel | Pointer | Keyboard | Canvas chrome CSS |
|---|---|---|---|---|---|---|---|
| Design canvas frame | `'canvas'` (default) | grows to content | none (frame scrolls with canvas pan) | forwarded to parent pan/zoom | forwarded for middle-click / space pan | forwarded to parent `document` (shortcuts); `Tab` blocked | applied (cursor, user-select, outline overrides) |
| Live frame | `'live'` | 100% | native (iframe is the scroll viewport) | not forwarded | not forwarded | not forwarded | not applied (real cursors, text selection) |

### Viewport-unit feedback loop guard

The canvas frame grows to content height (so no inner scrollbar appears on the infinite surface). `vh`/`vmin`/`vmax` units size against the iframe element's height — writing a new height feeds back into the viewport unit, which grows the content, which fires the observer again. The frame measures content inside a `requestAnimationFrame`, caps consecutive self-driven resizes at 60, and resets the cap on any DOM mutation that didn't come from its own height writes. When a long page is replaced by a shorter page, the measurement ignores `documentElement.scrollHeight` if it is only reporting the old iframe viewport floor, so frames can shrink to the new body content height.

Design frames override `html` and `body` to `height: auto` but give the iframe body a fixed `min-height` equal to `CANVAS_VIEWPORT_HEIGHT` (800 px). This makes the page body occupy the visible artboard floor for short pages without using `100vh`, which would point back at the auto-sized iframe height and reintroduce the feedback loop.

---

## Design mode

Source: `src/admin/pages/site/canvas/CanvasTransformLayer.tsx`, `BreakpointFrame.tsx`

`CanvasRoot` renders `CanvasTransformLayer` when `canvasView === 'design'`. The transform layer contains one `BreakpointFrame` per viewport context (filtered to `bp.previewFrame !== false`). Each frame wraps an `IframeFrameSurface` in `interaction='canvas'` mode with a label button above it.

Viewport contexts flagged `previewFrame: false` are frameless — they're still selectable editing contexts in the context selector (overrides route to them) but don't render a canvas iframe.

Frames mount as soon as the page document is in the store. The node tree is already in memory, so every `BreakpointFrame` mounts its iframe and `NodeRenderer` tree directly — there is no async load to stage and no per-frame stagger. `CanvasFrameSkeletonFrame` covers the only genuine wait: the document not being loaded yet (`page === null`). The same shared skeleton frame is used by the editor-body lazy fallback and the no-site canvas state, so startup does not step through separate text-only loading screens.

(An earlier version staged inactive frames behind a `requestAnimationFrame` → `setTimeout` → `requestIdleCallback` chain. That was an unmeasured optimization for a cost — mounting in-memory trees — that is cheap in practice, and it could strand frames as skeletons forever whenever `requestAnimationFrame` was suspended, e.g. a backgrounded tab or a headless CI runner. It was removed in favour of mounting directly.)

The active viewport context (highlighted, drives style override routing) is tracked by `activeBreakpointId` in `canvasSlice`.

**Initial centering on load and document switch.** The transform layer always starts at pan `(0, 0)`, which places the leftmost (narrowest) frame at the top-left. On first load and whenever the active document changes (page switch, entering/leaving a Visual Component), `CanvasRoot` runs a `useEffect` keyed on `canvasPage.id` that calls `useCanvas().centerOnBreakpointFrame` to pan the canvas so the active breakpoint frame is horizontally centered and its top sits just below the viewport top. The geometry is computed by `panToCenterBreakpointFrame` in `canvasDomGeometry.ts`. The effect retries on a short `setTimeout` loop (not `requestAnimationFrame`, which is skipped for backgrounded tabs) until the iframe-backed frames have real layout geometry. The current zoom is preserved; only the pan changes. Breakpoint switches within the same document (toolbar, node clicks) do not re-center — the designer keeps their place. See [docs/features/editor-preferences.md](editor-preferences.md) for how the `defaultBreakpoint` preference plugs into this.

### Viewport Activation UX

When a layer is selected **and** the Properties panel is open (`rightSidebarExpanded`), the design canvas enters a focused editing context that affects three behaviors:

**Inactive frame dimming.** Non-active viewport frames are dimmed to 0.42 opacity via the `frameWrapperDimmed` CSS class, controlled by the `dimInactiveBreakpoints` user preference (Canvas category in Settings → Preferences). This visually focuses the author on the viewport context they're styling. The preference is on by default.

**Cursor-following activation tooltip.** Moving the cursor over an inactive frame shows a `CursorTooltip` reading "Click to activate [Viewport] viewport". The cursor coordinate is bridged from inside the iframe to the parent document by `useIframeCursorBridge`, which attaches a native `mousemove` listener inside the iframe document and forwards `MouseEvent` objects to the parent callback. `BreakpointFrame` calls `clientPointToEditorDoc` to convert these events into editor-document coordinates that the `CursorTooltip` can position against.

**Selection preservation on click.** Clicking a node on an inactive frame while a layer is already selected activates the new viewport context (updates `activeBreakpointId`) but preserves the current selection instead of switching to the clicked node. Focus shifts to `'canvas'` so the Properties panel continues editing the same layer. This lets the author switch viewport contexts without losing their place in the Properties panel. Clicking a node on an inactive frame when the Properties panel is collapsed (or nothing is selected) behaves normally — it activates the viewport context and selects the clicked node.

---

## Live mode

Source: `src/admin/pages/site/canvas/CanvasLiveSurface.tsx`

`CanvasRoot` renders `CanvasLiveSurface` when `canvasView === 'live'`. It shows one `IframeFrameSurface` in `interaction='live'` mode:

- **Fluid + presets.** The frame fills available width by default. Selecting a narrower viewport context in the toggle clamps the frame to `min(breakpoint.width, containerWidth)`.
- **Side handle resizing.** Left and right `LiveResizeHandle` divs let the author drag the frame width continuously between 240 px and the selected viewport context's natural width. Switching viewport contexts invalidates any active override — the frame snaps to the new context width automatically.
- **Width badge.** A small `{N}px` indicator updates live while dragging.

Pan/zoom gestures are disabled in live mode (`useCanvas({ enabled: !isLive })`). The `CanvasModeToggle` shows an inline viewport icon row when live is active.

Because the live frame sits flush against the top of the surface, both top-edge chrome controls — the `CanvasModeToggle` (top-left) and the `CanvasNotch` (top-center) — render in **peek** mode in live view. Each parks above the top edge (clipped by the canvas's `overflow:hidden`) and rolls down on hover or `:focus-within`, leaving a slim handle as the affordance, so neither overlays the page's own header. In design mode both stay pinned over the empty canvas chrome. The peek prop is passed as `peek={isLive}` from `CanvasRoot`.

---

## CSS injection into iframes

Five `<style>` elements are injected per iframe (three from `ClassStyleInjector`, one each from the other two injectors):

| Injector | `id` attribute | Cascade layer | Purpose |
|---|---|---|---|
| `EditorChromeInjector` | `instatic-editor-chrome` | **unlayered** | Editor chrome: placeholder, slot-instance, unknown-module styles. Copies design tokens (`--editor-*`) from parent `:root` onto iframe `:root`. The editor UI font is forwarded as a **chrome-namespaced** `--editor-chrome-font-sans` (NOT `--font-sans`): because the injector is unlayered it would otherwise clobber the site's own `--font-sans` and render all canvas content in the editor font. |
| `ClassStyleInjector` | `mc-classes` | `@layer user-authored` | Publisher reset + framework CSS + class registry CSS |
| `ClassStyleInjector` | `mc-classes-preview` | `@layer user-authored` | Higher-specificity preview rule (doubled selector) while a property control is hovered. Empty for state-pseudo rules — those use `mc-classes-force-state` instead. |
| `ClassStyleInjector` | `mc-classes-force-state` | `@layer user-authored` | Force-paints the active state-pseudo rule (`.btn:hover`, `.card:focus`, etc.) onto the selected node via a doubled `[data-node-id]` selector so the state is visible/editable without physically triggering it. Mirrors the full `contextStyles` emission per breakpoint and condition. |
| `UserStylesheetInjector` | `mc-user-styles` | `@layer user-authored` | User-uploaded stylesheets (verbatim, unscoped) |

Unlayered rules always beat `@layer`-d rules regardless of specificity. User CSS can never override editor chrome even with a high-specificity selector.

`mc-classes-preview` and `mc-classes-force-state` share the same `@layer user-authored` as `mc-classes`. Their doubled selectors (`.foo.foo` for the preview, `[data-node-id="…"][data-node-id="…"]` for the forced state) raise specificity above the base class rule without leaving the layer — same-layer higher specificity wins, keeping the user cascade intact.

`EditorChromeInjector` uses **stable `data-*` attribute selectors** (`data-canvas-module-placeholder`, `data-instatic-slot-instance`, etc.) — not hashed CSS Module class names which only exist in the parent document.

---

## Runtime scripts ("Run scripts" toggle)

Source: `useRuntimeScriptBuild.ts`, `RuntimeScriptInjector.tsx`

When the "Run scripts" toggle (`runScripts` in `canvasSlice`) is on, `CanvasRoot` calls `useRuntimeScriptBuild` to build the site's runtime script files and inject them into every editable iframe. Module scripts are bundled; classic imported scripts are passed through as browser-global scripts. The result is shared across all frames (design and live) so it isn't rebuilt per frame.

Rebuild triggers: script file content changes, `packageJson` changes, `site.runtime` changes, or a manual Refresh. Node-tree edits do NOT trigger a rebuild — the bundle signature keys on script inputs only, not the page tree.

`RuntimeScriptInjector` appends `<script>` elements imperatively (not via JSX) because browsers don't execute React-inserted `<script>` tags. Module entries get `type="module"`; classic entries stay plain `<script>`. Old `<script>` elements are removed before new ones are appended; removing them doesn't undo their side effects (registered listeners, injected DOM) — that's why the Refresh button re-runs them.

---

## Event handling across the iframe boundary

React synthetic events bubble through the React fiber tree, not the DOM tree, so click/hover/keyboard handlers in `NodeRenderer` (and the canvas-root `onKeyDown` they bubble up to — delete / duplicate / clipboard / Escape) fire normally even though the DOM is inside an iframe. **Native** listeners on the parent `window` / `document` do not get that treatment — events fired inside an iframe never reach them — so they need explicit bridging (see keyboard events below).

Native events require explicit handling for four cases:

- **Wheel events (design mode):** `IframeFrameSurface` listens for `wheel` inside the iframe document and re-dispatches a new `WheelEvent` on the iframe element (parent document) so `useCanvas`'s pan/zoom handler picks it up.
- **Pointer events (design mode):** Middle-click pan, space+left-click pan, and active reorder drags (`data-instatic-canvas-dragging` on `<html>`) all need to cross the iframe boundary. `IframeFrameSurface` tracks `spaceHeld` and `panPointerId` state to identify when a pointerdown starts a pan, then forwards `pointerdown`/`pointermove`/`pointerup`/`pointercancel` to the parent document.
- **Keyboard shortcuts (design mode):** Clicking a node to select it focuses the iframe, so subsequent keystrokes are delivered to the iframe document. The editor's global / editor / panel shortcuts are native listeners on the parent `window` (spotlight `⌘K`, save `⌘S`) and parent `document` (panel toggles, undo/redo), which never see iframe events. `IframeFrameSurface` re-dispatches a cloned `keydown` on the **parent `document`** (not the iframe element) so it reaches those window/document listeners without re-entering React's root container — which would otherwise double-fire the canvas-root `onKeyDown` shortcuts that already receive the original via fiber bubbling. `Tab` is the exception: it is blocked (not forwarded) to keep the browser from tab-walking focusable nodes inside the design preview.
- **Portal overlay dismiss (all modes):** Portal-based overlays (context menus, dropdowns) attach their dismiss-on-outside-click listeners at the document level. A `mousedown` inside an iframe fires on the iframe's own document and never bubbles to the parent's listener, leaving the overlay stuck open. `ContextMenu` calls `collectSameOriginDocuments` (`src/ui/lib/sameOriginDocuments.ts`) to gather the parent document plus every reachable same-origin iframe document, then attaches dismiss listeners to all of them. Cross-origin iframes are skipped — their events are unreachable. The check for whether an event target is a valid DOM node uses `isNode` (also in `sameOriginDocuments.ts`), a structural check on `nodeType` that works across iframe realms where `instanceof Node` would fail.

Native mouse movement is also surfaced for editor chrome that must follow the cursor in the parent document, such as inactive-viewport activation hints. These events are not forwarded as new DOM events; `IframeFrameSurface` invokes callback props with the iframe-native `MouseEvent`, and callers translate the point with `clientPointToEditorDoc`.

Live frames skip wheel/pointer/keyboard forwarding — they scroll natively, have no pan/zoom, and host real interactive controls (forms, links) that must keep their own keystrokes. Overlay dismiss listeners still apply in live mode (menus can be open while the canvas is in live view).

---

## Inline text editing (in-place `contentEditable`)

Double-click a text-bearing node to edit its text **in place**: the node's own element becomes the editor. There is no overlay and no parent-document field — `NodeRenderer` hands the module an `InlineEditBinding`, and the module spreads `inlineEditableElementProps(binding)` onto its real root element, making it `contentEditable="plaintext-only"`. Because the author edits the actual published element inside the breakpoint iframe, the editing surface is byte-identical to what publishes — 100% fidelity, with no typography mirroring, no font injection, and no doubled/hidden text to reconcile. (This superseded the earlier parent-document `<textarea>`/`<input>` overlay, which had to mirror computed typography and inject site fonts into the parent doc just to approximate the real element.)

- **Module contract:** `ModuleDefinition.inlineTextEdit?: { prop: string; multiline?: boolean }`. Declared by `base.text` (`text`, multiline), `base.button` (`label`), and `base.link` (`text`). Modules without the field keep the no-op double-click; the canvas has no per-module branches. A node with children never starts a session (`base.link` renders `text` only when childless), and dynamically-bound props are not literal-editable.
- **The element IS the editor, and React must NOT own its content:** when `inlineEdit` is set on the component props, the module renders NO children and spreads `inlineEditableElementProps(inlineEdit)` (`src/modules/base/shared/inlineText.ts`) onto its element — `contentEditable="plaintext-only"` (no rich formatting / pasted markup) plus the three live-edit handlers, and crucially **no `dangerouslySetInnerHTML` and no children**. React 19 re-applies `dangerouslySetInnerHTML` on *every* commit of an element (it does not skip an unchanged `__html`), and the live-commit re-render fires one commit per keystroke — so a React-owned content prop would overwrite the user's typing and collapse the caret to the start every keystroke. Instead the canvas seeds the element's content **imperatively** once via `seedInlineEditableContent(el, initialValue)` (which sets `el.innerHTML = rawTextToBreakHtml(initialValue)` — HTML-escaped first, so the only markup is the `<br>`s, never user HTML), and React leaves the contentEditable DOM untouched for the rest of the session.
- **Session state:** `activeInlineEdit { nodeId, prop, breakpointId, multiline, initialValue, committed }` in `store/slices/inlineEditSlice.ts`. One session globally, owned by the frame that was double-clicked (`isInlineEditing` is true only when `activeInlineEdit.breakpointId === breakpointId`). Design mode only. On session start a `useLayoutEffect` in `NodeRenderer` seeds the content, focuses the element, and drops the caret at the end before paint.
- **Live commit:** `onInput` reads the edited text back with `readInlineEditableText(el)` (`el.innerText`, which resolves `<br>` and block boundaries to `\n`) and calls `applyInlineEditValue` → `updateNodeProps(nodeId, { [prop]: value })`. Single-field patches coalesce under `props:<nodeId>:<prop>`, so the whole burst is ONE undo entry and every OTHER frame previews the edit live. `startInlineEdit`/`endInlineEdit` reset `_historyCoalesceKey` so the session burst never folds into a Properties-panel burst for the same prop.
- **Line breaks stored as `\n`, rendered as `<br>`:** the stored value keeps newlines as `\n`. Both render surfaces turn each `\n` into a `<br>` so a hard break shows live in the canvas AND survives publish — `base.text` render emits `textToBreakHtml(text)` (text is pre-escaped by `escapeProps`; DOMPurify's richtext config allows `<br>`), and the canvas display path uses `rawTextToBreakHtml`. A break the author types is a break everywhere.
- **End:** for single-line modules (`base.button`, `base.link`) plain Enter commits + closes; for multiline `base.text`, plain Enter falls through so the browser inserts a hard break (stored as `\n`), and Cmd/Ctrl+Enter commits + closes. Blur commits + closes. Escape cancels: a single `undo()` iff the session committed anything.
- **Force-close:** node deleted, document/page switch, or frame unmount (breakpoint collapsed, live-mode switch) clear `activeInlineEdit` through the slice's existing guards.

Keyboard interplay: the editable element lives inside the breakpoint iframe, and its keystrokes reach the parent two ways — they bubble through React to the canvas-root handler, and `IframeFrameSurface` re-dispatches a clone on the parent `document` so native parent shortcuts work. Both paths must stand down mid-edit:

- **React path:** `useCanvasKeyboardShortcuts` bails at the top (`if (useEditorStore.getState().activeInlineEdit) return`), so Delete/Cmd+D/clipboard shortcuts never fire.
- **Forwarded path:** `IframeFrameSurface`'s `onKeyDown` returns early during a session (same guard) and never forwards the clone. This is the source fix for every native `document`/`window` listener at once — the forwarded clone's `target` is the `document`, not the cross-realm editing element, so each handler's own `target.isContentEditable` guard can't see it. Without this the spacebar would start a pan (eaten), and — the real hazard — **Cmd+Z** would run the store `undo()` (reverting the whole coalesced session) while the contentEditable DOM keeps the text, diverging store from DOM. Standing the forward layer down lets the spacebar type and Cmd+Z be the element's own native text undo.

The element's own React `onKeyDown` owns Escape (cancel) and Enter (commit / break).

Design doc: `docs/superpowers/specs/2026-06-10-inline-text-editing-design.md`.

---

## Plugin module sandboxing (`ModuleSandboxFrame`)

Plugin canvas modules render inside `ModuleSandboxFrame.tsx`, a separate component that is NOT `IframeFrameSurface`. Plugin modules run in a `sandbox="allow-scripts"` iframe with no `allow-same-origin` — they communicate with the host via `postMessage`. This is distinct from the page tree iframes described above.

---

## Known limitations

### Test environment — iframe globals

`src/__tests__/setup.ts` patches `HTMLIFrameElement.prototype.contentDocument` so each iframe's `contentWindow` gets the same built-in constructors (`SyntaxError`, `Element`, etc.) as the parent. Without this, `querySelectorAll` inside the iframe would crash in happy-dom with "undefined is not a constructor". This is a test-env-only workaround — real browsers provide these natively.

### Canvas tests must use `iframeCanvasQuery`

Tests that render the canvas and query nodes must use the `iframeCanvasQuery.ts` helper. `document.querySelector('[data-node-id="..."]')` returns null because the node lives inside an iframe.

---

## Related

- `docs/editor.md` — canvas architecture overview and the design/live mode toggle
- `docs/reference/ui-primitives.md` — `ContextMenu` dismiss model (cross-realm iframe attach)
- `docs/features/canvas-iframe-per-frame.md` — this file
- Source-of-truth files:
  - `src/admin/pages/site/canvas/IframeFrameSurface.tsx` — iframe primitive
  - `src/admin/pages/site/canvas/CanvasLiveSurface.tsx` — live mode surface
  - `src/admin/pages/site/canvas/BreakpointFrame.tsx` — design mode per-viewport frame
  - `src/admin/pages/site/canvas/CanvasTransformLayer.tsx` — design mode pan/zoom container; renders all frames once the document loads, skeleton frames while it hasn't
  - `src/admin/shared/CanvasFrameSkeleton/CanvasFrameSkeleton.tsx` — shared frame skeleton for the document-loading / startup states
  - `src/admin/pages/site/canvas/useIframeCursorBridge.ts` — surfaces iframe cursor movement to parent-doc callbacks
  - `src/admin/pages/site/canvas/EditorChromeInjector.tsx` — unlayered chrome CSS
  - `src/admin/pages/site/canvas/ClassStyleInjector.tsx` — class registry CSS
  - `src/admin/pages/site/canvas/UserStylesheetInjector.tsx` — user stylesheet CSS
  - `src/admin/pages/site/canvas/RuntimeScriptInjector.tsx` — opt-in runtime scripts
  - `src/admin/pages/site/canvas/useRuntimeScriptBuild.ts` — script bundle builder
  - `src/admin/pages/site/store/slices/canvasSlice.ts` — `canvasView`, `runScripts`
  - `src/ui/lib/sameOriginDocuments.ts` — `collectSameOriginDocuments`, `isNode` (cross-realm overlay dismiss)
  - `src/admin/pages/site/canvas/canvasDomGeometry.ts` — cross-iframe measurement + `panToCenterBreakpointFrame` centering geometry
  - `src/admin/pages/site/hooks/useCanvas.ts` — pan/zoom gesture hook; `centerOnBreakpointFrame`
  - `src/__tests__/canvas/canvasMode.test.tsx` — design/live toggle + script build contract
  - `src/__tests__/canvas/panToCenterBreakpointFrame.test.ts` — centering geometry unit tests
  - `src/__tests__/canvas/canvasFrameMounting.test.tsx` — frame-mount contract: all frames mount once the document is in the store (no staggering, robust to a suspended `requestAnimationFrame`); skeleton frames render while no document is loaded; design mode hides root iframe overflow, live mode leaves it scrollable
- Gate tests:
  - `src/__tests__/architecture/site-editor-shell-lazy-body.test.ts` — skeleton usage and lazy-boundary gates
