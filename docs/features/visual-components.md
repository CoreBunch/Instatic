# Visual Components

Visual Components (VCs) — reusable subtrees with named parameters and named slots. A VC is authored once, instantiated on pages via a `base.visual-component-ref` node, and inlined by the publisher at render time.

A VC **is** a `NodeTree<VCNode>` (structurally identical to `NodeTree<BaseNode>`) plus a list of parameters. A VC consumed on a page is a `base.visual-component-ref` node whose children include one `base.slot-instance` per slot the VC declares. Slot content lives in the consumer page tree as ordinary nodes, not as a separate prop.

---

## TL;DR

- VCs are stored as rows in the `components` system table (`data_tables.kind = 'component'`).
- Type lives in `src/core/visualComponents/schemas.ts`. **`VCNode === BaseNode`** — no `dynamicBindings` (that's page-tree only).
- Parameters: typed (`string`, `number`, `boolean`, `url`, `enum`, `color`, `image`, `richText`, `slot`) with `defaultValue`, `required`, optional `enumOptions` and `description`.
- **Slots are `base.slot-outlet` nodes inside the VC tree.** The outlet IS the slot — no separate `vc.params` slot entry. Multiple outlets with the same `slotName` count as one slot.
- A consumer's `base.visual-component-ref` has one `base.slot-instance` child per declared slot, in param order, kept in sync by `syncSlotInstances(...)` (`slotSync.ts`).
- Cycles (VC A references VC B which references A) are blocked by `wouldCreateCycle(...)` before mutations apply.
- The publisher's `renderVisualComponentRef` (`src/core/publisher/renderVisualComponentRef.ts`) inlines the VC tree with prop-binding substitution.

---

## Data model

### `VisualComponent` (the source-of-truth schema)

`src/core/visualComponents/schemas.ts`:

```ts
export const VisualComponentSchema = Type.Object({
  id:          Type.String(),
  name:        Type.String(),
  description: Type.Optional(Type.String()),
  tree:        NodeTreeSchema,      // NodeTree<VCNode>
  params:      Type.Array(VCParamSchema),
  // ... metadata fields
})
export type VisualComponent = Static<typeof VisualComponentSchema>
```

Stored in `data_rows` (`table_id = 'components'`), serialized via `componentFromRow.ts` / `componentToRow.ts` in `src/core/data/`.

### `VCParam`

```ts
{
  id:           string         // nanoid; survives renames
  name:         string         // free-form, unique within the VC
  type:         VCParamType    // 'string' | 'number' | 'boolean' | 'url' | 'enum' | 'color' | 'image' | 'richText' | 'slot'
  description?: string
  defaultValue: unknown
  required:     boolean
  enumOptions?: string[]       // only meaningful when type === 'enum'
}
```

- The **`id` is stable** across renames; refs and bindings point at the `id`, not the `name`.
- Param **names** are validated at the slice boundary by `validateParamName` (`nameValidation.ts`).
- Param **types** include `'slot'` — but slot params are derived from `base.slot-outlet` nodes in the tree, not authored separately.

### `VCNode` (`= BaseNode`)

A VC tree node is structurally identical to a `BaseNode`. The only difference from `PageNode`: no `dynamicBindings` field (template data-binding is page-tree-only).

VC tree shape: `NodeTree<VCNode> = { nodes: Record<string, VCNode>, rootNodeId: string }` — same as any other tree. The stored root is a `base.body` structural anchor, but the Layers panel hides that wrapper while editing a VC and displays only the authored component content.

---

## Slots

The slot model is **the slot-outlet IS the slot**. There is no separate `params: [{ type: 'slot', name: 'header' }]` declaration. A VC author drops a `base.slot-outlet` node anywhere in the VC tree, sets its `slotName` prop, and that's the entire authoring step.

```text
VC definition tree:
  base.body
    base.container
      base.heading              "Header"
      base.slot-outlet          (slotName: 'header')
    base.container
      base.slot-outlet          (slotName: 'body')
    base.slot-outlet            (slotName: 'footer')

  → declares three slots: 'header', 'body', 'footer'
```

Multiple `base.slot-outlet` nodes with the same `slotName` render the same slot's content at multiple positions, but count as **one** slot for the consumer's `base.slot-instance`.

### Slot extraction order

`syncSlotInstances` walks the VC's tree in DFS pre-order. The first appearance of a `slotName` wins for ordering. The default `slotName` is `'children'` when the outlet's `props.slotName` is missing or empty.

### `base.slot-instance` on the consumer side

When a `base.visual-component-ref` is dropped onto a page, `syncSlotInstances` ensures the ref has exactly one `base.slot-instance` child per slot the VC declares, in param order. Each slot-instance carries:

- `slotName` prop — matches the outlet's `slotName`
- `locked: true` — the editor prevents moving / deleting it (only the user content **inside** is editable)
- Children — the user's content for that slot

```text
Consumer page tree:
  base.body
    base.container
      base.visual-component-ref     (refers to VC 'CardLayout')
        base.slot-instance          (slotName: 'header', locked)
          base.text "Welcome"
        base.slot-instance          (slotName: 'body', locked)
          base.image
          base.text
        base.slot-instance          (slotName: 'footer', locked)
          base.button "Sign up"
```

No `slotContent` prop. No separate tree. All slot fills are ordinary materialized children in the consumer page tree.

---

## `syncSlotInstances`

`src/core/visualComponents/slotSync.ts` — pure function that computes the ops needed to bring a VC ref's children into alignment with its referenced VC's slots.

```ts
syncSlotInstances(refNode, vc, allNodes) → SyncResult
applySlotSyncResult(nodesMap, result)
```

Three op kinds:

| Op            | When it fires                                                            |
|---------------|--------------------------------------------------------------------------|
| `InsertSlot`  | The VC declares a slot the ref doesn't have a slot-instance for yet      |
| `RenameSlot`  | The slot's `name` changed in the VC; the existing slot-instance's `slotName` prop updates |
| `DeleteSlot`  | The VC removed a slot; the matching slot-instance + its subtree are dropped |

Matching strategy: **name first, then positional fallback**. Phase 1 matches existing slot-instances to slots by `slotName` (exact match). Phase 2 pairs any remaining unmatched instances with unmatched slot names by position — this produces `rename` ops rather than delete+insert, so renaming a slot outlet in the VC carries the user's content with it instead of wiping it.

`applySlotSyncResult` is called inside Mutative recipes in `siteSlice` and `visualComponentsSlice` so the mutation participates in the editor's undo history. `allTreeNodeMaps(site)` (from `vcSlotReconcile.ts`) supplies both page node maps and every VC definition tree's node map, so a `base.visual-component-ref` nested inside another VC's tree is reconciled exactly like a ref on a page. The load-time validator (`validateVisualComponents` in `src/core/persistence/validate.ts`) runs the same sweep over all surviving VC trees to self-heal any stored drift.

When the ref is first inserted, slot-instances are seeded with the slot's default content from the VC's `slot-outlet.children` (if any). After that, edits inside slot-instances are owned by the consumer page.

---

## Inline preview rendering (`VCInlineTree`)

The editor canvas preview for a `base.visual-component-ref` node is rendered by `VisualComponentRefEditor` (`src/modules/base/visualComponentRef/VisualComponentRefEditor.tsx`), which calls `instantiateVCAtRef` and passes the resulting flat node map to `VCInlineTree` (`src/modules/base/visualComponentRef/VCInlineTree.tsx`).

`VCInlineTree` renders the VC's flat node map as a React subtree using the module registry. Two props from the page-level ref node are forwarded onto the **first rendered root element** of the VC:

- `rootMcClassName` — the ref node's own resolved class string, so styles assigned to the ref instance apply to its rendered root (same contract as the publisher's `injectClassIntoRootElement`).
- `rootNodeWrapperProps` — the editor wrapper bag (`data-node-id`, event handlers, etc.) so canvas selection, hover, and overlay positioning target the rendered component content rather than a dropped wrapper or the iframe `<body>`.

