# Editor undo/redo

How Cmd+Z works in the visual editor since real-time co-editing landed.

## Where history lives

History does **not** live in the Zustand store anymore. It lives in the
collab binding (`src/admin/pages/site/store/slices/site/collabBinding.ts`)
as one **`Y.UndoManager` per collab document** — one per page, Visual
Component, and layout, plus one for the site shell/rosters. The store only
mirrors availability flags (`canUndo` / `canRedo`) and exposes the `undo` /
`redo` actions, which delegate to the binding (`site/undoRedoActions.ts`).

Because each manager tracks **`LOCAL_ORIGIN` only**, undo is per-editor by
construction: your Cmd+Z reverts *your* edits, never a peer’s — the
co-editing invariant.

## The mutation path

Every store mutation still runs through `runHistoricMutation`
(`site/helpers.ts`): the recipe mutates a Mutative draft, the resulting
site-relative patches are handed to `applyLocalSitePatches` (the binding),
which translates them into Y operations on the touched docs
(`@core/collab` `applySitePatchesToDocs`). The Y transaction is what the
UndoManager captures — the undo stack IS the CRDT edit history.

Undoing pops the doc’s stack; the resulting doc change projects back into
the store through the binding’s projection path (the same path remote
peers’ edits use), synchronously flushed so undo repaints immediately.

## Coalescing (typing bursts)

Per-keystroke mutations (text edits, number sliders) pass a stable
`coalesceKey` such as `props:<nodeId>:<prop>` through the `mutate*` helpers.
The managers run with an infinite `captureTimeout`; the binding calls
`stopCapturing()` exactly when the incoming key differs from the previous
one — so consecutive same-key edits merge into ONE undo step, and any
non-coalescing mutation, undo/redo, or inline-edit session boundary
(`collabBreakCoalescing`) starts a fresh step. Typing a word is one Cmd+Z.

## Multi-doc undo groups

A single mutation can touch several docs (convert-to-component writes the
page, the new component, and the site roster; Super Import touches
everything). The binding records each undoable step as a **group of docIds**
whose managers captured a new stack item, and `undo()` reverts the whole
group — one Cmd+Z, one logical mutation, across all its documents. The site
doc always sorts first in a group so roster reverts project after row-level
reverts.

## Lifecycle

`createSite` / `loadSite` / `clearSite` call `resetCollabDocsFromSite`,
which rebuilds the doc world for the new document and clears every undo
manager — history never survives a document swap. In detached mode (tests,
the pre-connect window) docs seed locally from the loaded site; in connected
mode every doc rebinds through the provider and the server seeds it.

Editor-local state (selection, zoom, panel visibility) is not undoable —
only document content flows through the docs.

It is, however, **reconciled**. A projection can remove nodes the editor is
still pointing at — an undo reverting an insertion, or a peer deleting the
subtree you had selected. The projection path therefore runs
`pruneCanvasSelectionDraft` after the new site lands, exactly as a local
`deleteNode` does: selections are pruned by tree-membership (survivors keep
theirs, the anchor re-syncs, descendants swept with a subtree drop out), and
an inline-edit session whose node vanished is closed. This is why selection
state has one pruning implementation rather than one per write path.

## Key files

- `src/admin/pages/site/store/slices/site/collabBinding.ts` — undo managers,
  routing groups, coalescing, projection
- `src/admin/pages/site/store/slices/site/helpers.ts` — `runHistoricMutation`
  and the six `mutate*` helpers (unchanged recipe API)
- `src/admin/pages/site/store/slices/site/undoRedoActions.ts` — the store’s
  `undo`/`redo` delegates
- `src/core/collab/applyPatches.ts` — patch → Y translation
- Tests: `src/__tests__/editor-store/undo-redo.test.ts` (behavioral
  contract), `src/__tests__/collab/*` (round-trip identity)
