# Page Tree

The `NodeTree<TNode>` primitive — the single tree-of-nodes shape used everywhere in this codebase: page trees, Visual Component trees, and slot fills.

This doc shows the type, the mutation API, and how to correctly route mutations to the active tree from the editor store.

---

## TL;DR

- Every tree of nodes in the CMS uses the shape `NodeTree<TNode> = { nodes: Record<string, TNode>, rootNodeId: string }`. **There is no other tree primitive.**
- The TypeBox schema and the generic type live in **one file**: `src/core/page-tree/treeSchema.ts`.
- A `Page` **is** a `NodeTree<PageNode>` (it adds metadata fields on top).
- A `VisualComponent` **has** a `NodeTree` exposed as `vc.tree`.
- A slot fill is the children subtree of a `base.slot-instance` node — it lives directly in the consumer page tree, no separate prop.
- All mutations live in `src/core/page-tree/mutations.ts` and operate **generically** on any `NodeTree<TNode>`. They know nothing about page vs. VC.
- The editor store's `mutateActiveTree(fn)` is the **only** place that decides which tree to mutate. Store actions are one-liners that call it.

---

## The shape

`src/core/page-tree/treeSchema.ts`:

```ts
export interface NodeTree<TNode extends BaseNode = BaseNode> {
  nodes: Record<string, TNode>     // flat map for O(1) lookup
  rootNodeId: string                // entry point for traversal
}

export const NodeTreeSchema = Type.Object({
  nodes:      Type.Record(Type.String(), BaseNodeSchema),
  rootNodeId: Type.String(),
})
```

Why a flat map plus a root id:

- **O(1) lookup** by id — no recursive search to find a node.
- **Cheap structural sharing** in Mutative — mutating one node only invalidates that key.
- **Stable references in props** — any prop that points at a node uses its id (`children: string[]`), so reordering / moving nodes doesn't break references.

### `BaseNode` — the shared structural base

`src/core/page-tree/baseNode.ts`:

```ts
export const BaseNodeSchema = Type.Object({
  id:                  Type.String(),
  moduleId:            Type.String(),         // 'base.container', 'base.text', etc.
  props:               withFallback(Type.Record(Type.String(), Type.Unknown()), {}),
  breakpointOverrides: withFallback(Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown())), {}),
  children:            Type.Array(Type.String()),   // ordered child node IDs
  parentId:            Type.Optional(Type.Union([Type.String(), Type.Null()])), // O(1) parent pointer; see invariant below
  label:               Type.Optional(Type.String()),
  locked:              Type.Optional(Type.Boolean()),
  hidden:              Type.Optional(Type.Boolean()),
  classIds:            withFallback(Type.Array(Type.String()), []),
  inlineStyles:        Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  // ... propBindings, etc.
})
```

#### The `parentId` invariant

`parentId` is a **denormalised pointer to a node's parent** — `null` for the root node (and for a freshly-created, not-yet-inserted node). It makes `getParent` O(1) instead of an O(N) scan of every node in the map — the single highest-impact engine perf fix (the old scan fired on every pointer-move during a drag, and inside O(M·D) multi-select mutation loops).

The rules:

- **`children` is the structural source of truth; `parentId` is a derived cache of it.** The two must always agree: for every `parent.children` entry `childId`, `nodes[childId].parentId === parent.id`.
- **Always fully consistent — never half-populated.** Every parentage-changing mutation maintains it inline (`insertNode`, `deleteNode`, `moveNode`/`moveNodes`, `duplicateNode`, `wrapNode`/`wrapNodes`, `pasteSubtree`, `addPage`, `duplicatePage`, slot materialization). The invariant is enforced after every mutation (and after undo/redo) by `src/__tests__/page-tree/parentIndex.test.ts`.
- **Derived on entry, stored value never trusted.** `reindexNodeParents(nodes)` recomputes `parentId` for a whole flat map purely from the `children` arrays. It runs at every boundary where a tree enters the system — `parsePage`, `parseVisualComponent`, `parsePageNodeTree`, the editor store's `loadSite`/`createSite`, `composeTemplateChain`, the HTML-import bulk-merge paths, and runtime VC-tree construction. This is the backfill: data persisted before `parentId` existed is healed on load, and a stored `parentId` is always overwritten from the children arrays. (`parentId` IS persisted on save — it's a redundant-but-harmless cache that is recomputed, not relied upon, on the next load.)
- **Optional at the schema level** so persisted data predating the field and transient detached nodes still validate. The runtime invariant guarantees full population for any tree that has entered the system, so `getParent` reads the pointer directly with no scan fallback.

