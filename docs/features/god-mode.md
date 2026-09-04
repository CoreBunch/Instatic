# God Mode

A per-user editor mode for the Site editor: the docked right properties sidebar is
hidden and a **Code Dock** — three code panels, **HTML | CSS | JS** — docks at the
bottom of the editor. The mode gives structure editors direct code control over the
page while the page tree stays the single source of truth.

Current status: the **shell** (toggle, dock layout, persistence), the
**editable HTML projection render** (`RenderConfig.projection`, see
[`publisher.md`](publisher.md) → "Editable HTML projection"), the
**uid-preserving HTML import** (`importProjectionHtml`, see
[`html-import.md`](html-import.md) → "Uid-preserving projection import"), and
all three panels — **HTML**, **CSS**, **JS** (below) — are implemented,
including the HTML panel's apply guardrails (destructive-diff confirm,
stale-draft banner), the panels' context-aware autocomplete, and the HTML
panel's reverse selection sync (inspector). Everything in the spec is
implemented.

## Enabling and entering

Two gates, both required:

1. **Capability** — the user must pass `canEditStructure` (`src/admin/access.ts`):
   God Mode's HTML panel will bypass per-module guardrails, so only structure
   editors may use it. Users without the capability never see the preference, the
   toolbar button, or the shortcut.
2. **Preference** — `godMode` in the editor-preference catalog
   (`src/admin/pages/site/preferences/catalog.ts`), off by default, rendered into
   Settings → Preferences. Per-browser, like every catalog preference. The
   catalog's `gate: 'structure-edit'` field is what hides it from ineligible
   users (`PreferencesSection` filters on it).

With both gates passed, the mode is **unlocked** (`useGodModeUnlocked`,
`src/admin/pages/site/hooks/useGodModeUnlocked.ts`) and can be toggled:

- Toolbar: `GodModeToggleButton` (`src/admin/pages/site/toolbar/`), a pressed-state
  ghost button in the site editor's right toolbar slot.
- Keyboard: **⌘⇧G** / Ctrl+Shift+G — spotlight command `godMode.toggle`
  (`src/admin/spotlight/commands/godMode.ts`) + keybinding, also runnable from ⌘K.

The active flag (`godModeActive`) is plain layout state in the editor store's
`codeDockSlice` (`src/admin/pages/site/store/slices/codeDockSlice.ts`) —
persisted per workspace, restored on reload. If a persisted flag
outlives the entitlement (preference turned off, capability revoked), an effect in
`AdminCanvasEditorBody` clears it so the properties sidebar returns.

## What the mode changes

- **Right sidebar hidden** — `selectRightSidebarExpanded`
  (`src/admin/pages/site/store/store.ts`) returns false while `godModeActive`.
  Only the *docked* sidebar is suppressed: the Properties panel can still be
  opened as a **floating window** (the Code Dock header's "Properties" button
  switches `propertiesPanelMode` to floating), because module-specific controls
  (image pickers, form settings, loop source pickers) have no code
  representation.
- **Code Dock shown** — `CodeDock` (`src/admin/pages/site/code-dock/`), mounted
  lazily by `AdminCanvasEditorBody` below the editor row, spanning the full
  shell width.

## Code Dock layout

- **Columns** — HTML | CSS | JS side by side. The header's toggle group (a
  check mark on each shown panel) hides and shows columns; the visible
  dividers between columns (a 1px line in a 7px grab area, highlighted while
  dragging) drag to redistribute width — the flex weights size each column
  GROUP (divider + panel), and the panel fills its group. A column can never
  be dragged out of existence: `MIN_COLUMN_WIDTH` (280px) is the drag floor,
  the group's CSS `min-width` (`--code-dock-column-min`), and the tab-fallback
  threshold; stored weights are floored (`CODE_DOCK_MIN_COLUMN_WEIGHT`, also
  at restore) and a column shown again returns at an equal share. The top
  edge drags to resize the dock height (clamped
  `CODE_DOCK_MIN_HEIGHT`–`CODE_DOCK_MAX_HEIGHT`). Both resize gestures write CSS
  custom properties imperatively during the drag and commit to the store once on
  pointer-up, so the layout-persistence subscriber writes localStorage once per
  gesture. Keyboard: the handles are focusable `role="separator"` elements;
  arrow keys resize in discrete steps.
