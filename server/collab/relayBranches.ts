/**
 * Relay branch admission — which branches the relay mints documents for.
 *
 * A collab doc id names a branch, and a client must never be able to mint
 * documents — and through them rows — for a branch that was never created
 * or that has been deleted. The registry is read once per branch and the
 * positive answer cached. A deleted branch is tombstoned through `forget`
 * BEFORE its rows go, so a socket rebinding during the delete transaction
 * (while the registry row still exists) is refused instead of reseeding
 * rows that are about to vanish.
 *
 * `remember` lifts the tombstone when the id is forked again, or when a
 * delete failed after tombstoning. A tombstoned branch is revived through a
 * caller-supplied step (the relay purges its stored blobs, so the next open
 * reseeds from the rows) that runs UNDER the tombstone. When that step fails
 * — typically the same database outage that failed the delete — the branch
 * stays refused and every later `admits` retries the step, single-flight,
 * until it succeeds; a branch is never left tombstoned for good.
 */
import { MAIN_BRANCH_ID } from '@core/branches'
import { parseCollabDocId } from '@core/collab'
import type { DbClient } from '../db/client'
import { branchExists } from '../repositories/branches'

/** Thrown by the relay's `openDoc` for a doc whose branch does not exist (or was deleted). */
export class BranchGoneError extends Error {
  readonly branchId: string

  constructor(branchId: string, docId: string) {
    super(`[collab] branch "${branchId}" is gone; refusing doc ${docId}`)
    this.name = 'BranchGoneError'
    this.branchId = branchId
  }
}

export interface RelayBranchAdmission {
  /** True when the branch exists and is not tombstoned. Reads the registry at most once per branch. */
  admits(branchId: string): Promise<boolean>
  /** True once `forget` tombstoned the branch — no registry read. */
  forgotten(branchId: string): boolean
  /** `forgotten` for a doc id: true when the doc names a tombstoned branch. */
  docForgotten(docId: string): boolean
  forget(branchId: string): void
  /**
   * Accept the branch again. A tombstoned branch first runs `revive` under
   * the tombstone; on failure it stays refused and `admits` retries. Never
   * throws — a failed attempt is logged.
   */
  remember(branchId: string, revive: () => Promise<void>): Promise<void>
}

export function createRelayBranchAdmission(db: DbClient): RelayBranchAdmission {
  const confirmed = new Set<string>([MAIN_BRANCH_ID])
  const tombstoned = new Set<string>()
  /** Tombstoned branches waiting for their revive step to succeed. */
  const reviving = new Map<string, () => Promise<void>>()
  const reviveAttempts = new Map<string, Promise<boolean>>()

  function revive(branchId: string): Promise<boolean> {
    const step = reviving.get(branchId)
    if (!step) return Promise.resolve(!tombstoned.has(branchId))
    const running = reviveAttempts.get(branchId)
    if (running) return running
    const attempt = (async () => {
      try {
        await step()
      } catch (err) {
        console.error(`[collab] reviving branch "${branchId}" failed; it stays refused until the next attempt:`, err)
        return false
      } finally {
        reviveAttempts.delete(branchId)
      }
      // A `forget` during the step wins: the branch stays tombstoned.
      if (reviving.get(branchId) !== step) return false
      reviving.delete(branchId)
      // The caller believes the delete failed; the registry has the last word.
      if (!(await branchExists(db, branchId))) return false
      tombstoned.delete(branchId)
      confirmed.add(branchId)
      return true
    })()
    reviveAttempts.set(branchId, attempt)
    return attempt
  }

  return {
    async admits(branchId) {
      if (tombstoned.has(branchId)) return revive(branchId)
      if (confirmed.has(branchId)) return true
      if (!(await branchExists(db, branchId))) return false
      confirmed.add(branchId)
      return true
    },
    forgotten: (branchId) => tombstoned.has(branchId),
    docForgotten(docId) {
      const parsed = parseCollabDocId(docId)
      return parsed !== null && tombstoned.has(parsed.branchId)
    },
    forget(branchId) {
      tombstoned.add(branchId)
      confirmed.delete(branchId)
      reviving.delete(branchId)
    },
    async remember(branchId, step) {
      if (!tombstoned.has(branchId)) {
        confirmed.add(branchId)
        return
      }
      reviving.set(branchId, step)
      await revive(branchId)
    },
  }
}
