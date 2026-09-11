/**
 * Branch bases — `site_branch_bases`: for every entity a branch shares with
 * its base, what that entity looked like when the two last agreed (fork, or
 * the latest merge/update). A base is the third side of the three-way merge;
 * the hash gives cheap "did this side move" checks, the content gives the
 * field-level merge.
 */
import type { DbClient } from '../db/client'
import type { BranchEntityKind } from '../branches/contentHash'

export interface BranchBase {
  kind: BranchEntityKind
  logicalId: string
  contentHash: string
  content: unknown
}

interface BranchBaseRow {
  kind: BranchEntityKind
  logical_id: string
  content_hash: string
  content_json: unknown
}

export async function listBranchBases(db: DbClient, branchId: string): Promise<BranchBase[]> {
  const { rows } = await db<BranchBaseRow>`
    select kind, logical_id, content_hash, content_json
    from site_branch_bases
    where branch_id = ${branchId}
  `
  return rows.map((row) => ({
    kind: row.kind,
    logicalId: row.logical_id,
    contentHash: row.content_hash,
    content: row.content_json,
  }))
}

/** Insert or replace the bases of the given entities. */
export async function upsertBranchBases(
  db: DbClient,
  branchId: string,
  bases: readonly BranchBase[],
): Promise<void> {
  for (const base of bases) {
    await db`
      insert into site_branch_bases (branch_id, kind, logical_id, content_hash, content_json)
      values (${branchId}, ${base.kind}, ${base.logicalId}, ${base.contentHash}, ${base.content})
      on conflict (branch_id, kind, logical_id) do update
        set content_hash = excluded.content_hash,
            content_json = excluded.content_json
    `
  }
}

export async function deleteBranchBases(
  db: DbClient,
  branchId: string,
  entries: ReadonlyArray<{ kind: BranchEntityKind; logicalId: string }>,
): Promise<void> {
  for (const entry of entries) {
    await db`
      delete from site_branch_bases
      where branch_id = ${branchId}
        and kind = ${entry.kind}
        and logical_id = ${entry.logicalId}
    `
  }
}