- **Tabbed fallback** — a ResizeObserver on the dock watches its width; when the
  visible columns can't all fit at their minimum width the dock switches to one
  editor with HTML/CSS/JS tabs (`codeDockActiveTab`), and back automatically.
- **Persistence** — `godModeActive`, `codeDockHeight`, `codeDockPanels`,
  `codeDockActiveTab`, and `codeDockColumnWeights` are projected into the
  per-workspace layout storage (`siteEditorLayoutPersistence.ts` →
  `workspaceLayoutStorage.ts`, localStorage key `instatic-editor-layout-v2`) and
  restored (validated, clamped) at store hydration.
- **Expand** — each column title carries an expand button that opens that
  panel in a full-size `Dialog` (`size="full"`: the viewport minus a margin)
  for a bigger editing area. While expanded the panel renders only in the
  dialog and its column shows a placeholder; closing the dialog returns it.
  The move remounts the panel, which is why the panels' unapplied buffers
  live in the store — `codeDockDrafts` on the dock slice
  (`store/slices/codeDockDrafts.ts`, keyed by document, bounded to 20, not
  persisted): the HTML panel's held / stale / unparsable drafts and a CSS
  buffer that does not parse yet are restored on remount; the JS panel and a
  parsing CSS buffer flush on unmount, so nothing is lost either way. Local
  dock state, not persisted.
- **Bundle** — the dock is behind a `React.lazy` boundary; nothing God-Mode-
  specific loads until the mode is activated. The CodeMirror panels stay
  behind the same boundary, and Prettier (the Format action) behind another,
  loaded the first time a document is formatted.

## HTML panel

The HTML column (`src/admin/pages/site/code-dock/html/`) is the editable
projection of the current selection, applied back to the tree as you type.

