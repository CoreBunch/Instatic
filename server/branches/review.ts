/**
 * Merge review — the request/decline/comment lifecycle around a branch's
 * merge, and the branch content hash that tells whether a request is
 * still about what the branch holds now.
 *
 * Who may do what is decided in the handler; this module only holds the
 * rules that do not depend on the caller: one open request per branch, a
 * decline needs a note, a merge closes the open request.
 */
import type { BranchMergeRequest, BranchReviewComment, BranchReviewState, SiteBranch } from '@core/branches'
import { createHash } from 'node:crypto'
import type { DbClient } from '../db/client'
import { contentHash } from './contentHash'
import { runPublishFlush } from '../publish/publishFlush'
import { collectBranchEntities } from './entities'
import { getLatestBranchMerge } from '../repositories/branchMerges'
import {
  closeOpenMergeRequests,
  getLatestMergeRequest,
  getOpenMergeRequest,
  insertMergeRequest,
  insertReviewComment,
  listReviewComments,
} from '../repositories/branchReviews'

export class MergeRequestAlreadyOpenError extends Error {
  constructor() {
    super('This branch already has an open merge request')
    this.name = 'MergeRequestAlreadyOpenError'
  }
}

export class NoOpenMergeRequestError extends Error {
  constructor() {
    super('This branch has no open merge request')
    this.name = 'NoOpenMergeRequestError'
  }
}

/**
 * One hash over every entity of the branch. A request records it; when the
 * branch's hash differs later, the request is about an older draft.
 */
export async function branchContentHash(db: DbClient, branchId: string): Promise<string> {
  const entities = await collectBranchEntities(db, { branchId })
  const digest = createHash('sha256')
  for (const key of [...entities.keys()].sort()) {
    digest.update(key).update('\n').update(contentHash(entities.get(key)!.content)).update('\n')
  }
  return digest.digest('hex')
}

export async function readBranchReviewState(db: DbClient, branch: SiteBranch): Promise<BranchReviewState> {
  // Same reason as the plan: the hash must see what the editors see.
  await runPublishFlush()
  const [request, comments, hash, lastMerge] = await Promise.all([
    getLatestMergeRequest(db, branch.id),
    listReviewComments(db, branch.id),
    branchContentHash(db, branch.id),
    getLatestBranchMerge(db, branch.id, 'merge'),
  ])
  return { branch, request, comments, contentHash: hash, lastMerge }
}

/** True when the error is the partial unique index on open requests firing. */
function isOpenRequestUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : ''
  return /site_branch_merge_requests_open_idx|unique constraint failed: site_branch_merge_requests/i.test(message)
}

export async function openMergeRequest(
  db: DbClient,
  input: { branchId: string; requestedByUserId: string; note: string },
): Promise<BranchMergeRequest> {
  if (await getOpenMergeRequest(db, input.branchId)) throw new MergeRequestAlreadyOpenError()
  // Live editors hold edits in the relay's debounce window; the hash the
  // request records must cover them.
  await runPublishFlush()
  try {
    return await insertMergeRequest(db, {
      branchId: input.branchId,
      requestedByUserId: input.requestedByUserId,
      note: input.note.trim(),
      contentHash: await branchContentHash(db, input.branchId),
    })
  } catch (err) {
    // Two requests raced past the check above; the index keeps one.
    if (isOpenRequestUniqueViolation(err)) throw new MergeRequestAlreadyOpenError()
    throw err
  }
}

export async function closeMergeRequest(
  db: DbClient,
  branchId: string,
  input: { status: 'declined' | 'merged' | 'withdrawn'; resolvedByUserId: string | null; note: string },
): Promise<BranchMergeRequest> {
  const closed = await closeOpenMergeRequests(db, branchId, {
    status: input.status,
    resolvedByUserId: input.resolvedByUserId,
    resolutionNote: input.note.trim(),
  })
  if (!closed) throw new NoOpenMergeRequestError()
  return closed
}

/** A merge closes the open request as merged; nothing happens without one. */
export async function markMergeRequestMerged(
  db: DbClient,
  branchId: string,
  resolvedByUserId: string | null,
): Promise<BranchMergeRequest | null> {
  return closeOpenMergeRequests(db, branchId, { status: 'merged', resolvedByUserId, resolutionNote: '' })
}

export async function addReviewComment(
  db: DbClient,
  input: { branchId: string; authorUserId: string; entityKey: string; body: string },
): Promise<BranchReviewComment> {
  const open = await getOpenMergeRequest(db, input.branchId)
  return insertReviewComment(db, {
    branchId: input.branchId,
    requestId: open?.id ?? null,
    entityKey: input.entityKey,
    authorUserId: input.authorUserId,
    body: input.body.trim(),
  })
}
