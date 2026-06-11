/**
 * Patch-derived save-dirty tracking.
 *
 * Every undoable mutation already produces site-relative Mutative patches
 * (for undo history); this module reuses them to answer "which pages,
 * Visual Components, and saved layouts changed since the last successful
 * save", so autosave can ship `{ changedPages, pageIds }` instead of the
 * whole roster.
 *
 * Resolution rules (paths are relative to the SiteDocument):
 *   - `['pages', i, …]` / `['visualComponents', i, …]` / `['layouts', i, …]`
 *     → the POST-mutation element at index `i` is dirty. Post-state indexing
 *     is correct for every op that leaves an element at that index (add,
 *     replace, nested edits); reorders mark each displaced index —
 *     over-marking, which is safe.
 *   - `remove` at exactly `['pages', i]` marks nothing: deletions are conveyed
 *     by the id roster the save always ships, not by a page payload.
 *   - `['pages', 'length']` (array truncation bookkeeping) marks nothing for
 *     the same reason.
 *   - `['pages']` / `['visualComponents']` / `['layouts']` wholesale
 *     replacement, an index that doesn't resolve in the post-state, or any
 *     unrecognised shape → `all` (conservative full save).
 *   - Any other top-level path is a shell field; the shell is always saved,
 *     so it needs no marks.
 *
 * The invariant: OVER-marking costs a few redundant page writes;
 * UNDER-marking loses edits. Anything ambiguous must resolve to `all`.
 */

import type { Patches } from 'mutative'
import type { SiteDocument } from '@core/page-tree'

export interface DirtyMarks {
  all: boolean
  pageIds: Set<string>
  componentIds: Set<string>
  layoutIds: Set<string>
}

export function emptyDirtyMarks(): DirtyMarks {
  return { all: false, pageIds: new Set(), componentIds: new Set(), layoutIds: new Set() }
}

const TRACKED_COLLECTIONS = ['pages', 'visualComponents', 'layouts'] as const
type TrackedCollection = (typeof TRACKED_COLLECTIONS)[number]

function marksSetFor(marks: DirtyMarks, head: TrackedCollection): Set<string> {
  if (head === 'pages') return marks.pageIds
  if (head === 'visualComponents') return marks.componentIds
  return marks.layoutIds
}

/** Derive dirty marks from one mutation's site-relative patches. */
export function collectDirtyFromSitePatches(
  patches: Patches,
  postSite: SiteDocument,
): DirtyMarks {
  const marks = emptyDirtyMarks()
  for (const patch of patches) {
    const head = patch.path[0]
    if (!TRACKED_COLLECTIONS.includes(head as TrackedCollection)) continue // shell field — always saved
    const collection = head as TrackedCollection

    if (patch.path.length === 1) {
      // Wholesale array replacement (e.g. an import recipe) — can't attribute.
      marks.all = true
      continue
    }
    const index = patch.path[1]
    if (index === 'length') continue // array bookkeeping; roster conveys removals
    if (typeof index !== 'number') {
      marks.all = true
      continue
    }
    if (patch.op === 'remove' && patch.path.length === 2) {
      continue // element removal; roster conveys it
    }
    const element = postSite[collection][index]
    if (!element) {
      // Index doesn't resolve post-mutation (unexpected op ordering) —
      // attribute conservatively.
      marks.all = true
      continue
    }
    marksSetFor(marks, collection).add(element.id)
  }
  return marks
}

/** Merge `incoming` into a draft's accumulated dirty state, in place. */
export function mergeDirtyMarks(target: DirtyMarks, incoming: DirtyMarks): void {
  if (incoming.all) target.all = true
  for (const id of incoming.pageIds) target.pageIds.add(id)
  for (const id of incoming.componentIds) target.componentIds.add(id)
  for (const id of incoming.layoutIds) target.layoutIds.add(id)
}