- **Read side** — `deriveHtmlPanelDocument` (`htmlPanelDocument.ts`) renders
  the scoped subtree with the publisher's projection mode
  (`RenderConfig.projection`, see [`publisher.md`](publisher.md) → "Editable
  HTML projection"): every element carries `uid`, dynamic tokens stay
  verbatim, and loops / Component refs / slots render as `instatic-*`
  markers — reflowed for reading by `prettyPrintProjection`
  (`html/prettyProjection.ts`: element-only children on indented lines,
  text content kept inline, nothing touched inside `pre` / `textarea` /
  `script` / `style`; safe because the importer ignores whitespace between
  element children and collapses it inside text leaves). Scope: an element
  selected in the active tree → that subtree;
  nothing selected → the whole active document (the page, or the Component
  **definition** in VC canvas mode, both fully editable, slot outlets
  visible); a node selected **inside a Component instance** on the consumer
  side (the canvas renders definition internals, so their ids are
  selectable while a page is active) → that subtree from the definition,
  **read-only**, with an "Open component definition" button that switches
  the active document to the Component.
- **Write side** — edits apply **live**: every debounced change (300 ms,
  `HTML_PANEL_APPLY_DELAY_MS`, one flush = one tree-undo step) that parses
  runs `importProjectionHtml` against the projected tree and, when the
  result is harmless, `applyProjectionImport` (site slice,
  `site/projectionApplyActions.ts`) at once, which writes the import's diff
  and nothing else in ONE `mutateActiveTreeAndSite` recipe: patched uids are
  replaced under their ids with metadata kept, new tags become nodes,
  vanished uids are deleted and pruned from the canvas selection, every
  other node of the subtree stays the same object, and parents are re-linked
  around the written nodes only; class names link to registry classes
  exactly as the lossy import does; canvas and layer panel repaint from the
  store. The scope matters: each reassigned node is a whole-node rewrite in
  the collab doc that the undo manager pins against garbage collection, so
  rewriting the subtree per keystroke retained the whole tree per apply on
  a large page until the renderer ran out of memory. The buffer is then brought up to the fresh
  projection **in place** (`CodeMirrorEditor`'s `syncValue`: the minimal
  line edits from `code-editor/documentDiff.ts`, so the caret, history and
  folds survive) — a typed `<p>` gains its `uid`, and the text settles into
  the canonical reflow. Nothing touches the tree while the document has
  syntax errors (`lintSyntax` diagnostics inline, count in the toolbar), and
  never in the read-only view. A change the guardrails below hold is
  applied through the explicit **Apply** button or **⌘↩** (the editor's
  `onSubmit`) with a confirm dialog; the status names what is held.
- **uid marks** — the projection's `uid="…"` attributes are for the import,
  not the author, so the editor shows each one as a clickable Instatic mark
  instead of text (`CodeMirrorEditor`'s `foldUidAttributes`,
  `code-editor/uidAttributes.tsx`): click reveals that uid inline, click
  again hides it. The text stays in the buffer untouched — the apply path
  still reads it — and a hidden attribute is an atomic range, so the caret
  steps over it and a backspace removes it whole.
- **Drafts** — unapplied edits (held by a guardrail, stale, or not parsing)
  are kept per scope in the store (`codeDockDrafts`, keyed by the projected
  document, bounded to the 20 most recent), so changing selection, expanding
  the panel, or the tab fallback never discards them and coming back restores
  them; the toolbar shows why the draft is held and the last apply result
  ("Applied · 2 patched · 1 created").
- **Sync** — a clean scope re-syncs its buffer on external tree changes
  (canvas undo, a co-editor) through the shared `useDocumentSync`, with no
  banner; a dirty scope keeps its draft verbatim and its buffer mounted
  (`holdRemounts`), so caret and text history survive every store change —
  including the remote ones the stale banner reports. Projections are
  expensive on a large page, so `useDocumentSync` coalesces its reads to one
  per animation frame against the latest state, and the panels derive from
  `useDeferredValue`d inputs: a burst of hundreds of store changes in one
  task (a collab document loading node by node, an agent batch) costs one
  projection, not one per change. Re-projecting per notification allocated a
  whole document per node and exhausted the renderer on a real site.
- **Guardrails** — two, and every other change applies live. Each draft
  records the projection it started from (`baseHtml`), so both are *derived*
  from state rather than tracked by subscriptions:
  - **Stale draft.** A dirty scope whose current projection differs from
    the draft's baseline — a co-editor, an MCP agent, or a canvas undo
    changed the projected subtree — shows a "Content changed remotely"
    banner (`html-panel-stale`), keeps the draft and buffer untouched, and
    turns Apply into overwrite-with-confirm. The only exits are explicit:
    confirm the overwrite (the draft is re-imported against the tree as it
    is at confirm time and wins), or **Discard draft**, which drops the draft
    and re-keys the buffer to the remote projection. Undoing a tree change
    under a dirty panel takes the same path: drafts are never silently
    discarded or silently applied over remote work.
  - **Destructive diff.** Before committing, `summarizeDestructiveApply`
    (`html/applyGuardrails.ts`) turns the import diff's `deletedLockedIds`,
    `deletedStructuralIds`, and `retypedStructuralIds` into a list of
    top-level removals — locked nodes, Component instances, slots, slot
    outlets — named as the layer panel names them, with removed descendants
    folded into their ancestor (deleting one Component instance reads as one
    line, not one per slot). A non-empty list opens the confirm; cancel
    leaves the tree and the draft untouched.
  - Both concerns share one dialog, `HtmlApplyConfirmDialog` (built on the
    `Dialog` primitive, `tone="danger"`): the stale paragraph, the removal
    list, or both, with a single confirm button. Confirming **re-validates**:
    the draft is re-imported against the tree as it is then, and if what the
    apply would do no longer matches the summary the user read (the tree
    moved while the dialog was open) the dialog shows the new summary instead
    of committing. A re-validation that finds nothing left to confirm
    commits directly.
  - **Orphaned draft.** When the element a draft is scoped to is removed
    (remotely, or by a canvas undo), the selection is pruned and the panel
    moves on to the new scope — but the draft can never be applied. Rather
    than vanish, it is named in a banner (`html-panel-orphaned`) with
    **Copy draft** (clipboard) and **Dismiss**; each draft records its
    `rootId` and scope name for this.

## CSS panel

The CSS column (`src/admin/pages/site/code-dock/css/`) is a two-way editor
over the style-rule registry — a projection, never a second store. The engine
is `@core/cssProjection` (`src/core/cssProjection/`), pure and DOM-free:

- **`projectStylesheet`** renders an ordered list of blocks into one annotated
  stylesheet text. Rules go through `createStyleRuleCssEmitter` — the same
  emitter the publisher and canvas use — so `@media`/`@container`/`@supports`
  folding, `!important` and property sanitisation cannot drift from a publish.
  Every block is prefixed by an origin comment (`/* .card · class · used by 3
  elements */`, `/* h1 · ambient rule · matches 2 elements on this page */`,
  `/* .text-m · framework utility · read-only · used by 12 elements */`,
  `/* element · inline styles · this element only */`) and its character
  range is reported so the editor can lock and fold framework blocks. A rule
  with no declarations still emits `.card {\n}` so it stays editable.
- **`planStylesheetEdit`** parses edited text with `cssToStyleRules`
  (breakpoint-aware `@media` folding, custom conditions preserved) and diffs
  it against the projection it came from: parsed rules are exact-selector
  upserts with **replace** semantics; a projected **class** block that
  vanished is *cleared* (declarations go, the class and its `class=`
  assignments stay — the CSS panel edits CSS, never assignments); a vanished
  **ambient** block is *deleted*; the reserved `element { … }` block becomes
  the node's `inlineStyles` (base-only — any `@media` on it is dropped with a
  warning); a rule addressed at a locked framework block is reported as
  blocked and never applied.

