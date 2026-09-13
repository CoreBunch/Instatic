/**
 * Delete a branch — drop its content (every entity kind, through its
 * adapter, rows before the tables they live in), its collab documents, and
 * its registry row (bases and preview links cascade from the registry row).
 *
 * Main can never be deleted. The relay, when supplied, tombstones the branch
 * and evicts its resident docs first so an in-flight persist cannot
 * resurrect a blob after the delete; bound sockets receive a reset, rebind,
 * are told the branch is gone, and the client falls back to main. A delete
 * that fails after that lifts the tombstone again — the rows survived, so
 * the branch must accept documents (reseeded from its rows) again.
 */
import { MAIN_BRANCH_ID } from '@core/branches'
import type { DbClient } from '../db/client'
import type { CollabRelay } from '../collab/relay'
import { deleteBranchRow } from '../repositories/branches'
import { serializeCollabAwareWrite } from '../repositories/rowWriteEvents'
import { ENTITY_KINDS, adapterFor } from './entities'

export async function deleteBranch(
  db: DbClient,
  branchId: string,
  relay: CollabRelay | null,
): Promise<boolean> {
  if (branchId === MAIN_BRANCH_ID) return false
  // Tombstone the branch in the relay BEFORE the rows go: from here on a
  // socket that rebinds is told the branch is gone instead of reseeding
  // rows that are about to be deleted. The delete itself runs on the
  // collab-aware lane so no relay persist interleaves with it.
  if (relay) await relay.forgetBranch(branchId)

  try {
    return await serializeCollabAwareWrite(() => db.transaction(async (tx) => {
      const deleted = await deleteBranchRow(tx, branchId)
      if (!deleted) return false
      for (const kind of [...ENTITY_KINDS].reverse()) await adapterFor(kind).remove(tx, branchId)
      return true
    }))
  } catch (err) {
    await relay?.rememberBranch(branchId)
    throw err
  }
}
