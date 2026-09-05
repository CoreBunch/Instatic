/**
 * Branch preview links — `site_branch_previews`.
 *
 * One ACTIVE link per branch: issuing a new one revokes the previous, so a
 * leaked link is retired by simply sharing again. Only the token's SHA-256 is
 * stored; the token itself is shown once, at creation. Rows cascade away
 * with their branch.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import { isoDate } from '@core/utils/isoDate'

export interface BranchPreview {
  id: string
  branchId: string
  createdByUserId: string | null
  createdAt: string
}

interface BranchPreviewRow {
  id: string
  branch_id: string
  created_by_user_id: string | null
  created_at: string | Date
}

function mapPreview(row: BranchPreviewRow): BranchPreview {
  return {
    id: row.id,
    branchId: row.branch_id,
    createdByUserId: row.created_by_user_id,
    createdAt: isoDate(row.created_at),
  }
}

/** Issue a link for a branch, retiring any earlier active one. */
export async function createBranchPreview(
  db: DbClient,
  input: { branchId: string; tokenHash: string; createdByUserId: string | null },
): Promise<BranchPreview> {
  return db.transaction(async (tx) => {
    await revokeBranchPreviews(tx, input.branchId)
    const { rows } = await tx<BranchPreviewRow>`
      insert into site_branch_previews (id, branch_id, token_hash, created_by_user_id)
      values (${nanoid()}, ${input.branchId}, ${input.tokenHash}, ${input.createdByUserId})
      returning id, branch_id, created_by_user_id, created_at
    `
    return mapPreview(rows[0])
  })
}

/** The branch's active link, or null when none is active. */
export async function getActiveBranchPreview(db: DbClient, branchId: string): Promise<BranchPreview | null> {
  const { rows } = await db<BranchPreviewRow>`
    select id, branch_id, created_by_user_id, created_at
    from site_branch_previews
    where branch_id = ${branchId}
      and revoked_at is null
    order by created_at desc
    limit 1
  `
  return rows[0] ? mapPreview(rows[0]) : null
}

/** The branch an active token grants access to, or null. */
export async function resolveBranchPreviewToken(db: DbClient, tokenHash: string): Promise<string | null> {
  const { rows } = await db<{ branch_id: string }>`
    select branch_id
    from site_branch_previews
    where token_hash = ${tokenHash}
      and revoked_at is null
    limit 1
  `
  return rows[0]?.branch_id ?? null
}

/** Retire every active link of a branch; returns how many were active. */
export async function revokeBranchPreviews(db: DbClient, branchId: string): Promise<number> {
  const now = new Date().toISOString()
  const { rows } = await db<{ id: string }>`
    update site_branch_previews
    set revoked_at = ${now}
    where branch_id = ${branchId}
      and revoked_at is null
    returning id
  `
  return rows.length
}