**Scope** (`cssPanelDocument.ts` → `deriveCssPanelDocument`): with an element
selected, the sheet holds its assigned class rules (assignment order), the
ambient rules matching it — via the Properties panel's own selector model
(`deriveSelectorPickerModel` pills, editor-attribute-stripped canvas clone), so
pills and panel never disagree — its inline styles as the `element` block,
and the framework utilities it wears, last. With nothing selected it holds
every rule the page uses: classes assigned anywhere in the active tree plus
ambient rules matching any rendered element. Class usage counts assignments
site-wide (`buildSelectorUsageMap`, pages **and** Visual Component trees);
ambient usage counts matches on the current page. In Visual Component canvas
mode the active tree is the definition tree.

**Write path** — `applyStylesheetEdit` on the style-rule slice
(`styleRule/stylesheetEditActions.ts`) applies one plan atomically in a single
`mutateSiteState` recipe: upserts (`rulePayload.ts` → `upsertRulesIntoSite`,
shared with the agent/MCP `applyCssRules`), cleared class blocks, deleted
ambient blocks, and the projected node's inline styles (page or active VC
tree). One debounced flush (300 ms, `CSS_PANEL_APPLY_DELAY_MS`) is therefore
exactly one tree-undo step; consecutive flushes are separate steps. The
canvas repaints from the registry as you type. **Editing a shared class edits
it site-wide by design** — the "used by N elements" annotation is the safety
rail; there is no silent forking. A new selector typed in the panel creates a
real class or ambient rule; a new `.class` is **not** auto-assigned to the
selection (assignment stays explicit — the HTML panel's `class` attribute).

**Editor** — `CodeMirrorEditor` gained two opt-in props for this panel:
`lockedRanges` (`code-editor/lockedRegions.ts`: read-only ranges that follow
edits above them, folded on mount, `.cm-lockedLine` styling) and `lintSyntax`
(`code-editor/syntaxDiagnostics.ts`: lezer parse errors as inline lint
markers, with the error count passed to `onChange`). The panel holds applies
back while the document has syntax errors — the CSS parser silently swallows
everything after a missing brace, and a live "replace" apply would otherwise
read that as deletions. The theme moved to `code-editor/codeMirrorTheme.ts`;
the `codemirror-lazy-only` gate now allowlists the lazy chunk's helper modules
and pins that nothing outside the chunk imports them. Typing `;` after a bare
`--name` value writes `prop: var(--name);` (`code-editor/cssVarShorthand.ts`,
an input handler installed for CSS documents).

**Sync** — the editor is remounted only when the projected text changes for a
reason other than the panel's own apply (selection change, canvas Cmd+Z, a
co-editor's edit): the panel remembers the projection text its last apply
produced and re-keys the editor when the store projects something else. Undo
with focus in the panel is CodeMirror's text history; undo in the canvas or
layer panel is tree undo, which re-syncs the panel.

## JS panel

The JS column (`src/admin/pages/site/code-dock/js/`) edits the **page
script**: an ordinary script code asset scoped to exactly the current page.
Nothing else marks it — it is found by its runtime config
(`findPageScript` in `@core/site-runtime`: a `type: 'script'` file whose
scope is `{ type: 'pages', pageIds: [<this page>] }`; several qualify → the
one that loads first, ascending priority then path). It shows in the Explorer
Code tab like any script, its settings (scope, placement, timing, canvas) stay
editable there, and it rides the existing build/inject pipeline
(`collectRuntimeScripts`), so it runs in the canvas and on the published page
with no new publish path.

- **Lazy creation** — no asset exists until the first real edit. The first
  non-empty flush calls `createPageScript(pageId, content)` (file slice): one
  `mutateSiteState` recipe adds `scripts/pages/<slug>.js` (`pageScriptPath`,
  stepping past an occupied path with `-2`, `-3`, …) AND its page-only
  runtime config to both the persisted `site.runtime` and the store mirror
  (`writeSiteRuntimeDraft`, the one place every runtime writer goes
  through), so file + scope are one undo step and the Code tab settings
  agree at once.
- **Saves** — live-debounced (250 ms, `JS_PANEL_SAVE_DELAY_MS`) through
  `updateFileContent`, the same path the Code editor panel uses; the compiler
  diagnostics for the file (`fileRuntimeDiagnostics`, shared with that panel)
  show inline, threaded down as `runtimeValidation` from the canvas layout.
  Language follows the file's path (`fileLanguage`, shared with the Code
  editor panel); `.ts` page scripts get the TypeScript language service.