**`base.body` is transparent in inline preview.** Every VC tree has `base.body` as its stored root. In the editor preview, `base.body` is not rendered as a DOM element — `VCInlineTree` renders `base.body`'s children directly, forwarding `rootMcClassName` and `rootNodeWrapperProps` to the **first renderable** child (the first non-hidden child with a registered module). This prevents a nested component body from overwriting the canvas iframe's real `<body>` element's attributes. The real iframe `<body>` always belongs to the page root node only.

---

## Param substitution and prop bindings

A VC ref instance carries `instanceProps` — the values for the VC's `params`. Inside the VC tree, any node prop can be bound to a param via `propBindings`:

```jsonc
// A node inside the VC tree:
{
  "id": "...",
  "moduleId": "base.heading",
  "props": { "text": "Default", "level": 2 },
  "propBindings": {
    "text": { "paramId": "<heading-param-id>" }
  }
}
```

At render time, `renderVisualComponentRef`:

1. Iterates the ref's `instanceProps` keyed by `paramId`.
2. For each VC node with `propBindings`, replaces the bound prop value with the matching `instanceProps[paramId]` (or the param's `defaultValue` if unset).
3. The substituted props pass through `escapeProps` like any other node.

So inside the VC, props always have a "design-time default" (in `node.props`); at render time, the binding overrides it with the instance value.

### Inserting a binding

The editor's Properties Panel shows a "bind to param" affordance for each prop on a VC tree node. Selecting a param adds `propBindings[propKey] = { paramId }` and the canvas re-renders the VC with the bound value.

---

## VC reference predicate

`src/core/visualComponents/vcRefs.ts` is the single source of truth for "what is a VC reference node" (`base.visual-component-ref` with a non-blank `props.componentId`). It was previously re-encoded in three places; it now lives once.

```ts
forEachVCRef(nodes: unknown, cb: (ref: VCRef) => void): void
collectVCRefs(nodes: unknown): VCRef[]   // convenience wrapper
```

Both accept `unknown` node maps so they work on raw/untyped data (validateSite, recursion guarding) and on fully-typed page / VC trees alike. Non-object maps, non-ref nodes, and refs with a missing or blank `componentId` are skipped.

`recursionGuard.ts` and `deletionImpact.ts` both consume `forEachVCRef` to iterate refs — they never inline their own VC-ref detection logic.

---

## Recursion guard

A VC must not reference itself (directly or via a chain). `src/core/visualComponents/recursionGuard.ts`:

```ts
wouldCreateCycle(visualComponents: unknown[], hostVcId: string, candidateChildVcId: string) → boolean
```

The mutation paths that insert a `base.visual-component-ref` call `wouldCreateCycle` first; if true, the mutation aborts and the UI shows a `VisualComponentRecursionError`.

`getReferencedComponentIds(vc)` returns the set of all `componentId` values referenced by `base.visual-component-ref` nodes anywhere in a VC's flat tree; the cycle check walks the graph transitively via BFS.

---

## Instantiation flow

```text
User drops a VC ref onto the canvas
    │
    ▼
mutateActiveTree((tree) => {
    ├─→ insertNode(tree, refNode, parentId, index)
    │       (the ref node has `componentId` prop set to the VC id)
    │
    ├─→ const vc = lookupComponent(componentId)
    ├─→ syncSlotInstances(refNode, vc, tree.nodes)
    │       → SyncResult { inserts, renames, deletes }
    └─→ applySlotSyncResult(tree.nodes, result)
})
```

Same pattern fires on:

- VC reference rebind (changing which VC a ref points to)
- VC author edits (adding / removing / renaming slots) — sync runs against every `base.visual-component-ref` in every page tree **and** in every other VC's definition tree (a nested VC ref is reconciled the same way as a ref on a page)

---

## Componentizing existing page content

A page subtree can be promoted to a new Visual Component without leaving the editor — the "Componentize" action is available in two places:

**Layer context menu:** right-click any eligible node in the DOM panel or on the canvas, choose **Componentize**. The menu item is shown when `canComponentizeNode` returns true (see below).

**Properties Panel button:** when a single eligible node is selected, a **Componentize** button appears in the Properties Panel header (next to the class picker).

### Eligibility — `canComponentizeNode`

`src/admin/pages/site/componentization/componentizeEligibility.ts`:

```ts
canComponentizeNode(activeDocument, node) → node is PageNode
```

Returns `true` only when all three conditions hold:

- `activeDocument.kind !== 'visualComponent'` — page canvas only; not allowed inside a VC canvas.
- The node exists (is not null / undefined).
- `node.moduleId` is neither `'base.body'` (the page root) nor `'base.visual-component-ref'` (already a ref).

### Store flow

Both entry points call `openComponentizeEditor(nodeId)` on the editor store (`uiSlice`):

1. Selection is set to `nodeId` (single-select).
2. Properties Panel is expanded and `focusedPanel` is set to `'properties'`.
3. `componentizeEditorRequest` is set to `{ nodeId, requestId }`.

`ConvertToComponentButton` (`src/admin/pages/site/panels/PropertiesPanel/ConvertToComponentButton.tsx`) reads `componentizeEditorRequest`: when the request's `nodeId` matches the button's own `nodeId`, the button switches to its inline editing strip (Input + Create + Cancel) and auto-focuses the name field.

The user types a component name and clicks **Create** (or presses Enter). `convertNodeToComponent(nodeId, name)` in `visualComponentsSlice`:

1. Validates the name via `validateComponentName`.
2. Deep-clones the source subtree from the page's flat nodes, remapping all IDs.
3. Wraps the clone in a `base.body` root (invariant: every VC tree has `base.body` as root).
4. Creates a new `VisualComponent` with the cloned tree and appends it to `site.visualComponents`.
5. Replaces the original subtree in the page with a `base.visual-component-ref` pointing at the new VC.
6. Runs `syncSlotInstances` on the new ref.

On success, `activeDocument` switches to the new VC and the editor opens its tree for editing.

### Key files

| File | Role |
|------|------|
| `src/admin/pages/site/componentization/componentizeEligibility.ts` | `canComponentizeNode` — eligibility predicate |
| `src/admin/pages/site/componentization/index.ts` | Public barrel for the `@site/componentization` module |
| `src/admin/pages/site/panels/PropertiesPanel/ConvertToComponentButton.tsx` | Inline name-input strip in the Properties Panel |
| `src/admin/pages/site/panels/DomPanel/LayerNodeContextMenu.tsx` | "Componentize" context menu item |
| `src/admin/pages/site/store/slices/uiSlice.ts` | `openComponentizeEditor`, `clearComponentizeEditorRequest`, `componentizeEditorRequest` |
| `src/admin/pages/site/store/slices/visualComponentsSlice.ts` | `convertNodeToComponent` — the actual page-tree mutation |

---

## Editing a VC (VC-mode)

The editor supports two modes — see [docs/editor.md](../editor.md):

| Mode    | What `mutateActiveTree(fn)` calls           | Tree                          |
|---------|---------------------------------------------|-------------------------------|
| `page`  | `fn(activePage)`                            | The active page's tree        |
| `vc`    | `fn(vc.tree as NodeTree<PageNode>)`         | The active VC's tree          |

The 11 named tree-mutation store actions work in both modes without branching. See [docs/reference/page-tree.md](../reference/page-tree.md).

Routing a VC into VC-mode goes through a "virtual page" wrapper:

`src/core/visualComponents/virtualPage.ts`:

- `flattenVCToVirtualPage(vc) → Page` — wraps the VC tree in a `Page`-shaped object so the editor's page-mode code paths work unchanged.
- `parseVirtualVCPageId(pageId) → vcId | null` — detects the virtual page id and returns the VC id.

This is why mutations don't need to branch — VC-mode looks like page-mode all the way down to `NodeTree`.

---

## Deletion impact

Deleting a VC has consequences across every page and every other VC tree that references it. `src/core/visualComponents/deletionImpact.ts`:

```ts
previewVCDeletion(site: SiteDocument, vcId: string): VCDeletionImpact | null
```

Returns `null` when the VC has no usages (the caller can commit silently). When usages exist:

```ts
interface VCDeletionImpact {
  vc:        { id: string; name: string }
  usages:    VCRefUsage[]   // every page + VC ref that points at this VC
  pageCount: number          // distinct pages with at least one ref
  vcCount:   number          // distinct other VCs with at least one ref
}
```

`previewVCDeletion` uses `forEachVCRef` (from `vcRefs.ts`) to walk both page trees and other VC definition trees. Self-references (a VC containing a ref to itself) are excluded. The admin UI shows the impact list before confirming the delete, so the user can decide to leave the VC alone.

---

## Publisher integration

At render time, the publisher's `renderVisualComponentRef` runs when the walker hits a `base.visual-component-ref` node:

```text
renderVisualComponentRef(refNode, config, acc, renderNode):
    │
    ├─→ vc = selectVisualComponentById(config.site, refNode.props.componentId)
    ├─→ build slotInstancesByName from refNode's base.slot-instance children
    │     (keyed by slotName — these are the user's slot fills in the consumer page tree)
    │
    ├─→ instantiateVCAtRef(vc, propOverrides, slotInstancesByName, config.page.nodes, refNode.id)
    │     → flat instantiated node map with slot outlets already filled
    │
    ├─→ wrap the instantiated map in a synthetic Page + derive a child RenderConfig
    │     { ...config, page: syntheticPage, dynamicNodeIds: undefined, annotateNodeIds: undefined }
    │     The child config inherits loopData, mediaAssets, publishVersion,
    │     templateContext, etc. from the OUTER config so that:
    │       • base.loop nodes inside the VC body fetch and render with data
    │       • image / media props inside the VC body resolve to full <picture> markup
    │
    ├─→ renderNode(rootNodeId, syntheticConfig, acc)
    │     The SAME acc (cssMap) is passed through unchanged → CSS dedup shared
    │     with the outer page, visibly, via an explicit parameter
    │
    └─→ inject refNode's classIds + inlineStyles onto the VC's root element
```

Slot-outlet ↔ slot-instance bridging happens inside `instantiateVCAtRef` — by the time the recursive render walk starts, the instantiated node map already contains the consumer's slot content at the correct positions. The consumer page tree is the canonical store for slot fills; the publisher materialises them at render time only.

Server-side prefetch — `loopPrefetch.ts` and `mediaPrefetch.ts` — both use `walkRenderTree` (`server/publish/renderTreeWalk.ts`) to descend into every VC definition tree referenced from the page, so a `base.loop` or image inside a VC body is collected and pre-fetched before the render walk starts.

See [docs/features/publisher.md](publisher.md) for the broader pipeline.

---

## Cookbook

### Author a VC with a slot

1. Open the **Site → Components** panel, create a new VC.
2. In VC-mode, build the layout: containers, headings, etc.
3. Drop a **`base.slot-outlet`** at every position user content should be plugged in. Set its `slotName` (`'header'`, `'body'`, etc.).
4. Optionally seed the outlet with default child content — used the first time a consumer drops the ref.
5. Save.

When the VC is referenced on a page, the consumer sees one slot-instance per distinct `slotName`, each pre-filled with the outlet's default children.

### Add a typed parameter

1. In VC-mode, open the Parameters panel.
2. Add a param: name, type, defaultValue, required, enumOptions if `type === 'enum'`.
3. Pick the VC tree node whose prop should be bound. In the Properties Panel for that prop, choose **"Bind to param"** and select the param.
4. Save.

Consumers see a control for the param in the VC ref's Properties Panel (type-driven — `Input`, `Switch`, `Select`, `ColorInput`, etc.).

### Programmatically instantiate a VC

```ts
import { instantiateVCAtRef } from '@core/visualComponents'

const { refNode, slotInstances } = instantiateVCAtRef(vc, { /* instanceProps */ })
// refNode has props.componentId = vc.id and one slot-instance child per slot.
```

`instantiateVCAtRef` is what the editor uses internally when a ref is dropped. Plugins shipping a VC pack use it during install to materialize starter refs.

### Delete a VC safely

1. Call `previewVCDeletion(site, vcId)` to enumerate references.
2. Show the impact list in the UI; require confirmation.
3. On confirm, call `deleteVisualComponent(id)` (store action in `visualComponentsSlice.ts`), which in a single Mutative draft:
   - Removes the VC from `site.visualComponents`.
   - Calls `removeNodeSubtrees` (from `@core/page-tree`) to splice every `base.visual-component-ref` pointing at the deleted VC — plus its entire subtree of slot-instances and user content — from every **page** tree and every other **VC definition** tree in the site.

---

## Forbidden patterns

| Pattern                                                                | Use instead                                                   |
|------------------------------------------------------------------------|---------------------------------------------------------------|
| Storing slot content as a `slotContent` prop on the ref                | `base.slot-instance` children in the consumer page tree       |
| Looking up slots from `vc.params` instead of walking the VC tree       | `extractSlotNamesFromVCTree` / `syncSlotInstances`            |
| Mutating `slot-instance` children directly outside the consumer page   | They live in the consumer page tree — edit them there         |
| Binding a prop on a VC tree node to a literal value                    | The literal goes in `node.props`. Bindings are `propBindings` mapping prop → `{ paramId }`. |
| Looking up a param by `name`                                           | Use `id` — names can be renamed, ids are stable               |
| Inserting a ref without running `syncSlotInstances`                    | Always sync, even on first insert. `instantiateVCAtRef` does it for you. |
| Running slot sync against page trees only when a slot shape changes    | Use `allTreeNodeMaps(site)` from `vcSlotReconcile.ts` (covers pages + all VC trees) so refs nested inside other VCs are also reconciled |
| Allowing recursive VC refs                                             | Call `wouldCreateCycle(...)` before insert / rebind           |
| Branching on `kind === 'visualComponent'` inside a tree mutation       | Mutations operate on `NodeTree<TNode>` — `mutateActiveTree` is the only branch (gated). |

---

## Related

- [docs/architecture.md](../architecture.md) — `NodeTree` is the universal tree primitive
- [docs/editor.md](../editor.md) — `mutateActiveTree` and the VC-mode flow
- [docs/features/publisher.md](publisher.md) — `renderVisualComponentRef` inlines VCs at publish time
- [docs/reference/page-tree.md](../reference/page-tree.md) — `NodeTree<TNode>` and the mutation API
- Source-of-truth files:
  - `src/core/visualComponents/schemas.ts` — `VisualComponentSchema`, `VCParamSchema`, `VCNodeSchema`
  - `src/core/visualComponents/slotSync.ts` — `syncSlotInstances`, `applySlotSyncResult`
  - `src/core/visualComponents/instantiate.ts` — `instantiateVCAtRef`
  - `src/core/visualComponents/vcRefs.ts` — `forEachVCRef`, `collectVCRefs` (single VC-ref predicate)
  - `src/core/visualComponents/recursionGuard.ts` — `wouldCreateCycle`, `getReferencedComponentIds`
  - `src/core/visualComponents/nameValidation.ts` — `validateComponentName`, `validateParamName`
  - `src/core/visualComponents/deletionImpact.ts` — `previewVCDeletion`
  - `src/core/visualComponents/virtualPage.ts` — `flattenVCToVirtualPage` (VC-mode wrapper)
  - `src/core/visualComponents/origin.ts` — `findParamOrigin`
  - `src/core/publisher/renderVisualComponentRef.ts` — render-time inlining
  - `src/modules/base/visualComponentRef/VCInlineTree.tsx` — editor inline preview renderer
  - `src/modules/base/visualComponentRef/VisualComponentRefEditor.tsx` — editor canvas component for `base.visual-component-ref`
  - `src/core/data/componentFromRow.ts` — VC ↔ data row serialization
  - `src/admin/pages/site/componentization/componentizeEligibility.ts` — `canComponentizeNode`
  - `src/admin/pages/site/panels/PropertiesPanel/ConvertToComponentButton.tsx` — inline name-input strip
  - `src/admin/pages/site/store/slices/visualComponentsSlice.ts` — `convertNodeToComponent`
  - `src/admin/pages/site/store/slices/vcSlotReconcile.ts` — `syncAllVCRefSlotInstances`, `allTreeNodeMaps`
- Gate tests:
  - `src/__tests__/architecture/visual-components-mutation-contract.test.ts`
  - `src/__tests__/architecture/no-vc-in-site-shell.test.ts`
  - `src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts`
  - `src/__tests__/architecture/multiWrapDefaults.test.ts`
- Regression tests:
  - `src/__tests__/canvas/visualComponentRefInlineBody.test.tsx` — verifies `base.body`-rooted VCs don't overwrite the iframe `<body>` and that selection still works
  - `src/__tests__/visualComponents/vcRefs.test.ts` — pins the single VC-ref predicate: `forEachVCRef` / `collectVCRefs` find exactly the valid refs; `getReferencedComponentIds` returns the same set
