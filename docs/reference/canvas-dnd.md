# Canvas Drag-and-Drop

How drag-and-drop works in the visual editor: dropping new modules from the picker / library, moving existing nodes around the page tree, wrap-to-container, multi-select moves, and the drop-zone overlay.

Built on `@dnd-kit/core`. The canvas owns its own DnD context (separate from the dashboard's DnD); the same patterns apply on both sides.

---

## TL;DR

- `@dnd-kit/core` is the only DnD library. No `react-dnd`, no native HTML5 drag-and-drop.
- The canvas's `<DndContext>` lives at `CanvasRoot.tsx`. Every `BreakpointFrame` is inside it.
- Drop targets are **drop-zones** — rectangles between nodes ("before X", "after X", "into X"). Computed per-frame from node geometry.
- Drop resolution: `resolveCanvasDropTarget(...)` in `src/admin/pages/site/canvas/canvasDnd.ts` maps `(activePoint, frameGeometry) → { parentId, index, axis }`.
- Mutation: `mutateActiveTree((tree) => moveNode(tree, nodeId, parentId, index))` — page-mode and VC-mode both work.

---

## The DnD topology

```text
<DndContext>                               ← canvas owns this
  <BreakpointFrame breakpoint="mobile">
    <ModuleSandboxFrame>                   ← <iframe sandbox>
      <NodeRenderer ...>                   ← each node is a useDraggable
    </ModuleSandboxFrame>
  </BreakpointFrame>
  <BreakpointFrame breakpoint="desktop">...</BreakpointFrame>

  <ModulePicker>                            ← sources: 'picker:<moduleId>'
  <SiteExplorer>                            ← sources: 'tree:<nodeId>' (DOM panel rows)

  <DragOverlay>                             ← shared overlay
</DndContext>
```

Three kinds of drag sources:

| Source id pattern        | Origin                          | Drop result                                     |
|--------------------------|---------------------------------|-------------------------------------------------|
| `node:<nodeId>`          | A node on the canvas / DOM panel| Move the node to the drop target                |
| `picker:<moduleId>`      | The module picker / inserter    | Insert a new node of `moduleId` at the drop target |
| `tree:<nodeId>`          | The DOM panel tree              | Same as `node:` (DOM panel ⇄ canvas parity)     |

The page-level `onDragEnd` handler reads the source prefix and dispatches.

---

## Drop zones

A drop zone is a thin rectangle that resolves to **"insert at this position"**. There are three kinds:

```text
┌────────────────────────────┐
│ ─── before sibling A ───── │   ← "insert at index 0"
│ ┌────────────────────────┐ │
│ │   node A (container)   │ │   ← node A's "into" zone
│ │                        │ │
│ │  child 1               │ │
│ │  child 2               │ │
│ └────────────────────────┘ │
│ ─── between A and B ─────  │   ← "insert at index 1"
│ ┌────────────────────────┐ │
│ │   node B (text)        │ │
│ └────────────────────────┘ │
│ ─── after sibling B ────── │   ← "insert at index 2"
└────────────────────────────┘
```

| Zone kind | Position    | Resolves to                            |
|-----------|-------------|----------------------------------------|
| Before    | Top edge of a sibling | `{ parentId, index }` (sibling's index)|
| After     | Bottom edge | `{ parentId, index + 1 }`              |
| Into      | Body of a `canHaveChildren` node | `{ parentId: target.id, index: target.children.length }` (append) |

The axis (`'vertical' | 'horizontal'`) depends on the parent's layout — vertical for normal block flow, horizontal for `display: flex; flex-direction: row`.

---

## `resolveCanvasDropTarget`

```ts
resolveCanvasDropTarget({
  activePoint: { x, y },              // pointer in canvas-space coordinates
  frameGeometry,                      // measured rects for every node in the frame
  activeNodeId,                       // for 'node:' drags — exclude self
  moduleRegistry,                     // to ask `canHaveChildren`
}): CanvasDropResolution             // { target?: CanvasDropTarget; invalid?: CanvasInvalidDropTarget }
```

The resolver:

1. Walks `frameGeometry` from the leaves up.
2. For each rect, checks if `activePoint` falls in a zone.
3. Picks the **innermost match** — a point inside a child wins over the parent's "into" zone.
4. Rejects invalid drops (self into self, cycle, locked node).

`getCanvasDropZone(rect, point, axis)` is the helper that classifies a single rect's hit (`'before' | 'into' | 'after' | null`).

---

## Drop overlay

The overlay highlights the resolved drop position. Geometry comes from the resolver:

- **Before / After** — a thin sky-tinted line (`--accent-3` at 0.6 alpha) at the zone position.
- **Into** — a sky-tinted dashed outline inset 4px from the target's bounding box.
- **Invalid** — a danger-tinted outline (`--danger`) + a tooltip explaining why (`'cannot drop into self'`, `'target is locked'`).

The overlay is a separate React tree positioned with absolute coordinates derived from the canvas zoom/pan transform.

---

## DOM panel ⇄ canvas parity

The DOM panel uses the **same** drop resolution as the canvas — except its geometry comes from row positions, not canvas geometry. A node dragged in the DOM panel resolves the same `{ parentId, index }` as a node dragged on the canvas.

The two surfaces share `<DndContext>` so a drag can start in one and end in the other.

---

## Mutation

After the resolver picks a target, the page-level `onDragEnd`:

```ts
onDragEnd: (event) => {
  const { active, over } = event
  if (!over) return
  const sourceKind = parseSourceKind(active.id)
  const target = resolveCanvasDropTarget({ /* ... */ })
  if (!target.target) return

  if (sourceKind.kind === 'picker') {
    // Insert new module
    useEditorStore.getState().insertNode(
      createNode(sourceKind.moduleId),
      target.target.parentId,
      target.target.index,
    )
  } else if (sourceKind.kind === 'node') {
    // Move existing node
    useEditorStore.getState().moveNode(
      sourceKind.nodeId,
      target.target.parentId,
      target.target.index,
    )
  }
}
```

Both `insertNode` and `moveNode` go through `mutateActiveTree` — they work in page-mode and VC-mode the same way. See [docs/reference/page-tree.md](page-tree.md).

---

## Multi-select drag

The DOM panel + canvas support multi-select via shift / cmd-click. When the user drags one of the selected nodes:

- All selected nodes move together.
- They're moved to the drop target via `moveNodes(tree, nodeIds, parentId, index)` — the mutation preserves relative order.
- If any selected node can't be moved (locked, would create a cycle), the whole drop is invalid.

`moveNodes` is the multi-version of `moveNode`. Both live in `src/core/page-tree/mutations.ts`.

---

## Wrap-to-container

A common drag pattern: select two nodes, drag them onto a "wrap in container" affordance, and they become children of a new container at the original position.

Implemented as `wrapNodes(tree, nodeIds, 'base.container')` in `mutations.ts`. The drag source is the multi-select group; the drop target is a "wrap" affordance (shown in the toolbar / context menu, not as a canvas drop zone).

Gated by `task414-wrap-to-container.test.ts` and `multiWrapDefaults.test.ts` — wrapper nodes are created with module defaults and keep the wrapped tree structure valid.

---

## Cookbook

### Drop a new module from the picker

```ts
// In ModulePicker:
<button
  ref={setNodeRef}
  {...listeners}
  {...attributes}
  data-source-id={`picker:${moduleId}`}
>
  ...
</button>

// useDraggable({ id: `picker:${moduleId}` })
```

The `id` prefix tells `onDragEnd` it's a new-module insert.

### Drop an existing node

The canvas's `NodeRenderer` registers each node as `useDraggable({ id: `node:${nodeId}` })`. The drag is initiated by clicking the node's drag handle (or by middle-click drag in some flows). The same drop-zone resolution applies.

### Drop INTO a container

Drop zones for `canHaveChildren` nodes include an "into" zone covering the body. The resolver picks it when the pointer is inside the body (and not on a child's before/after zone). The new node is appended as the last child.

### Disable drops on a node

Set `locked: true` on the node. The resolver rejects drops on locked nodes (and drops of locked nodes themselves).

`base.slot-instance` nodes are always locked — the user can edit their **contents** but not move / delete the instance itself.

### Inserting a node programmatically

```ts
useEditorStore.getState().insertNode(
  createNode('base.text', { content: 'New text' }),
  parentNodeId,
  0,                  // index — at the start
)
```

Bypasses DnD entirely. Same mutation as a drop.

### Listening for drop events

Don't add raw `dragstart` / `dragend` listeners — `@dnd-kit` owns those. If you need to react to a drop, put the logic in `onDragEnd` (in the page that owns the `<DndContext>`).

---

## Forbidden patterns

| Pattern                                                              | Use instead                                              |
|----------------------------------------------------------------------|----------------------------------------------------------|
| Native HTML5 drag-and-drop (`draggable={true}`, `onDragOver`, etc.)  | `@dnd-kit/core` everywhere                               |
| `react-dnd`                                                          | `@dnd-kit/core` — only DnD library in this codebase     |
| Computing drop targets ad-hoc per surface                            | `resolveCanvasDropTarget(...)` — same logic everywhere   |
| Skipping the cycle check on a `moveNode`                             | `moveNode` already guards. Use it.                       |
| Inserting into a locked node                                          | Resolver rejects. Don't bypass.                          |
| Reading from the iframe's `document` to find drop targets             | Use the canvas-space geometry (`frameGeometry`)          |
| Dispatching a different mutation per drag source kind, deeply         | Two cases in `onDragEnd`: picker → `insertNode`, node → `moveNode`. Keep it that simple. |

---

## Related

- [docs/editor.md](../editor.md) — canvas overview
- [docs/reference/page-tree.md](page-tree.md) — `moveNode`, `moveNodes`, `wrapNode`, `wrapNodes`, `insertNode`
- [docs/features/visual-components.md](../features/visual-components.md) — slot-instance is locked
- [docs/features/dashboard.md](../features/dashboard.md) — separate DnD topology for the dashboard
- Source-of-truth files:
  - `src/admin/pages/site/canvas/canvasDnd.ts` — `getCanvasDropZone`, `resolveCanvasDropTarget`
  - `src/admin/pages/site/canvas/CanvasRoot.tsx` — `<DndContext>` mount
  - `src/admin/pages/site/canvas/useCanvasReorderDrag.ts` — drag-state hook
  - `src/admin/pages/site/store/insertLocation.ts` — `InsertLocation` shape
  - `src/core/page-tree/mutations.ts` — `insertNode`, `moveNode`, `moveNodes`, `wrapNode`
- Gate tests:
  - `src/__tests__/architecture/task414-wrap-to-container.test.ts`
  - `src/__tests__/architecture/canvas-aware-selectors.test.ts`
