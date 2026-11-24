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
import { isoDate, isoDateOrNull, nowIso } from '@core/utils/isoDate'
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
  assignee_account_id: string | null
  assignee_label: string
  assignee_owner_id: string
  resolved_at: string | null
  resolved_by_user_id: string | null
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
  const now = nowIso()
  await db`
    insert into site_branch_merge_requests (id, branch_id, requested_by_user_id, note, content_hash, status, created_at, updated_at)
    values (${id}, ${input.branchId}, ${input.requestedByUserId}, ${input.note}, ${input.contentHash}, 'open', ${now}, ${now})
  `
  const request = await getMergeRequestById(db, id)
  if (!request) throw new Error('[branches] merge request vanished after insert')
  return request
}

/**
 * Close every open request on the branch (there should be one; a race that
 * produced two must not leave a stray one open). Returns the newest closed
 * request, or null when none was open.
 */
export async function closeOpenMergeRequests(
  db: DbClient,
  branchId: string,
  input: { status: Exclude<MergeRequestStatus, 'open'>; resolvedByUserId: string | null; resolutionNote: string },
): Promise<BranchMergeRequest | null> {
  const now = nowIso()
  const { rows } = await db<{ id: string }>`
    update site_branch_merge_requests
    set status = ${input.status},
        resolved_by_user_id = ${input.resolvedByUserId},
        resolved_at = ${now},
        resolution_note = ${input.resolutionNote},
        updated_at = ${now}
    where branch_id = ${branchId}
      and status = 'open'
    returning id
  `
  if (rows.length === 0) return null
  const closed = await Promise.all(rows.map((row) => getMergeRequestById(db, row.id)))
  return closed
    .filter((request): request is BranchMergeRequest => request !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null
}

function mapComment(row: CommentRow): BranchReviewComment {
  return {
    id: row.id,
    branchId: row.branch_id,
    requestId: row.request_id ?? null,
    entityKey: row.entity_key,
    author: userLabel(row.user_id, row.user_email, row.user_display_name, row.user_avatar_path),
    assignedTo: row.assignee_account_id ? { accountId: row.assignee_account_id, label: row.assignee_label, ownerId: row.assignee_owner_id } : null,
    resolvedAt: row.resolved_at,
    resolvedByUserId: row.resolved_by_user_id,
    body: row.body,
    createdAt: isoDate(row.created_at),
  }
}

const COMMENT_SELECT = `
  select c.id, c.branch_id, c.request_id, c.entity_key, c.body, c.created_at,
         c.assignee_account_id, a.label as assignee_label, a.owner_id as assignee_owner_id, c.resolved_at, c.resolved_by_user_id,
         u.id as user_id, u.email as user_email, u.display_name as user_display_name,
         m.public_path as user_avatar_path
  from site_branch_review_comments c
  left join service_accounts a on a.id = c.assignee_account_id
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
  input: { branchId: string; requestId: string | null; entityKey: string; authorUserId: string; body: string; assigneeAccountId?: string },
): Promise<BranchReviewComment> {
  const id = sortableId()
  await db`
    insert into site_branch_review_comments (id, branch_id, request_id, entity_key, author_user_id, body, created_at, assignee_account_id)
    values (${id}, ${input.branchId}, ${input.requestId}, ${input.entityKey}, ${input.authorUserId}, ${input.body}, ${nowIso()}, ${input.assigneeAccountId ?? null})
  `
  const [comment] = await selectComments(db, `where c.id = ${placeholder(db.dialect, 1)} limit 1`, [id])
  if (!comment) throw new Error('[branches] review comment vanished after insert')
  return comment
}

/** Only the author or the assigned agent's sponsoring branch operator may close its correction. */
export async function resolveAssignedComment(db: DbClient, branchId: string, commentId: string, reviewer: string, owner: string | null) {
  const result = await db`update site_branch_review_comments set resolved_at = ${nowIso()}, resolved_by_user_id = ${reviewer}
    where id = ${commentId} and branch_id = ${branchId} and resolved_at is null and assignee_account_id is not null
      and (author_user_id = ${reviewer} or assignee_account_id in (select id from service_accounts where owner_id = ${owner}))`
  if (!result.rowCount) return null
  const [comment] = await selectComments(db, `where c.id = ${placeholder(db.dialect, 1)}`, [commentId])
  return comment
}

export async function listReviewAssignees(db: DbClient, branchId: string, owner: string | null, run: string | null) {
  if (!owner && !run) return []
  const now = nowIso()
  const { rows } = await db<{ id: string; label: string; group_label: string; run_id: string }>`
    select a.id, a.label, g.label as group_label, r.id as run_id from service_accounts a
    join service_account_runs r on r.id = a.group_run_id join service_account_groups g on g.id = r.group_id
    where r.branch_id = ${branchId} and (r.id = ${run} or g.owner_id = ${owner})
    and r.approved_at is not null and r.revoked_at is null and r.expires_at > ${now}
    and a.revoked_at is null and a.expires_at > ${now}
    order by g.label, r.created_at desc, a.group_position`
  return rows.map(a => ({ accountId: a.id, label: a.label, groupLabel: a.group_label, runId: a.run_id }))
}

/** After an undone merge, the request that merge answered is open again. */
export async function reopenMergedRequest(db: DbClient, branchId: string): Promise<BranchMergeRequest | null> {
  const { rows } = await db<{ id: string }>`
    select id from site_branch_merge_requests
    where branch_id = ${branchId} and status = 'merged'
    order by updated_at desc
    limit 1
  `
  const id = rows[0]?.id
  if (!id) return null
  const now = nowIso()
  await db`
    update site_branch_merge_requests
    set status = 'open', resolved_by_user_id = null, resolved_at = null, resolution_note = '', updated_at = ${now}
    where id = ${id}
  `
  return getMergeRequestById(db, id)
}