- **Scope** — follows the active page, never the element selection; in
  Visual Component canvas mode the panel shows an empty state (a VC has no
  page script).
- **Sync** — page switches re-key the buffer; the editor's flush-on-switch
  lands a pending edit on the page it was typed for. External content
  changes (undo, the Code editor panel, a co-editor) re-sync the buffer via
  the same `useDocumentSync` hook the CSS panel uses (`code-dock/
  useDocumentSync.ts`).

## Autocomplete

Each panel completes from what the editor knows, on top of — never instead
of — its language's own completions. The data is a **completion catalog**
(`code-editor/completionCatalog.ts`, a CodeMirror-free shape derived in the
eager graph by `code-dock/completions/` and handed to `CodeMirrorEditor` as
`completions`); the lazy chunk turns it into completion sources registered
as language data (`code-editor/contextCompletions.ts`), so lang-html /
lang-css / lang-javascript keep their defaults and CodeMirror merges the
lists. The catalog is read through a getter on every completion: a new class
or a late-loaded table schema takes effect without remounting the view. (The
TypeScript language-service path keeps its `override`, which ignores language
data — page scripts are `.js`, so the JS panel is never on that path.)

- **HTML** (`htmlContextCompletions.ts`, catalog from
  `deriveHtmlCompletionCatalog`):
  - the projection dialect's `instatic-*` marker tags next to the standard
    tags, and inside one its attributes (`PROJECTION_TAG_ATTRIBUTES`, the
    dialect vocabulary exported by `@core/publisher` next to
    `PROJECTION_TAGS`) plus known values — registered loop sources for
    `data-source-id`, tables for `data-table-id`, Visual Components for
    `data-component-id`, `asc`/`desc`, `infinite`;
  - class names inside a `class` attribute, one word at a time, framework
    utilities included (they are assignable) and labelled as such;
  - **dynamic tokens** after `{` in text or any attribute value, offered as
    whole `source.field` paths with the field's label: `page` / `site` /
    `route` always (`SYSTEM_SOURCES`, the binding picker's own list);
    `currentEntry` and `parentEntry` from the **entry stack** in scope —
    the catalog's outer frames (the template page's entry via
    `primaryTemplateTableSlug`, then the `base.loop` ancestors of the
    projected root, from the tree) followed by the `<instatic-loop>`
    elements enclosing the cursor, read from the document text so a loop
    typed a moment ago already completes its fields. The innermost frame is
    the current entry, the one below it the parent entry
    (`resolveEntryFields`). A loop's fields come from its **actual source
    schema**: a table-bound `data.rows` loop offers the table's fields
    (from the CMS data meta, loaded once through the binding picker's
    cache — `useDataMeta`) plus the loop source's synthetic metadata the
    table doesn't declare, with post-type-only fields hidden for data
    tables — the same rule the binding picker applies
    (`DataBindingPicker/entryFields.ts`, shared); any other source offers
    its declared `fields`. Outside every loop and template only the
    non-entry sources appear.
