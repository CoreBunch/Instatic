/**
 * Merge requests and review comments on a branch —
 * `site_branch_merge_requests` and `site_branch_review_comments`.
 *
 * A request is the "please merge this" object: one may be open per branch
 * at a time, and it ends as merged, declined, or withdrawn. Comments belong
 * to the branch (they outlive a declined request) and name the change they
 * are about through `entity_key` (`''` is the request itself). Both tables
 * cascade with the branch.
 */
import { nanoid } from 'nanoid'

/**
 * Time-sortable ids: comments and requests are listed in creation order,
 * and two rows written in the same millisecond must still sort the way they
 * were written. The process counter breaks that tie; the random tail keeps
 * ids unguessable across processes.
 */
let idCounter = 0
function sortableId(): string {
  idCounter = (idCounter + 1) % 46_656
  return `${Date.now().toString(36).padStart(9, '0')}${idCounter.toString(36).padStart(3, '0')}${nanoid(8)}`
}
import type { BranchMergeRequest, BranchReviewComment, MergeRequestStatus, ReviewUserLabel } from '@core/branches'
import { isoDate, isoDateOrNull } from '@core/utils/isoDate'
import { placeholder, type DbClient } from '../db/client'
import { computeGravatarHash } from './users'

interface UserLabelColumns {
  user_id: string | null
  user_email: string | null
  user_display_name: string | null
  user_avatar_path: string | null
}

interface RequestRow {
  id: string
  branch_id: string
  note: string
  content_hash: string
  status: MergeRequestStatus
  resolved_at: string | Date | null
  resolution_note: string
  created_at: string | Date
  updated_at: string | Date
  requester_id: string | null
  requester_email: string | null
  requester_display_name: string | null
  requester_avatar_path: string | null
  resolver_id: string | null
  resolver_email: string | null
  resolver_display_name: string | null
  resolver_avatar_path: string | null
}

interface CommentRow extends UserLabelColumns {
  id: string
  branch_id: string
  request_id: string | null
  entity_key: string
  body: string
  created_at: string | Date
}

function userLabel(id: string | null, email: string | null, displayName: string | null, avatarPath: string | null): ReviewUserLabel | null {
  if (!id || !email) return null
  return {
    id,
    email,
    displayName: displayName?.trim() || email,
    avatarUrl: avatarPath ?? null,
    gravatarHash: computeGravatarHash(email),
  }
}

function mapRequest(row: RequestRow): BranchMergeRequest {
  return {
    id: row.id,
    branchId: row.branch_id,
    requestedBy: userLabel(row.requester_id, row.requester_email, row.requester_display_name, row.requester_avatar_path),
    note: row.note,
    contentHash: row.content_hash,
    status: row.status,
    resolvedBy: userLabel(row.resolver_id, row.resolver_email, row.resolver_display_name, row.resolver_avatar_path),
    resolvedAt: isoDateOrNull(row.resolved_at),
    resolutionNote: row.resolution_note,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  }
}

const REQUEST_SELECT = `
  select r.id, r.branch_id, r.note, r.content_hash, r.status, r.resolved_at, r.resolution_note,
         r.created_at, r.updated_at,
         requester.id as requester_id, requester.email as requester_email,
         requester.display_name as requester_display_name, requester_media.public_path as requester_avatar_path,
         resolver.id as resolver_id, resolver.email as resolver_email,
         resolver.display_name as resolver_display_name, resolver_media.public_path as resolver_avatar_path
  from site_branch_merge_requests r
  left join users requester on requester.id = r.requested_by_user_id
  left join media_assets requester_media on requester_media.id = requester.avatar_media_id
  left join users resolver on resolver.id = r.resolved_by_user_id
  left join media_assets resolver_media on resolver_media.id = resolver.avatar_media_id
`

/**
 * Run the joined request select with a trailing clause. The clause uses
 * `placeholder(db.dialect, n)` so the one SQL string runs on both dialects.
 */
async function selectRequests(db: DbClient, clause: string, params: unknown[]): Promise<BranchMergeRequest[]> {
  const { rows } = await db.unsafe<RequestRow>(`${REQUEST_SELECT} ${clause}`, params)
  return rows.map(mapRequest)
}

