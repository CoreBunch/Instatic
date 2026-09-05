/**
 * Site branches repository — the `site_branches` registry.
 *
 * Branch CONTENT lives in the branched tables (`site`, `data_tables`,
 * `data_rows`) addressed through `BranchScope`; this module only owns the
 * registry rows. Forking, deleting, and merging content is orchestrated by
 * `server/branches/`.
 */
import { MAIN_BRANCH_ID, type SiteBranch } from '@core/branches'
import { isoDate } from '@core/utils/isoDate'
import type { DbClient } from '../db/client'

interface SiteBranchRow {
  id: string
  name: string
  base_branch_id: string | null
  created_by_user_id: string | null
  created_at: string | Date
  updated_at: string | Date
}

function mapBranch(row: SiteBranchRow): SiteBranch {
  return {
    id: row.id,
    name: row.name,
    baseBranchId: row.base_branch_id ?? null,
    createdByUserId: row.created_by_user_id ?? null,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  }
}

/** Main first, then newest fork first. */
export async function listBranches(db: DbClient): Promise<SiteBranch[]> {
  const { rows } = await db<SiteBranchRow>`
    select id, name, base_branch_id, created_by_user_id, created_at, updated_at
    from site_branches
    order by case when id = ${MAIN_BRANCH_ID} then 0 else 1 end, created_at desc
  `
  return rows.map(mapBranch)
}

export async function getBranch(db: DbClient, id: string): Promise<SiteBranch | null> {
  const { rows } = await db<SiteBranchRow>`
    select id, name, base_branch_id, created_by_user_id, created_at, updated_at
    from site_branches
    where id = ${id}
    limit 1
  `
  return rows[0] ? mapBranch(rows[0]) : null
}

export async function branchExists(db: DbClient, id: string): Promise<boolean> {
  if (id === MAIN_BRANCH_ID) return true
  const { rows } = await db<{ id: string }>`
    select id from site_branches where id = ${id} limit 1
  `
  return rows.length > 0
}

export async function insertBranch(
  db: DbClient,
  input: { id: string; name: string; baseBranchId: string; createdByUserId: string | null },
): Promise<SiteBranch> {
  const { rows } = await db<SiteBranchRow>`
    insert into site_branches (id, name, base_branch_id, created_by_user_id)
    values (${input.id}, ${input.name}, ${input.baseBranchId}, ${input.createdByUserId})
    returning id, name, base_branch_id, created_by_user_id, created_at, updated_at
  `
  return mapBranch(rows[0])
}

export async function renameBranch(
  db: DbClient,
  id: string,
  name: string,
): Promise<SiteBranch | null> {
  const now = new Date().toISOString()
  const { rows } = await db<SiteBranchRow>`
    update site_branches
    set name = ${name},
        updated_at = ${now}
    where id = ${id}
      and id <> ${MAIN_BRANCH_ID}
    returning id, name, base_branch_id, created_by_user_id, created_at, updated_at
  `
  return rows[0] ? mapBranch(rows[0]) : null
}

export async function touchBranch(db: DbClient, id: string): Promise<void> {
  // Bound as ISO text: SQLite's `current_timestamp` is a space-separated
  // local-time string that `Date.parse` reads as local time, which showed
  // a just-merged branch as "updated 2h ago".
  const now = new Date().toISOString()
  await db`
    update site_branches
    set updated_at = ${now}
    where id = ${id}
  `
}

export async function deleteBranchRow(db: DbClient, id: string): Promise<boolean> {
  const { rows } = await db<{ id: string }>`
    delete from site_branches
    where id = ${id}
      and id <> ${MAIN_BRANCH_ID}
    returning id
  `
  return rows.length > 0
}
