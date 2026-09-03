/**
 * Invalidation markers — which docs an out-of-relay write has invalidated,
 * and the version each was invalidated at.
 *
 * `activate` runs synchronously with the post-commit notification and marks
 * the docs; the reset batch that follows `finish`es the versions it owned.
 * In between, a persist of a marked doc writes its blob but skips the derived
 * row JSON (`persistNow` reports "superseded"): the queued reset is
 * authoritative. Every marker must therefore be released by exactly one
 * path — `finish` when the reset ran, or `release` / `releaseBranch` when the
 * reset was dropped for a tombstoned branch. A marker nothing releases would
 * make every persist after the branch is admitted again report "superseded":
 * blob written, row JSON never.
 */
import { parseCollabDocId } from '@core/collab'

export interface InvalidationTracker {
  /** Mark docs invalidated at a fresh version; returns the versions this batch owns. */
  activate(docIds: readonly string[]): Map<string, number>
  /** A reset batch completed: clear the active marker of every doc it still owns. */
  finish(owned: ReadonlyMap<string, number>): void
  /** Drop one doc's marker outright (its reset was dropped). */
  release(docId: string): void
  /** Drop every marker held by a branch's docs. */
  releaseBranch(branchId: string): void
  /** The version a doc was last invalidated at; 0 when never. */
  version(docId: string): number
  /** True while a reset owning the doc's marker has not finished. */
  isActive(docId: string): boolean
  /** The latest version handed out — the cutoff a persist snapshot is taken at. */
  cutoff(): number
}

/** `skip` names docs that must never receive a marker (a tombstoned branch's). */
export function createInvalidationTracker(skip: (docId: string) => boolean): InvalidationTracker {
  const versions = new Map<string, number>()
  const active = new Set<string>()
  let next = 0

  function release(docId: string): void {
    versions.delete(docId)
    active.delete(docId)
  }

  return {
    activate(docIds) {
      const owned = new Map<string, number>()
      const version = ++next
      for (const docId of docIds) {
        if (skip(docId)) continue
        versions.set(docId, version)
        active.add(docId)
        owned.set(docId, version)
      }
      return owned
    },
    finish(owned) {
      for (const [docId, version] of owned) {
        // A newer activation still owns the active marker.
        if ((versions.get(docId) ?? 0) === version) active.delete(docId)
      }
    },
    release,
    releaseBranch(branchId) {
      for (const docId of [...versions.keys()]) {
        if (parseCollabDocId(docId)?.branchId === branchId) release(docId)
      }
    },
    version: (docId) => versions.get(docId) ?? 0,
    isActive: (docId) => active.has(docId),
    cutoff: () => next,
  }
}