`inlineStyles` is the per-node **inline-style layer**: a camelCase CSS bag (same shape as a `StyleRule`'s `styles`) that the publisher emits as a literal `style="…"` attribute on the node's root element (or on `<body>` for the root `base.body` node). It is independent of `classIds` (a node can have both) and is **base-only** — like a real HTML `style=""` attribute it cannot be breakpoint- or condition-scoped. Values are sanitised at the publish boundary by `bagToInlineStyle` → `sanitiseCssValue`. Edited via the Properties panel's "Style inline" mode (store actions `setNodeInlineStyles` / `removeNodeInlineStyleProperty`); the HTML importer also writes it when it harvests an element's inline background image.

`PageNode` (in `src/core/page-tree/pageNode.ts`) extends `BaseNode` with an optional `dynamicBindings` field for template data-binding. `VCNode` (in `src/core/visualComponents/schemas.ts`) is a direct re-export — `VCNode === BaseNode`.

### Where each kind of tree lives

| Tree kind                | Type                  | Stored where                            |
|--------------------------|-----------------------|-----------------------------------------|
| `Page` (a page's tree)   | `NodeTree<PageNode>`  | `data_rows` row, table `pages`, cell `body` |
| `VisualComponent.tree`   | `NodeTree<BaseNode>`  | `data_rows` row, table `components`, cell `tree` |
| Slot fill                | Children of `base.slot-instance` | Same page tree as its consumer  |

There is no separate `pages` table, no `page_versions` table. Everything content-shaped is in `data_tables` + `data_rows`.

---

## Runtime Validation

The canonical TypeBox schemas for tree mutation RPCs live with the tree engine:

- `TreeOperationSchema` validates the 11 `applyTreeOperation` variants. Insert operations require a complete `PageNode`.
- `TreeMutateResultSchema` validates the `{ tree, affectedNodeIds }` response shape.
- `parsePageNodeTree(value)` validates a `NodeTree` payload and then checks tree invariants that JSON Schema cannot express: `rootNodeId` must exist, node-map keys must match each node's `id`, child IDs must resolve, and the reachable tree must be acyclic.

Page and Visual Component persistence runs the same invariant check before accepting trees. Plugin `cms.content.tree.mutate` and `cms.content.tree.replace` use these schemas before storing page-tree cells, so cross-VM payloads ride the same tree contract as the editor.

---

## The mutation API

All mutations live in `src/core/page-tree/mutations.ts`. They take a `NodeTree<PageNode>` (or sometimes a `SiteDocument` for cross-page operations) and mutate it in place — they're written for use inside Mutative drafts.

### Node mutations (operate on a single `NodeTree`)

| Function                                                          | What it does                                                |
|-------------------------------------------------------------------|-------------------------------------------------------------|
| `createNode(moduleId, defaults?) → PageNode`                      | Build a new node with a generated id (not yet inserted)     |
| `insertNode(tree, node, parentId, index?)`                        | Insert under `parentId` at `index` (append if omitted)      |
| `deleteNode(tree, nodeId)`                                        | Remove a node and its entire subtree                        |
| `updateNodeProps(tree, nodeId, patch)`                            | Shallow merge `patch` into the node's `props`               |
| `setBreakpointOverride(tree, nodeId, breakpointId, patch)`        | Shallow-merge `patch` into the node's breakpoint overrides for `breakpointId` |
| `clearBreakpointOverride(tree, nodeId, breakpointId)`             | Remove ALL overrides for `breakpointId` on that node       |
| `renameNode(tree, nodeId, label)`                                 | Set the user-facing `label`                                 |
| `toggleNodeLocked(tree, nodeId)`                                  | Flip `locked`                                               |
| `toggleNodeHidden(tree, nodeId)`                                  | Flip `hidden`                                               |
| `moveNode(tree, nodeId, newParentId, newIndex)`                   | Re-parent + re-order                                        |
| `moveNodes(tree, nodeIds, newParentId, newIndex)`                 | Same, multi-select                                          |
| `buildSubtreeNodeIdMap(rootNodeId, nodes)`                        | Build a `Map<oldId, newId>` for all nodes reachable from `rootNodeId`. Used by callers that need the id map before pasting (e.g. to remap scoped class `scope.nodeId`). |
| `duplicateNode(tree, nodeId, ...)`                                | Deep-clone with fresh ids, place after the original         |
| `wrapNode(tree, nodeId, wrapperModuleId)`                         | Wrap a node in a new container                              |
| `wrapNodes(tree, nodeIds, wrapperModuleId)`                       | Same, multi-select                                          |
| `pasteSubtree(tree, subtree, parentId, index?)`                   | Insert a previously-copied subtree with new ids             |
| `deleteSubtree(nodes, rootId, options?)`                          | THE single subtree-deletion primitive. Removes `rootId` and all its descendants from a flat node map. `options.unlinkParent` (default `true`) controls whether the root is also spliced from its parent's `children[]` — slot-sync passes `false` because it overwrites the parent's children array wholesale afterwards. Takes `Record<string, BaseNode>` directly. Works on both Mutative drafts and plain object maps. |
| `removeNodeSubtrees(nodes, rootNodeIds)`                          | Cascade-delete multiple root nodes and their entire subtrees. Calls `deleteSubtree(..., { unlinkParent: true })` for each root. Used to splice every `base.visual-component-ref` pointing at a deleted VC (plus all its slot-instance children and user content) from page trees and VC definition trees. Takes `Record<string, BaseNode>` directly. |

### Site-level mutations (operate on a `SiteDocument`)

| Function                                       | What it does                                  |
|------------------------------------------------|-----------------------------------------------|
| `addPage(site, title, slug) → Page`            | Append a new page to `site.pages`. Slug is auto-uniqued via `uniquePageSlug` — a collision never bricks the save. |
| `deletePage(site, pageId)`                     | Remove a page                                 |
| `renamePage(site, pageId, title, slug?)`       | Update title (and slug). Slug is auto-uniqued (skipping self-collision); `'index'` is always set verbatim. |
| `reorderPages(site, fromIndex, toIndex)`       | Reorder the page list                         |
| `duplicatePage(site, pageId, ...)`             | Clone a page with a fresh id. Slug is auto-uniqued so the copy never collides with the source. |

### Helpers and selectors

`src/core/page-tree/selectors.ts`:

- `getNode(tree, id)` — O(1) node lookup by id; returns `undefined` if not found.
- `getNodeOrThrow(tree, id)` — same as `getNode` but throws `[PageTree] Node "<id>" not found`.
- `getChildren(tree, nodeId)` — returns all direct children of a node as typed `TNode[]`.
- `getParent(tree, nodeId)` — returns the parent **node** (`TNode`) or `undefined` for the root. O(1) via the node's `parentId` pointer (see "The `parentId` invariant" above) — no node-map scan.
- `getAncestors(tree, nodeId)` — ordered `[root, …, parent]` chain. O(depth) by walking `parentId`.
- `collectSubtreeIds(nodes, rootId)` — THE single descendant-collection primitive for the whole engine. Takes a raw `Record<string, BaseNode>` (not the full `NodeTree`) and returns all node IDs reachable from `rootId` in DFS pre-order, with a hard cycle guard. Every deletion and duplication path that needs "this node and everything under it" routes through this function. No caller may re-implement this walk without the cycle guard.
- `flattenSubtree(tree, nodeId)` — NodeTree-typed wrapper over `collectSubtreeIds`. Returns node IDs in DFS pre-order. Used by virtual-scroll flattening in the DOM tree panel.
- `isAncestor(tree, ancestorId, descendantId)` — true if `ancestor` is on the path to `descendant`. O(depth) via `parentId`.
- `resolveProps(node, breakpointId?, schema?)` — merge base props with breakpoint overrides, filtering to `breakpointOverridable: true` keys when `schema` is provided.
- `evaluateCondition(condition, props)` — evaluate a declarative `PropertyCondition` against a props object. Used by the Properties Panel to show/hide controls.

`src/core/page-tree/parentIndex.ts`:

- `reindexNodeParents(nodes)` — recompute every node's `parentId` from the `children` arrays (the backfill / derive-on-entry helper). Tree-agnostic: takes a `Record<string, BaseNode>` directly.

`src/core/page-tree/cloneNode.ts`:

- `cloneNodeWithRemap(node, { newId, idMap, classIdRemap? }) → PageNode` — THE single node deep-clone primitive. Copies one `PageNode` with a fresh `id`, remaps `children` through `idMap` (child ids absent from the map are pruned), deep-copies every persisted sub-object (`props`, `breakpointOverrides`, `inlineStyles`, `propBindings`, `dynamicBindings`) so nothing is shared by reference with the source, and applies `classIdRemap` (if provided) to filter or remap `classIds`. Callers: `duplicateNode`, `pasteSubtree`, and `duplicatePage` all route through here; adding a new persisted `BaseNode`/`PageNode` field means editing exactly this one file.

`src/core/page-tree/scopedClassClone.ts`:

- `cloneScopedClassesForNodeMap(...)` — rewrites class ids that scope to specific nodes when those nodes are duplicated.

`src/core/page-tree/baseNode.ts`:

- `parseBaseNodeFields(r, path)` — THE shared tolerant parser for all `BaseNode` fields. Accepts an already-narrowed record `r` and a `path` string used in error messages. Returns the normalised `BaseNode` with `withFallback` defaults applied (non-string `children` / `classIds` entries dropped, non-object `breakpointOverrides` entries dropped, etc.). Throws `Error('<path>.<field>: …')` when a required field (`id`, `moduleId`, `children`) is absent or the wrong type. `parentId` is intentionally omitted from the output — it is recomputed by `reindexNodeParents` after the whole tree is parsed. Both `parsePageNode` (page tree) and `parseVCNode` (VC schemas) delegate here, so a fix to any shared normalisation path lands once for both.
- `parsePropBindings(raw)` — tolerant parser for a node's `propBindings` map. Invalid entries are silently dropped; returns `undefined` when no valid entries remain. Use at the raw-data parsing layer (not a schema-level transform).

`src/core/page-tree/slugs.ts` (exported via `@core/page-tree`):

- `pagePublicPath(slug)` — maps a slug to its public URL path: `'index'` → `'/'`, everything else → `'/<slug>'`. Slash-delimited slugs are public paths (`'docs/api'` → `'/docs/api'`).
- `isHomePage(page)` — returns `true` when `page.slug === 'index'`. The home page is the one published at the site root.
- `findHomePage(pages)` — returns the `Page` with `slug === 'index'`, or `undefined`. Used by `lifecycleActions` to default the editor to the home page on load and by `SiteExplorerPanel` to pin it to the top of the list.
- `normalizePageSlug(value)` — lowercases, normalises each slash-delimited path segment, strips invalid characters, and collapses hyphens.
- `pageSlugError(slug)` — returns a validation error message or `null` if the slug is valid. Valid page slugs are lowercase hyphenated segments separated by single slashes; the first segment cannot be a reserved public route (`admin`, `api`, `assets`, `health`).
- `pageSlugDuplicateError(slug, pages, currentPageId?)` — checks for slug collisions across the page list.
- `createUniquePageSlug(title, pages)` — generates a collision-free slug from a page title (normalises + reserved-slug guard + uniqueness).

---

## Routing mutations from the editor store

The editor store at `src/admin/pages/site/store/` has 11 named tree-mutation actions:

```text
insertNode, deleteNode, updateNodeProps,
setBreakpointOverride, clearBreakpointOverride,
renameNode, toggleNodeLocked, toggleNodeHidden,
moveNode, duplicateNode, wrapNode
```

Every one of them is a **one-liner** that delegates to `mutateActiveTree(fn)`, which routes via `resolveActiveTreeTarget` — the sole implementation of the page-mode vs. VC-mode branch:

```ts
// src/admin/pages/site/store/slices/site/helpers.ts (canonical pattern)
function resolveActiveTreeTarget(state): NodeTree<PageNode> {
  // page mode → the active Page (Page IS NodeTree<PageNode>)
  // VC mode   → the VC's tree (VCNode === BaseNode structurally)
}
function mutateActiveTree(fn: (tree: NodeTree<PageNode>) => void): void {
  fn(resolveActiveTreeTarget(draft))
}

// All 11 actions follow this shape:
insertNode: (node, parentId, index) =>
  set((s) => mutateActiveTree((tree) => insertNode(tree, node, parentId, index))),
```

Gated by `src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts`: any of the 11 store actions that introduces a `kind === 'visualComponent'` branch fails the build.

### Why this is correct

`PageNode` adds `dynamicBindings` to `BaseNode`. `VCNode === BaseNode`. The 11 mutations only touch fields that exist on the base — they never read `dynamicBindings`, so the cast in VC-mode is safe.

---

## Cookbook

### Walk every node in a tree

```ts
import type { NodeTree, PageNode } from '@core/page-tree'

function eachNode(tree: NodeTree<PageNode>, visit: (node: PageNode) => void): void {
  const stack = [tree.rootNodeId]
  while (stack.length) {
    const id = stack.pop()!
    const node = tree.nodes[id]
    if (!node) continue
    visit(node)
    stack.push(...node.children)
  }
}
```

The flat map plus children-as-ids makes traversal trivial in either direction.

### Find a node's parent

```ts
import { getParent } from '@core/page-tree'

const parent = getParent(tree, nodeId)        // the parent node, or undefined
if (parent) {
  const index = parent.children.indexOf(nodeId)
  console.log('node', nodeId, 'lives under', parent.id, 'at index', index)
}
```

`getParent` returns `undefined` for the root. It is O(1) (reads `node.parentId`) — do NOT hand-roll an `Object.values(tree.nodes).find(n => n.children.includes(id))` scan; that was the hot path this pointer replaced.

### Insert a freshly-created node

```ts
import { createNode, insertNode } from '@core/page-tree'

const heading = createNode('base.heading', { level: 2, text: 'Hello' })
insertNode(tree, heading, parentId)   // appended
// or
insertNode(tree, heading, parentId, 0) // first child
```

### Add a new store mutation

1. **Write the tree function** in `src/core/page-tree/mutations.ts`. Generic in `TNode`, takes the tree first.
2. **Wire the store action** in `src/admin/pages/site/store/slices/site/nodeActions.ts`:

   ```ts
   yourMutation: (...args) =>
     set((s) => mutateActiveTree((tree) => yourMutation(tree, ...args))),
   ```
3. **Don't branch on VC mode.** The gate will fail your build if you do.

### Validate a tree loaded from disk

```ts
import { parsePageNodeTree } from '@core/page-tree'

const tree = parsePageNodeTree(raw)
// Returns a typed NodeTree<PageNode>; throws on schema mismatch, missing root,
// node-map key/id mismatch, unresolved child IDs, or reachable cycles.
```

`parsePageNodeTree` checks both the TypeBox schema (`NodeTreeSchema`) and the post-schema invariants that JSON Schema cannot express (root presence, key parity, child resolution, acyclicity). The persistence layer (`src/core/persistence/validate.ts`) and the plugin content handlers use this for every tree payload.

---

## Forbidden patterns

| Pattern                                                         | Use instead                                                |
|-----------------------------------------------------------------|------------------------------------------------------------|
| Maintaining a parallel local copy of node data inside a panel   | Read from the store via a selector (Constraint #182)       |
| Branching on `kind === 'visualComponent'` inside a store mutation | Let `mutateActiveTree` route — keep the mutation generic |
| Treating slot fills as a separate "slotContent" prop            | Slot fills are children of a `base.slot-instance` node in the same tree |
| Adding a parallel `interface NodeTree` type                     | `NodeTreeSchema` and `NodeTree<TNode>` in `treeSchema.ts` are the source of truth |
| Using a non-flat tree representation (nested `children: PageNode[]`) | Flat map + `children: string[]` — covered by `src/__tests__/persistence/treeSchemaShape.test.ts` |
| Writing a mutation that takes a `Page` specifically             | Take `NodeTree<TNode>` — pages and VCs both pass            |
| Rolling a custom DFS walk to collect descendants                 | Use `collectSubtreeIds(nodes, rootId)` — it is THE single walker with a hard cycle guard; hand-rolled walks skip the guard and loop forever on corrupt trees |
| Calling `deleteSubtree` / `removeNodeSubtrees` without the `parentId` cache being populated | `parentId` is stamped by every mutation and by `reindexNodeParents` on load — it is always populated for any in-system tree; the delete primitives rely on it |
| Deep-importing a concrete file: `import X from '@core/page-tree/mutations'` | Import through the barrel: `import { X } from '@core/page-tree'` — gated by `no-core-barrel-deep-imports.test.ts` |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview
- [docs/editor.md](../editor.md) — editor store and `mutateActiveTree`
- [docs/features/plugin-system.md](../features/plugin-system.md) — plugins ship VCs via `pack/site.json`
- Source-of-truth files:
  - `src/core/page-tree/treeSchema.ts` — `NodeTreeSchema` + `NodeTree<TNode>`
  - `src/core/page-tree/baseNode.ts` — `BaseNodeSchema`, `BaseNode`, `parseBaseNodeFields` (shared base-node parser used by both page and VC paths), `parsePropBindings`
  - `src/core/page-tree/pageNode.ts` — `PageNode` (extends `BaseNode`)
  - `src/core/page-tree/page.ts` — `Page` (is `NodeTree<PageNode>` + metadata)
  - `src/core/page-tree/mutations.ts` — all node + site mutations
  - `src/core/page-tree/cloneNode.ts` — `cloneNodeWithRemap` (THE single node deep-clone primitive)
  - `src/core/page-tree/selectors.ts` — `collectSubtreeIds` (THE single subtree-walker), `getNode`, `getParent`, `getAncestors`, `isAncestor`, `flattenSubtree`, `resolveProps`, `evaluateCondition`
  - `src/core/page-tree/subtreeRemoval.ts` — `deleteSubtree` (THE single subtree-deletion primitive), `removeNodeSubtrees`
  - `src/core/page-tree/parentIndex.ts` — `reindexNodeParents` (derive-on-entry backfill)
  - `src/core/visualComponents/schemas.ts` — `VCNode` (= `BaseNode`)
  - `src/admin/pages/site/store/slices/site/nodeActions.ts` — store actions calling `mutateActiveTree`
- Gate tests:
  - `src/__tests__/persistence/treeSchemaShape.test.ts`
  - `src/__tests__/page-tree/parentIndex.test.ts` — `parentId` invariant: every mutation keeps it consistent; undo/redo preserves it; `reindexNodeParents` derives from children only; `getParent` is O(1) not O(N)
  - `src/__tests__/page-tree/subtree-consolidation.test.ts` — cycle-safety: `collectSubtreeIds` + deletion + duplication all terminate on corrupt cyclic trees; `cloneNodeWithRemap` produces deep-independent clones; deletion paths unlink via O(1) `parentId` cache, not a whole-map scan
  - `src/__tests__/page-tree/baseNodeParse.test.ts` — parse equivalence: the same raw stored node normalises identically through `parsePage` (PageNode) and `parseVisualComponent` (VCNode), and both match `parseBaseNodeFields` directly
  - `src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts`
  - `src/__tests__/architecture/centralized-site-mutation-history.test.ts`
  - `src/__tests__/architecture/visual-components-mutation-contract.test.ts`
  - `src/__tests__/architecture/no-core-barrel-deep-imports.test.ts` — external code imports from `@core/page-tree`, never from `@core/page-tree/<file>`
