/**
 * Branch merges — `site_branch_merges`: every applied merge or update, with
 * what each touched entity looked like before it, so the whole thing can be
 * put back. One row per apply; `undone_at` marks a reversed one. The entries
 * are the server's business (they carry full entity content); the client
 * sees the record without them.
 */
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { nanoid } from 'nanoid'
import { MergeChangeSchema, type BranchMergeRecord, type MergeDirection } from '@core/branches'
import type { DbClient } from '../db/client'

/** What one entity looked like on every side before the apply wrote it. */
export const MergeUndoEntrySchema = Type.Object({
  change: MergeChangeSchema,
  /** The merge target's content before; null when the entity did not exist there. */
  intoBefore: Type.Unknown(),
  /** The other side's content before; only a merge writes that side (the mirror). */
  fromBefore: Type.Unknown(),
  /** The recorded base before; null when there was none. */
  baseBefore: Type.Unknown(),
  /** Hash of what the apply wrote on both sides; null when it deleted the entity. */
  resultHash: Type.Union([Type.String(), Type.Null()]),
})
export type MergeUndoEntry = Static<typeof MergeUndoEntrySchema>
const MergeUndoEntriesSchema = Type.Array(MergeUndoEntrySchema)

interface BranchMergeRow {
  id: string
  branch_id: string
  direction: MergeDirection
  applied_by_user_id: string | null
  change_count: number
  created_at: string | Date
  undone_at: string | Date | null
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value
}

function toRecord(row: BranchMergeRow): BranchMergeRecord {
  return {
    id: row.id,
    branchId: row.branch_id,
    direction: row.direction,
    appliedByUserId: row.applied_by_user_id,
    changeCount: row.change_count,
    createdAt: toIso(row.created_at),
    undoneAt: row.undone_at === null ? null : toIso(row.undone_at),
  }
}

export async function insertBranchMerge(
  db: DbClient,
  input: { branchId: string; direction: MergeDirection; appliedByUserId: string | null; entries: MergeUndoEntry[] },
): Promise<BranchMergeRecord> {
  const id = nanoid()
  const now = new Date().toISOString()
  await db`
    insert into site_branch_merges (id, branch_id, direction, applied_by_user_id, change_count, entries_json, created_at)
    values (${id}, ${input.branchId}, ${input.direction}, ${input.appliedByUserId}, ${input.entries.length}, ${JSON.stringify(input.entries)}, ${now})
  `
  const record = await getBranchMerge(db, id)
  if (!record) throw new Error('[branches] merge record vanished after insert')
  return record
}

export async function getBranchMerge(db: DbClient, id: string): Promise<BranchMergeRecord | null> {
  const { rows } = await db<BranchMergeRow>`
    select id, branch_id, direction, applied_by_user_id, change_count, created_at, undone_at from site_branch_merges where id = ${id}
  `
  const row = rows[0]
  return row ? toRecord(row) : null
}

/** The newest apply in the given direction that has not been undone. */
export async function getLatestBranchMerge(
  db: DbClient,
  branchId: string,
  direction: MergeDirection,
): Promise<BranchMergeRecord | null> {
  const { rows } = await db<BranchMergeRow>`
    select id, branch_id, direction, applied_by_user_id, change_count, created_at, undone_at from site_branch_merges
    where branch_id = ${branchId} and direction = ${direction} and undone_at is null
    order by created_at desc
    limit 1
  `
  const row = rows[0]
  return row ? toRecord(row) : null
}

/** The stored before-images of one apply, validated on the way out of the JSON column. */
export async function listMergeUndoEntries(db: DbClient, mergeId: string): Promise<MergeUndoEntry[]> {
  const { rows } = await db<{ entries_json: unknown }>`
    select entries_json from site_branch_merges where id = ${mergeId}
  `
  const raw = rows[0]?.entries_json
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!Value.Check(MergeUndoEntriesSchema, parsed)) {
    throw new Error(`[branches] merge ${mergeId} has unreadable undo entries`)
  }
  return parsed
}

export async function markBranchMergeUndone(db: DbClient, id: string): Promise<void> {
  const now = new Date().toISOString()
  await db`update site_branch_merges set undone_at = ${now} where id = ${id}`
}