/** The newest request on the branch, whatever its status. */
export async function getLatestMergeRequest(db: DbClient, branchId: string): Promise<BranchMergeRequest | null> {
  const rows = await selectRequests(
    db,
    `where r.branch_id = ${placeholder(db.dialect, 1)} order by r.created_at desc, r.id desc limit 1`,
    [branchId],
  )
  return rows[0] ?? null
}

export async function getOpenMergeRequest(db: DbClient, branchId: string): Promise<BranchMergeRequest | null> {
  const rows = await selectRequests(
    db,
    `where r.branch_id = ${placeholder(db.dialect, 1)} and r.status = 'open' order by r.created_at desc, r.id desc limit 1`,
    [branchId],
  )
  return rows[0] ?? null
}

export async function getMergeRequestById(db: DbClient, id: string): Promise<BranchMergeRequest | null> {
  const rows = await selectRequests(db, `where r.id = ${placeholder(db.dialect, 1)} limit 1`, [id])
  return rows[0] ?? null
}

export async function insertMergeRequest(
  db: DbClient,
  input: { branchId: string; requestedByUserId: string; note: string; contentHash: string },
): Promise<BranchMergeRequest> {
  const id = sortableId()
  await db`
    insert into site_branch_merge_requests (id, branch_id, requested_by_user_id, note, content_hash, status)
    values (${id}, ${input.branchId}, ${input.requestedByUserId}, ${input.note}, ${input.contentHash}, 'open')
  `
  const request = await getMergeRequestById(db, id)
  if (!request) throw new Error('[branches] merge request vanished after insert')
  return request
}

/** Close the request; returns null when it is not open any more. */
export async function resolveMergeRequest(
  db: DbClient,
  id: string,
  input: { status: Exclude<MergeRequestStatus, 'open'>; resolvedByUserId: string | null; resolutionNote: string },
): Promise<BranchMergeRequest | null> {
  const { rows } = await db<{ id: string }>`
    update site_branch_merge_requests
    set status = ${input.status},
        resolved_by_user_id = ${input.resolvedByUserId},
        resolved_at = current_timestamp,
        resolution_note = ${input.resolutionNote},
        updated_at = current_timestamp
    where id = ${id}
      and status = 'open'
    returning id
  `
  if (rows.length === 0) return null
  return getMergeRequestById(db, id)
}

function mapComment(row: CommentRow): BranchReviewComment {
  return {
    id: row.id,
    branchId: row.branch_id,
    requestId: row.request_id ?? null,
    entityKey: row.entity_key,
    author: userLabel(row.user_id, row.user_email, row.user_display_name, row.user_avatar_path),
    body: row.body,
    createdAt: isoDate(row.created_at),
  }
}

const COMMENT_SELECT = `
  select c.id, c.branch_id, c.request_id, c.entity_key, c.body, c.created_at,
         u.id as user_id, u.email as user_email, u.display_name as user_display_name,
         m.public_path as user_avatar_path
  from site_branch_review_comments c
  left join users u on u.id = c.author_user_id
  left join media_assets m on m.id = u.avatar_media_id
`

async function selectComments(db: DbClient, clause: string, params: unknown[]): Promise<BranchReviewComment[]> {
  const { rows } = await db.unsafe<CommentRow>(`${COMMENT_SELECT} ${clause}`, params)
  return rows.map(mapComment)
}

export async function listReviewComments(db: DbClient, branchId: string): Promise<BranchReviewComment[]> {
  return selectComments(
    db,
    `where c.branch_id = ${placeholder(db.dialect, 1)} order by c.created_at asc, c.id asc`,
    [branchId],
  )
}

export async function insertReviewComment(
  db: DbClient,
  input: { branchId: string; requestId: string | null; entityKey: string; authorUserId: string; body: string },
): Promise<BranchReviewComment> {
  const id = sortableId()
  await db`
    insert into site_branch_review_comments (id, branch_id, request_id, entity_key, author_user_id, body)
    values (${id}, ${input.branchId}, ${input.requestId}, ${input.entityKey}, ${input.authorUserId}, ${input.body})
  `
  const [comment] = await selectComments(db, `where c.id = ${placeholder(db.dialect, 1)} limit 1`, [id])
  if (!comment) throw new Error('[branches] review comment vanished after insert')
  return comment
}