- **CSS** (`cssContextCompletions.ts`, catalog from
  `deriveCssCompletionCatalog`):
  - inside `var(…)` — from `var(` on, through a partial `-`/`--name` —
    **every custom property that exists on the published site**
    (`collectSiteCustomProperties` in `@core/cssProjection`): the
    framework-generated token variables (colors and their variants, type
    scale, spacing scale, via `describeFrameworkTokens`, so the list can
    never name a variable the `:root` block doesn't emit), then the
    properties authors declared in style rules (base and context styles,
    cascade order), then those declared in style code assets. Grouped by
    origin, with the value as detail and the declaring selector/file as
    info. The admin UI's own `--editor-*` tokens are not a source and never
    appear. Properties the current sheet itself declares are left to
    lang-css, which lists those already;
  - after `.` in a selector: the site's editable class names with their
    site-wide usage (framework utilities are locked in this panel, so they
    are not offered as selectors).
- **JS** (`jsContextCompletions.ts`, catalog from
  `deriveJsCompletionCatalog`): inside the string argument of a DOM lookup,
  the page's real class names (every class assigned in the active tree)
  and element ids (`htmlAttributes.id`), the **selected element's own
  first** ("Selected element" section, boosted): `.class` / `#id` tokens in
  `querySelector` / `querySelectorAll` / `closest` / `matches` (a bare `.`
  or `#` narrows to one kind), bare class names in `getElementsByClassName`
  and `classList.add/remove/toggle/contains/replace`, bare ids in
  `getElementById`. Selection changes update the catalog, never the
  document.

## Editor assists

Shared by the three panels, on top of the language defaults:

- **Format** — the toolbar's Format button, or **⇧⌥F** in the editor
  (`codeEditor.format` keybinding), runs Prettier over the buffer
  (`code-editor/formatDocument.ts`, through the editor's `format()` ref
  handle): the html / postcss / babel / typescript plugins are loaded on
  demand in their own chunks, the result is dispatched as one ordinary edit
  (so a live-applying panel sees it and it undoes as one step), and the
  caret lands where Prettier maps it. Scripts use the repo's own style (no
  semicolons, single quotes, 100 columns). A document that does not parse
  reports the parser's message through `onFormatError` — a toast. The HTML
  projection additionally arrives pre-reflowed (see the HTML panel) and
  settles back into that reflow after every live apply.
