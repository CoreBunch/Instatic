/**
 * Patch-derived save-dirty tracking.
 *
 * Every undoable mutation already produces site-relative Mutative patches
 * (for undo history); this module reuses them to answer "which pages,
 * Visual Components, and saved layouts changed — and which were DELETED —
 * since the last successful save", so autosave can ship
 * `{ changedPages, deletedPageIds }` instead of the whole roster.
 *
 * Write attribution (paths are relative to the SiteDocument):
 *   - `['pages', i, …]` / `['visualComponents', i, …]` / `['layouts', i, …]`
 *     → the POST-mutation element at index `i` is dirty. Post-state indexing
 *     is correct for every op that leaves an element at that index (add,
 *     replace, nested edits); reorders mark each displaced index —
 *     over-marking, which is safe.
 *   - `['pages']` wholesale replacement, an index that doesn't resolve in the
 *     post-state, or any unrecognised shape → `all` (conservative full save,
 *     shipped as a replace-mode save).
 *   - Any other top-level path is a shell field; the shell is always saved,
 *     so it needs no marks.
 *
 * Deletion attribution deliberately does NOT read patch shapes. Array
 * removal produces different patch sets depending on how the recipe mutated
 * (splice → shifted-index replaces + length op; filter-reassign → wholesale
 * replace), so per-patch attribution of "which row disappeared" is fragile.
 * Instead, when the patch set contains any op that can change a collection's
 * membership (an op at collection depth ≤ 2, a `length` bookkeeping op, or
 * any `remove`), the collector diffs the PRE vs POST id sets of that
 * collection — O(collection) only on membership-shaped mutations, never on
 * plain prop edits, and robust to every recipe style.
 *
 * The invariant: OVER-marking costs a few redundant page writes;
 * UNDER-marking loses edits. Anything ambiguous must resolve to `all`.
 * Deleted-vs-written netting for one row (delete then re-create in the same
 * save window) happens at snapshot time in the save-tracking slice — a row
 * that exists in the store at snapshot time is never shipped as deleted, and
 * a write-mark for a row that no longer exists is dropped.
 */

import type { Patches } from 'mutative'
import type { SiteDocument } from '@core/page-tree'

export interface DirtyMarks {
  all: boolean
  pageIds: Set<string>
  componentIds: Set<string>
  layoutIds: Set<string>
  deletedPageIds: Set<string>
  deletedComponentIds: Set<string>
  deletedLayoutIds: Set<string>
}

export function emptyDirtyMarks(): DirtyMarks {
  return {
    all: false,
    pageIds: new Set(),
    componentIds: new Set(),
    layoutIds: new Set(),
    deletedPageIds: new Set(),
    deletedComponentIds: new Set(),
    deletedLayoutIds: new Set(),
  }
}

const TRACKED_COLLECTIONS = ['pages', 'visualComponents', 'layouts'] as const
type TrackedCollection = (typeof TRACKED_COLLECTIONS)[number]

function writeSetFor(marks: DirtyMarks, head: TrackedCollection): Set<string> {
  if (head === 'pages') return marks.pageIds
  if (head === 'visualComponents') return marks.componentIds
  return marks.layoutIds
}

function deleteSetFor(marks: DirtyMarks, head: TrackedCollection): Set<string> {
  if (head === 'pages') return marks.deletedPageIds
  if (head === 'visualComponents') return marks.deletedComponentIds
  return marks.deletedLayoutIds
}

/**
 * Diff a collection's pre/post membership: ids present before and gone after
 * are deletions; ids present after but not before are creations (marked as
 * writes — the post-index attribution usually catches them too; the set
 * union is idempotent).
 */
function diffCollectionMembership(
  marks: DirtyMarks,
  collection: TrackedCollection,
  preSite: SiteDocument,
  postSite: SiteDocument,
): void {
  const preIds = new Set(preSite[collection].map((item) => item.id))
  const postIds = new Set(postSite[collection].map((item) => item.id))
  for (const id of preIds) {
    if (!postIds.has(id)) deleteSetFor(marks, collection).add(id)
  }
  for (const id of postIds) {
    if (!preIds.has(id)) writeSetFor(marks, collection).add(id)
  }
}

/**
 * True when a patch on `collection` can change its membership (not just a
 * nested prop). Array membership only changes through ops on the array
 * itself — whole-array replace (depth 1), an index slot, or the `length`
 * bookkeeping (depth 2). Deeper ops (e.g. removing a node key inside a
 * page's node map) never change which rows exist, so they must not trigger
 * the O(collection) id diff on the hot node-edit path.
 */
function isMembershipShapedOp(patch: Patches[number]): boolean {
  return patch.path.length <= 2
}

/** Derive dirty marks from one mutation's site-relative patches. */
export function collectDirtyFromSitePatches(
  patches: Patches,
  preSite: SiteDocument,
  postSite: SiteDocument,
): DirtyMarks {
  const marks = emptyDirtyMarks()
  const membershipDiffed = new Set<TrackedCollection>()

  for (const patch of patches) {
    const head = patch.path[0]
    if (!TRACKED_COLLECTIONS.includes(head as TrackedCollection)) continue // shell field — always saved
    const collection = head as TrackedCollection

    // Membership-shaped ops → pre/post id-set diff, once per collection.
    if (isMembershipShapedOp(patch) && !membershipDiffed.has(collection)) {
      membershipDiffed.add(collection)
      diffCollectionMembership(marks, collection, preSite, postSite)
    }

    if (patch.path.length === 1) {
      // Wholesale array replacement (e.g. an import recipe) — membership was
      // diffed above, but the surviving rows' contents may ALSO have changed
      // wholesale; attribute conservatively.
      marks.all = true
      continue
    }
    const index = patch.path[1]
    if (index === 'length') continue // array bookkeeping; membership diff covers it
    if (typeof index !== 'number') {
      marks.all = true
      continue
    }
    if (patch.op === 'remove' && patch.path.length === 2) {
      continue // element removal; membership diff covers it
    }
    const element = postSite[collection][index]
    if (!element) {
      // Index doesn't resolve post-mutation (unexpected op ordering) —
      // attribute conservatively.
      marks.all = true
      continue
    }
    writeSetFor(marks, collection).add(element.id)
  }
  return marks
}

/** Merge `incoming` into a draft's accumulated dirty state, in place. */
export function mergeDirtyMarks(target: DirtyMarks, incoming: DirtyMarks): void {
  if (incoming.all) target.all = true
  for (const id of incoming.pageIds) target.pageIds.add(id)
  for (const id of incoming.componentIds) target.componentIds.add(id)
  for (const id of incoming.layoutIds) target.layoutIds.add(id)
  for (const id of incoming.deletedPageIds) target.deletedPageIds.add(id)
  for (const id of incoming.deletedComponentIds) target.deletedComponentIds.add(id)
  for (const id of incoming.deletedLayoutIds) target.deletedLayoutIds.add(id)
}
