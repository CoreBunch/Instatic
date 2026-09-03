/**
 * Fork a branch — copy a branch's whole content (shell, tables, rows) under a
 * new branch id and record the merge bases.
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
import { physicalId, SITE_SHELL_LOGICAL_ID } from '@core/branches'
import type { DataRowStatus } from '@core/data/schemas'
import type { DbClient } from '../db/client'
import { insertBranch } from '../repositories/branches'
import { upsertBranchBases, type BranchBase } from '../repositories/branchBases'
import { listDataTables } from '../repositories/data'
import { getDraftSite } from '../repositories/site'
import { contentHash } from './contentHash'
import { collectBranchEntities } from './entities'
import { MAIN_SCOPE, type BranchScope } from './scope'
import { runPublishFlush } from '../publish/publishFlush'
import { serializeCollabAwareWrite } from '../repositories/rowWriteEvents'

export interface ForkBranchInput {
  id: string
  name: string
  fromBranchId: string
  createdByUserId: string | null
}

interface RawRow {
  logical_id: string
  table_id: string
  cells_json: Record<string, unknown>
  slug: string
  status: DataRowStatus
  author_user_id: string | null
  created_by_user_id: string | null
  updated_by_user_id: string | null
  published_by_user_id: string | null
  plugin_actor_id: string | null
  created_at: string | Date
  updated_at: string | Date
  published_at: string | Date | null
}

/**
 * A scheduled row cannot stay scheduled on a branch — only main publishes —
 * so it lands as a draft; every other status is informational ("live on
 * main") and survives the copy.
 */
function branchStatus(status: DataRowStatus): DataRowStatus {
  return status === 'scheduled' ? 'draft' : status
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

    // Shell — one row, copied with a fresh seq.
    const shell = await getDraftSite(tx, from)
    if (shell) {
      await tx`
        insert into site (id, name, settings_json, seq, branch_id)
        select ${physicalId(to.branchId, SITE_SHELL_LOGICAL_ID)}, name, settings_json, 0,
               ${to.branchId}
        from site
        where branch_id = ${from.branchId}
      `
    }

    // Tables — the physical key is minted per row in TS (the single scheme).
    const tables = await listDataTables(tx, from)
    const tablePhysicalIds = new Map<string, string>()
    for (const table of tables) {
      const physical = physicalId(to.branchId, table.id)
      tablePhysicalIds.set(physicalId(from.branchId, table.id), physical)
      await tx`
        insert into data_tables (
          id, branch_id, name, slug, kind, route_base, singular_label,
          plural_label, primary_field_id, fields_json, system,
          created_by_user_id, updated_by_user_id, created_at, updated_at
        )
        select ${physical}, ${to.branchId}, name, slug, kind, route_base,
               singular_label, plural_label, primary_field_id, fields_json, system,
               created_by_user_id, updated_by_user_id, created_at, updated_at
        from data_tables
        where id = ${physicalId(from.branchId, table.id)}
      `
    }

    // Rows — live rows only; versions, schedules, and seqs do not cross.
    const { rows } = await tx<RawRow>`
      select logical_id, table_id, cells_json, slug, status,
             author_user_id, created_by_user_id, updated_by_user_id, published_by_user_id,
             plugin_actor_id, created_at, updated_at, published_at
      from data_rows
      where branch_id = ${from.branchId}
        and deleted_at is null
    `
    for (const row of rows) {
      const tableId = tablePhysicalIds.get(row.table_id)
      if (!tableId) continue // a row of a soft-deleted table has nowhere to go
      const status = branchStatus(row.status)
      await tx`
        insert into data_rows (
          id, branch_id, table_id, cells_json, slug, status,
          author_user_id, created_by_user_id, updated_by_user_id, published_by_user_id,
          plugin_actor_id, created_at, updated_at, published_at
        )
        values (
          ${physicalId(to.branchId, row.logical_id)}, ${to.branchId},
          ${tableId}, ${row.cells_json}, ${row.slug}, ${status},
          ${row.author_user_id}, ${row.created_by_user_id}, ${row.updated_by_user_id},
          ${row.published_by_user_id}, ${row.plugin_actor_id},
          ${row.created_at}, ${row.updated_at}, ${row.published_at}
        )
      `
    }

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
