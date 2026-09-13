/**
 * Fork a branch — copy a branch's whole content (every entity kind, through
 * its adapter) under a new branch id and record the merge bases.
 *
 * Bases are MAIN's content at fork time, whatever the branch was forked
 * from: merges and updates always compare against main, so a branch forked
 * off another branch must still see everything the parent added as its own
 * changes. Entities that only exist on the parent get no base (they become
 * "create" on merge).
 *
 * Runs as ONE transaction so a half-copied branch can never exist. Media,
 * plugins, users, versions, and redirects are shared with — or belong to —
 * main and are never copied. Collab blobs are not copied either: the relay
 * seeds a branch doc from its row JSON the first time someone opens it.
 */
import type { SiteBranch } from '@core/branches'
import type { DbClient } from '../db/client'
import { insertBranch } from '../repositories/branches'
import { upsertBranchBases, type BranchBase } from '../repositories/branchBases'
import { contentHash } from './contentHash'
import { ENTITY_KINDS, adapterFor, collectBranchEntities, entitySource } from './entities'
import { MAIN_SCOPE, type BranchScope } from './scope'
import { runPublishFlush } from '../publish/publishFlush'
import { serializeCollabAwareWrite } from '../repositories/rowWriteEvents'

export interface ForkBranchInput {
  id: string
  name: string
  fromBranchId: string
  createdByUserId: string | null
}

export async function forkBranch(db: DbClient, input: ForkBranchInput): Promise<SiteBranch> {
  const from: BranchScope = { branchId: input.fromBranchId }
  const to: BranchScope = { branchId: input.id }

  // Live editors hold edits in the relay's debounce window: persist them so
  // the copy — and the bases read from main — see exactly what people see,
  // and hold the collab-aware lane so no persist lands between the two.
  await runPublishFlush()
  return serializeCollabAwareWrite(() => db.transaction(async (tx) => {
    const branch = await insertBranch(tx, {
      id: input.id,
      name: input.name,
      baseBranchId: input.fromBranchId,
      createdByUserId: input.createdByUserId,
    })

    const source = entitySource(tx, from)
    for (const kind of ENTITY_KINDS) await adapterFor(kind).copy(source, to)

    const mainEntities = await collectBranchEntities(tx, MAIN_SCOPE)
    const bases: BranchBase[] = [...mainEntities.values()].map((entity) => ({
      kind: entity.kind,
      logicalId: entity.logicalId,
      contentHash: contentHash(entity.content),
      content: entity.content,
    }))
    await upsertBranchBases(tx, to.branchId, bases)
    return branch
  }))
}
