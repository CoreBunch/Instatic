# Editor Undo/Redo History

How the visual editor captures, stores, and applies undo/redo history using Mutative patch pairs.

Every undoable mutation captures a `HistoryEntry` — a pair of Mutative patch arrays scoped to the `SiteDocument`. Undo applies the `inverse` patches; redo applies the `forward` patches. Cost is O(change): only the paths the recipe touches are drafted and copied.

---

## TL;DR

- History is `_historyPast: HistoryEntry[]` and `_historyFuture: HistoryEntry[]` on the editor store. Max depth: `MAX_HISTORY` (50).
- Each `HistoryEntry` holds `{ inverse, forward, coalesceKey }` — patch arrays, not full-site clones.
- `runHistoricMutation` is the single entry point. All six `mutate*` helpers delegate to it.
- Continuous-input bursts (per-keystroke text/number edits) fold into one entry via `commitHistory` coalescing.
- Patches are scoped to `site` (`state.site.*`) — editor-local state (selection, zoom, panel visibility) is not undoable.
- History is in-memory session state — never serialized.

---

## Performance

Per-mutation wall time is flat at ~0.25–0.4 ms regardless of site size:

| Nodes  | Patch-based | structuredClone (old) | Speedup |
|--------|-------------|----------------------|---------|
| 500    | 0.25 ms     | 0.76 ms              | 3×      |
| 5,000  | 0.28 ms     | 8.8 ms               | 31×     |
| 20,000 | 0.32 ms     | 34 ms                | 106×    |
| 50,000 | 0.40 ms     | 98 ms                | ~245×   |

A full 50-deep history stores ~240 small patches (KB total) instead of 50 whole-site clones (hundreds of MB).

---

## Data model

`src/admin/pages/site/store/slices/site/types.ts`:

```ts
import type { Patches } from 'mutative'

export interface HistoryEntry {
  /** Patches that revert this transaction. Applied on undo. */
  inverse: Patches
  /** Patches that re-apply this transaction. Applied on redo. */
  forward: Patches
  /** Coalescing burst identity, or null. */
  coalesceKey: string | null
}
```

The store holds:

```ts
_historyPast:       HistoryEntry[]  // stack — most recent last
_historyFuture:     HistoryEntry[]  // entries available for redo
canUndo:            boolean
canRedo:            boolean
_historyCoalesceKey: string | null  // identity of the in-progress burst
```

---

## How patches are captured

`runHistoricMutation` in `helpers.ts` is the core engine:

```ts
function runHistoricMutation(recipe, coalesceKey) {
  const [next, patches, inverse] = create(cur, (draft) => {
    result = recipe(draft)
    if (result !== false) draft.site.updatedAt = Date.now()
  }, { enablePatches: true })

  // History stores patches relative to `site` (strip the leading path segment)
  const siteForward = patches .filter(p => p.path[0] === 'site').map(p => ({ ...p, path: p.path.slice(1) }))
  const siteInverse = inverse.filter(p => p.path[0] === 'site').map(p => ({ ...p, path: p.path.slice(1) }))

  set(state => {
    // Apply all changed fields to the live store (site + any editor fields)
    for (const key of touched) live[key] = produced[key]
    if (siteForward.length > 0) commitHistory(state, { inverse: siteInverse, forward: siteForward, coalesceKey })
    state.hasUnsavedChanges = true
  })
}
```

`create(cur, recipe, { enablePatches: true })` returns `[next, forwardPatches, inversePatches]`. Only `site`-prefixed patches go into the history entry. Editor-only fields (selection, zoom) are applied live but never recorded.

---

## The six `mutate*` helpers

All six helpers in `SiteSliceHelpers` delegate to `runHistoricMutation`:

| Helper | Recipe receives | Coalescing |
|---|---|---|
| `mutateSite(fn, opts?)` | `SiteDocument` draft | `opts.coalesceKey` |
| `mutateSiteWithExplorerReconcile(fn)` | `SiteDocument` draft; calls `reconcileSiteExplorerInPlace` after | none |
| `mutatePage(fn)` | Active `Page` draft | none |
| `mutateActiveTree(fn, opts?)` | Active `NodeTree<PageNode>` draft; routes page vs. VC | `opts.coalesceKey` |
| `mutateActiveTreeAndSite(fn)` | Active `NodeTree<PageNode>` + `SiteDocument` drafts | none |
| `mutateAllPagesAndSite(fn)` | `SiteDocument` + `SuperImportHelpers` | none |

`mutateActiveTree` is the only place that branches on page-mode vs. VC-mode. Gated by `no-vc-mode-branches-in-mutations.test.ts`.

---

## Coalescing

Per-keystroke mutations (text edits, number sliders) pass a stable `coalesceKey` such as `props:<nodeId>:<prop>`. While the incoming key matches `_historyCoalesceKey`, `commitHistory` folds the new entry into the existing top entry **per patch path** (`foldIntoCoalescedEntry` in `helpers.ts`):

- **inverse**: the OLDEST patch per path wins (undo restores the pre-burst value); new paths append.
- **forward**: the NEWEST patch's value per path wins (redo replays the final value), preserving the oldest patch's op (an `add` stays an `add` so redo works from the post-undo state where the prop is absent).

A whole typing burst becomes one undo step holding at most one inverse + one forward patch per touched path — a 2,000-keystroke burst retains 2 paths' worth of patches, not 4,000 progressively-longer string snapshots.

Any non-coalescing mutation, `undo`, `redo`, or a site (re)load resets `_historyCoalesceKey` to `null`.

---

## Undo / redo apply

`undoRedoActions.ts` uses `apply` from Mutative:

```ts
// undo
const restored = apply(site, entry.inverse)
const packageJson = clonePackageJson(restored.packageJson)
const siteRuntime = cloneSiteRuntimeConfig(restored.runtime)
set(state => {
  state._historyPast.pop()
  state._historyFuture.push(entry)
  state._historyCoalesceKey = null
  state.site = { ...restored, packageJson, runtime: siteRuntime }
  state.packageJson = packageJson
  state.siteRuntime = siteRuntime
  // re-derive mirrors; keep activePageId valid
})
```

`redo` is symmetric: pops from `_historyFuture`, applies `entry.forward`, pushes back onto `_historyPast`.

---

## Auto-freeze

The Zustand store is created with `mutative({ enableAutoFreeze: true })`. This mirrors Immer's default dev guard against accidental external mutation — existing code already tolerates frozen state. `apply()` and `create()` handle frozen bases correctly.

---

## What is NOT undoable

- Selection, hover, zoom, pan — editor-local UI state, not in the `site` document.
- `mutateSiteState` — the recipe may write editor fields (e.g. `activeDocument`) alongside a `site` mutation; the editor fields go live but only the `site` patches enter history (parity with the prior snapshot model).
- History stacks themselves — resetting to `[]` on `clearSite` is a lifecycle operation, not a mutation.

---

## Forbidden patterns

- `structuredClone(site)` for history — the old snapshot model is gone. Never re-introduce it.
- Calling `set(state => { state.site = ... })` directly on a mutation — go through a `mutate*` helper so patches are captured.
- Returning a value from a `create` recipe — Mutative treats it as a full replacement. Capture no-op signals in a closure variable and return `false`.

---

## Related

- `src/admin/pages/site/store/slices/site/helpers.ts` — `runHistoricMutation`, `commitHistory`, all six `mutate*` helpers
- `src/admin/pages/site/store/slices/site/undoRedoActions.ts` — `undo`, `redo`
- `src/admin/pages/site/store/slices/site/types.ts` — `HistoryEntry`, `SiteSliceHelpers`
- `src/admin/pages/site/store/slices/site/defaults.ts` — `MAX_HISTORY`
- `docs/editor.md` — editor store overview
- `docs/reference/page-tree.md` — the `NodeTree` primitive mutations operate on
- Gate tests:
  - `src/__tests__/architecture/centralized-site-mutation-history.test.ts`
  - `src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts`
  - `src/__tests__/editor-store/undo-redo.test.ts`