- **Tab accepts a completion** (Enter still does), via a `Prec.high` keymap.
- **No lint gutter** — the dock panels pass `lintGutter={false}`: the gutter
  column only ever showed one marker per line for diagnostics the panels
  already show inline (squiggle + hover message) and count in their status,
  so it was an empty third column most of the time. The Explorer Code editor
  keeps it (TypeScript errors are its main signal).
- **Breadcrumbs** (HTML panel) — the cursor element's ancestry, root first
  (`getAncestors` on the projected tree, layer-panel names), rendered under
  the toolbar; click any crumb to select that ancestor (re-scoping through
  the normal selection flow); the selected element's crumb is pressed.

## Reverse selection sync

The HTML panel is also an inspector: the projection's `uid` attributes map
the editor back onto the page tree (`code-editor/uidInspector.ts`, in the
lazy chunk; `CodeMirrorEditor` props `onCursorUid` / `onTagClick`).

- **Cursor → hover.** As the cursor moves, the editor reports the uid of the
  nearest enclosing element — open tag, text, or close tag (`uidAtCursor`) —
  and the panel calls `hoverNode(id)` for it when it is a node of the
  projected tree: the canvas shows its hover ring in every breakpoint frame
  (global hover, no breakpoint owner) and the layer panel highlights its row,
  exactly as a canvas mouse-over would. Only the nearest element counts: a
  tag typed but not applied (no uid), or a uid the tree does not know, maps
  to nothing — never to its parent. The highlight clears when the cursor
  leaves every element or the editor loses focus, and the panel drops a
  highlight it owns when it unmounts (leaving God Mode). Focus never moves.
- **Tag click → select.** A click on a tag name, open or close tag
  (`uidOfTagNameAt`, resolved from the pointer position on release; a click
  is a press and release without drag, detected from the mouse events
  because caret placement redraws the line and the browser then synthesises
  no `click`), calls
  `selectNode(uid)` — the same action a canvas click ends in — so the layer
  panel expands and scrolls to the row and both panels re-scope through the
  normal selection flow (drafts are kept per scope). The re-keyed buffer
  opens at the top of the selected node's projection. Clicking the tag of
  the node already selected is a no-op; a drag selection never selects.
- **Read-only view** (a Component instance's internals on the consumer
  side) is inert: no hover highlight, no selection from tag clicks — the
  way in is the "Open component definition" jump.

## Tests

- `src/__tests__/god-mode/godModeDockState.test.ts` — codeDockSlice state/actions,
  right-sidebar suppression, persistence projection/restore, catalog entry,
  spotlight command + keybinding.
- `src/__tests__/god-mode/codeDockTabFallback.test.tsx` — narrow-window tab
  fallback behavior (mocked ResizeObserver).
- `src/__tests__/publisher/projectionRender.test.ts` — the editable HTML
  projection dialect (tokens, uid/hidden, loop/component/slot/outlet markers,
  publish path unchanged).
- `src/__tests__/htmlImport/projectionImport.test.ts` — the uid-preserving
  import (round-trip identity, patch/create/delete/move semantics, partial
  loop-filters patching, destructive-deletion diff flags).
- `src/__tests__/settings/settingsSections.test.tsx` — capability-gated
  preference hidden for non-structure editors.
- `src/__tests__/cssProjection/projectStylesheet.test.ts` /
  `planStylesheetEdit.test.ts` — the CSS projection engine (annotations,
  `@media` round-trip, cleared vs deleted blocks, `element` block, locked
  framework selectors, new selectors).
- `src/__tests__/editor-store/stylesheetEdit.test.ts` — `applyStylesheetEdit`
  as one undo step, locked-rule refusal, no-op contract, VC-tree inline styles.
- `src/__tests__/god-mode/cssPanelDocument.test.ts` — selection vs page scope,
  usage counts, unrendered selection.
- `src/__tests__/god-mode/cssPanel.test.tsx` — the panel over real
  CodeMirror: live apply, canvas-undo re-sync, syntax gating, new selector
  without auto-assignment, selection swaps.
- `src/__tests__/code-editor/lockedRegions.test.tsx` — locked ranges reject
  edits, fold on mount, and syntax error counts ride along with changes.
- `src/__tests__/site-runtime/pageScript.test.ts` — page-script resolution
  (exact page scope, load-order tie-break, `scripts/pages/<slug>.js` naming).
- `src/__tests__/editor-store/pageScriptActions.test.ts` — `createPageScript`
  as one undo step; the script runs for its page only in canvas and publish.
- `src/__tests__/god-mode/jsPanel.test.tsx` — the panel over real
  CodeMirror: lazy creation on first edit, live saves, selection-independent,
  page switch with flushed pending edit, undo re-sync.
- `src/__tests__/editor-store/applyProjectionImport.test.ts` —
  `applyProjectionImport`: patch in place with identity/metadata kept,
  create/delete with selection pruning, page-root apply, one undo step.
- `src/__tests__/god-mode/htmlPanelDocument.test.ts` — scope derivation:
  selection, page, VC definition, read-only Component internals.
- `src/__tests__/god-mode/htmlPanel.test.tsx` — the panel over real
  CodeMirror: explicit apply as one undo step, syntax gating, per-scope
  drafts, read-only internals + jump to definition, token / `instatic-*`
  round trip.
- `src/__tests__/code-editor/editorSubmitReadOnly.test.tsx` — `onSubmit`
  (Mod-Enter after flush) and `readOnly`.
- `src/__tests__/cssProjection/customProperties.test.ts` —
  `collectSiteCustomProperties`: framework tokens, rule and asset
  declarations, first-declaration-wins, no editor tokens.
- `src/__tests__/god-mode/completionCatalog.test.ts` — the catalog
  derivations over the store: class lists, token sources, outer entry
  frames (template page, loop ancestors), `resolveEntryFields` (table +
  loop metadata, post-type filter, stacking), page classes/ids with the
  selection first.
- `src/__tests__/code-editor/contextCompletions.test.ts` — the three
  context sources over real language states: marker tags / attributes /
  values, class attributes, tokens with entry resolution from the text and
  the catalog, `var()` properties grouped by origin, selector classes,
  script selector strings — and the language defaults still answering
  alongside.
- `src/__tests__/god-mode/panelCompletions.test.tsx` — the panels over real
  CodeMirror, completing from the store (loaded data meta included).
- `src/__tests__/code-editor/uidInspector.test.tsx` — `uidAtCursor` /
  `uidOfTagNameAt` over the HTML grammar (open/close tag, text, uid-less,
  outside), and `onCursorUid` reports over a mounted editor.
- `src/__tests__/god-mode/htmlPanelInspector.test.tsx` — the panel hovers
  the cursor's node, ignores uid-less and unknown uids, re-scopes on select,
  shows and follows breadcrumbs, stays inert in the read-only view, and drops
  only its own hover on unmount.
- `src/__tests__/code-editor/documentDiff.test.ts` — minimal in-place line
  edits between two documents (multi-region, end-of-document, fallback).
- `src/__tests__/god-mode/prettyProjection.test.ts` — the projection reflow:
  element-only children indented, text inline, raw-text elements untouched,
  idempotent, no markup lost.
- `src/__tests__/code-editor/editorAssist.test.tsx` — Tab accepts a
  completion, `--name;` expands to `var(--name);`, bare `--` completions
  apply `var()`, `syncValue` patches in place without re-entering
  `onChange`, the lint gutter opt-out, Prettier formatting through the
  handle with the caret kept, unformattable documents reported.
- `src/__tests__/god-mode/codeDockDrafts.test.ts` — the bounded draft map
  and the slice action; `htmlPanel.test.tsx` / `cssPanel.test.tsx` cover a
  held HTML draft and an unparsable CSS buffer surviving a panel remount.
