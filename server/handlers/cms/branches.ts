/**
 * Site branches endpoints — the branch REGISTRY. Branch content is addressed
 * through the `X-Instatic-Branch` header on the ordinary content routes
 * (see server/branches/scope.ts); nothing here reads or writes rows except
 * through the fork and delete operations.
 *
 *   GET    /admin/api/cms/branches               every branch, main first   (site.read)
 *   POST   /admin/api/cms/branches               fork a branch              (site.branches.manage)
 *   PATCH  /admin/api/cms/branches/:id           rename                     (site.branches.manage)
 *   DELETE /admin/api/cms/branches/:id           delete, discarding its work (site.branches.manage + step-up)
 *   GET    /admin/api/cms/branches/:id/preview   the active preview link    (site.read)
 *   POST   /admin/api/cms/branches/:id/preview   issue a new preview link   (site.branches.manage)
 *   DELETE /admin/api/cms/branches/:id/preview   revoke the preview link    (site.branches.manage)
 *   GET    /admin/api/cms/branches/:id/merge     plan merging into main     (site.read)
 *   POST   /admin/api/cms/branches/:id/merge     merge into main            (site.branches.manage + step-up)
 *   GET    /admin/api/cms/branches/:id/update    plan updating from main    (site.read)
 *   POST   /admin/api/cms/branches/:id/update    update from main           (site.branches.manage)
 *   GET    /admin/api/cms/branches/:id/review            request + comments + content hash (site.read)
 *   POST   /admin/api/cms/branches/:id/review/request    ask for a merge            (site.read)
 *   POST   /admin/api/cms/branches/:id/review/withdraw   withdraw the open request  (requester or site.branches.manage)
 *   POST   /admin/api/cms/branches/:id/review/decline    decline with a note        (site.branches.manage)
 *   POST   /admin/api/cms/branches/:id/review/comments   comment on a change        (site.read)
 *   GET    /admin/api/cms/branches/:id/review/render     one page as main or the branch renders it (site.read)
 *
 * Main is fixed: it cannot be renamed or deleted. Every mutation lands in
 * the audit log.
 */
import {
  ApplyMergeBodySchema,
  BRANCH_NAME_MAX_LENGTH,
  CreateBranchBodySchema,
  CreateMergeRequestBodySchema,
  CreateReviewCommentBodySchema,
  DeclineMergeRequestBodySchema,
  RenameBranchBodySchema,
  isMainBranch,
  isValidBranchId,
  slugifyBranchName,
  type MergeDirection,
} from '@core/branches'
import {
  MergeRequestAlreadyOpenError,
  NoOpenMergeRequestError,
  addReviewComment,
  closeMergeRequest,
  markMergeRequestMerged,
  openMergeRequest,
  readBranchReviewState,
} from '../../branches/review'
import { renderBranchReviewPage } from '../../publish/branchReviewRender'
import { getOpenMergeRequest } from '../../repositories/branchReviews'
import { userHasCapability } from '../../auth/authz'
import { canReadTable } from './data/access'
import { listDataTables } from '../../repositories/data'
import { MAIN_SCOPE } from '../../branches/scope'
import type { AuthUser } from '../../repositories/users'
import type { MergePlan } from '@core/branches'
import type { DbClient } from '../../db/client'
import type { BranchScope } from '../../branches/scope'
import { forkBranch } from '../../branches/fork'
import { deleteBranch } from '../../branches/deleteBranch'
import { issueBranchPreviewLink, previewEntryPath } from '../../branches/previewLinks'
import { MergeApplyError, MergeConflictsUnresolvedError, applyBranchMerge, planBranchMerge } from '../../branches/merge'
import { runPublishFlush } from '../../publish/publishFlush'
import { expectedOrigin } from '../../auth/security'
import { getActiveBranchPreview, revokeBranchPreviews } from '../../repositories/branchPreviews'
import { requireCapability, requireStepUp } from '../../auth/authz'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { createAuditEvent } from '../../repositories/audit'
import { branchExists, getBranch, listBranches, renameBranch } from '../../repositories/branches'
import { CMS_API_PREFIX, requestAuditContext, type CmsHandlerOptions } from './shared'

const BRANCHES_PATH = `${CMS_API_PREFIX}/branches`
const BRANCH_ITEM_PREFIX = `${BRANCHES_PATH}/`

function normalizeName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ')
  if (name.length === 0 || name.length > BRANCH_NAME_MAX_LENGTH) return null
  return name
}

export async function handleBranchesRoutes(
  req: Request,
  db: DbClient,
  _scope: BranchScope,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname === BRANCHES_PATH) {
    if (req.method === 'GET') return handleList(req, db)
    if (req.method === 'POST') return handleCreate(req, db, options)
    return methodNotAllowed()
  }
  if (!url.pathname.startsWith(BRANCH_ITEM_PREFIX)) return null
  const segments = url.pathname.slice(BRANCH_ITEM_PREFIX.length).split('/').map(decodeURIComponent)
  const branchId = segments[0] ?? ''
  if (branchId.length === 0) return null
  if (segments.length === 1) {
    if (req.method === 'PATCH') return handleRename(req, db, branchId)
    if (req.method === 'DELETE') return handleDelete(req, db, branchId, options)
    return methodNotAllowed()
  }
  if (segments.length === 2 && segments[1] === 'preview') {
    if (req.method === 'GET') return handlePreviewState(req, db, branchId)
    if (req.method === 'POST') return handlePreviewIssue(req, db, branchId)
    if (req.method === 'DELETE') return handlePreviewRevoke(req, db, branchId)
    return methodNotAllowed()
  }
  if (segments[1] === 'review') {
    if (segments.length === 2) {
      if (req.method === 'GET') return handleReviewState(req, db, branchId)
      return methodNotAllowed()
    }
    if (segments.length === 3 && req.method === 'POST') {
      if (segments[2] === 'request') return handleReviewRequest(req, db, branchId)
      if (segments[2] === 'withdraw') return handleReviewWithdraw(req, db, branchId)
      if (segments[2] === 'decline') return handleReviewDecline(req, db, branchId)
      if (segments[2] === 'comments') return handleReviewComment(req, db, branchId)
      return null
    }
    if (segments.length === 3 && segments[2] === 'render') {
      if (req.method === 'GET') return handleReviewRender(req, db, branchId, url)
      return methodNotAllowed()
    }
    return null
  }
  if (segments.length === 2 && (segments[1] === 'merge' || segments[1] === 'update')) {
    const direction: MergeDirection = segments[1]
    if (req.method === 'GET') return handleMergePlan(req, db, branchId, direction)
    if (req.method === 'POST') return handleMergeApply(req, db, branchId, direction, options)
    return methodNotAllowed()
  }
  return null
}

async function handleMergePlan(
  req: Request,
  db: DbClient,
  branchId: string,
  direction: MergeDirection,
): Promise<Response> {
  // Reading the plan is reading content both sides hold; the review page
  // shows it to whoever can read the site. Applying it stays a manager power.
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('Main is the live site; it is what branches merge into')
  if (!(await getBranch(db, branchId))) return branchNotFound(branchId)
  // Live editors hold edits in the relay's debounce window — persist them so
  // the review shows exactly what people see on the canvas.
  await runPublishFlush()
  const { plan } = await planBranchMerge(db, branchId, direction)
  return jsonResponse({ plan: await redactPlanForReader(db, plan, user) })
}

/**
 * Pages, components and layouts ARE the site: whoever may read the site
 * (`site.read`, the canvas viewer) sees them. Every other table follows the
 * data workspace's gate (`canReadTable`: `posts` needs
 * `data.system.tables.read`, custom tables `data.custom.tables.read`). Rows
 * the reader may not open stay in the plan as a stub — the key and kind so
 * counts add up and a manager's resolution still addresses them — with the
 * label and detail withheld.
 */
const SITE_TABLES = new Set(['pages', 'components', 'layouts'])

async function redactPlanForReader(db: DbClient, plan: MergePlan, user: AuthUser): Promise<MergePlan> {
  const gated = plan.changes.filter((change) => change.kind === 'row' && change.tableId !== null && !SITE_TABLES.has(change.tableId))
  if (gated.length === 0) return plan
  const tables = new Map<string, { system: boolean }>()
  for (const scope of [MAIN_SCOPE, { branchId: plan.branchId }]) {
    for (const table of await listDataTables(db, scope)) tables.set(table.id, table)
  }
  return {
    ...plan,
    changes: plan.changes.map((change) => {
      if (change.kind !== 'row' || change.tableId === null || SITE_TABLES.has(change.tableId)) return change
      const table = tables.get(change.tableId)
      if (table && canReadTable(user, table)) return change
      return { ...change, label: 'A row you cannot read', detail: { kind: 'row', fields: [], tree: null } }
    }),
  }
}

async function handleMergeApply(
  req: Request,
  db: DbClient,
  branchId: string,
  direction: MergeDirection,
  options: CmsHandlerOptions,
): Promise<Response> {
  const user = await requireCapability(req, db, 'site.branches.manage')
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('Main is the live site; it is what branches merge into')
  // Merging rewrites main's drafts wholesale; updating rewrites the branch.
  // Both are re-verified like publishing is.
  const stepUp = await requireStepUp(req, db, user)
  if (stepUp) return stepUp
  const branch = await getBranch(db, branchId)
  if (!branch) return branchNotFound(branchId)
  const body = await readValidatedBody(req, ApplyMergeBodySchema)
  if (!body) return badRequest('Invalid merge payload')

  let plan
  try {
    plan = (await applyBranchMerge(db, {
      branchId,
      direction,
      resolutions: body.resolutions ?? {},
      actorUserId: user.id,
    })).plan
  } catch (err) {
    if (err instanceof MergeConflictsUnresolvedError) {
      return jsonResponse({ error: err.message, code: 'merge_conflicts', keys: err.keys }, { status: 409 })
    }
    if (err instanceof MergeApplyError) {
      return jsonResponse({ error: err.message, code: 'merge_apply', key: err.key }, { status: 409 })
    }
    throw err
  }
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: direction === 'merge' ? 'branch.merge' : 'branch.update',
    targetType: 'branch',
    targetId: branchId,
    metadata: { name: branch.name, changes: plan.changes.length, conflicts: plan.conflictCount },
    ...requestAuditContext(req),
  })
  // The open merge request, if any, is what this merge answered.
  if (direction === 'merge') await markMergeRequestMerged(db, branchId, user.id)

  let branchDeleted = false
  if (direction === 'merge' && body.deleteBranch) {
    branchDeleted = await deleteBranch(db, branchId, options.collabRelay ?? null)
    if (branchDeleted) {
      await createAuditEvent(db, {
        actorUserId: user.id,
        action: 'branch.delete',
        targetType: 'branch',
        targetId: branchId,
        metadata: { name: branch.name, afterMerge: true },
        ...requestAuditContext(req),
      })
    }
  }
  return jsonResponse({ plan, branchDeleted })
}

async function handlePreviewState(req: Request, db: DbClient, branchId: string): Promise<Response> {
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('Main is the live site; it has no preview link')
  if (!(await getBranch(db, branchId))) return branchNotFound(branchId)
  return jsonResponse({ preview: await getActiveBranchPreview(db, branchId) })
}

async function handlePreviewIssue(req: Request, db: DbClient, branchId: string): Promise<Response> {
  const user = await requireCapability(req, db, 'site.branches.manage')
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('Main is the live site; it has no preview link')
  if (!(await getBranch(db, branchId))) return branchNotFound(branchId)
  const { token, preview } = await issueBranchPreviewLink(db, { branchId, createdByUserId: user.id })
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'branch.preview.share',
    targetType: 'branch',
    targetId: branchId,
    metadata: { previewId: preview.id },
    ...requestAuditContext(req),
  })
  return jsonResponse({ url: `${expectedOrigin(req)}${previewEntryPath(token)}`, preview }, { status: 201 })
}

async function handlePreviewRevoke(req: Request, db: DbClient, branchId: string): Promise<Response> {
  const user = await requireCapability(req, db, 'site.branches.manage')
  if (user instanceof Response) return user
  if (!(await getBranch(db, branchId))) return branchNotFound(branchId)
  const revoked = await revokeBranchPreviews(db, branchId)
  if (revoked > 0) {
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'branch.preview.revoke',
      targetType: 'branch',
      targetId: branchId,
      metadata: { revoked },
      ...requestAuditContext(req),
    })
  }
  return jsonResponse({ ok: true })
}

// ---------------------------------------------------------------------------
// Merge review
// ---------------------------------------------------------------------------

async function handleReviewState(req: Request, db: DbClient, branchId: string): Promise<Response> {
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('Main is the live site; it is what branches merge into')
  const branch = await getBranch(db, branchId)
  if (!branch) return branchNotFound(branchId)
  return jsonResponse(await readBranchReviewState(db, branch))
}

async function handleReviewRequest(req: Request, db: DbClient, branchId: string): Promise<Response> {
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('Main is the live site; it is what branches merge into')
  const branch = await getBranch(db, branchId)
  if (!branch) return branchNotFound(branchId)
  const body = await readValidatedBody(req, CreateMergeRequestBodySchema)
  if (!body) return badRequest('Invalid merge request payload')
  let request
  try {
    request = await openMergeRequest(db, { branchId, requestedByUserId: user.id, note: body.note })
  } catch (err) {
    if (err instanceof MergeRequestAlreadyOpenError) {
      return jsonResponse({ error: err.message, code: 'merge_request_open' }, { status: 409 })
    }
    throw err
  }
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'branch.review.request',
    targetType: 'branch',
    targetId: branchId,
    metadata: { name: branch.name, requestId: request.id },
    ...requestAuditContext(req),
  })
  return jsonResponse({ request }, { status: 201 })
}

async function handleReviewWithdraw(req: Request, db: DbClient, branchId: string): Promise<Response> {
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('Main is the live site; it is what branches merge into')
  const branch = await getBranch(db, branchId)
  if (!branch) return branchNotFound(branchId)
  const open = await getOpenMergeRequest(db, branchId)
  if (!open) return jsonResponse({ error: 'This branch has no open merge request' }, { status: 409 })
  // The requester takes their own request back; a branch manager can too.
  if (open.requestedBy?.id !== user.id && !userHasCapability(user, 'site.branches.manage')) {
    return jsonResponse({ error: 'Only the requester or a branch manager can withdraw this request' }, { status: 403 })
  }
  let request
  try {
    request = await closeMergeRequest(db, branchId, { status: 'withdrawn', resolvedByUserId: user.id, note: '' })
  } catch (err) {
    if (err instanceof NoOpenMergeRequestError) return jsonResponse({ error: err.message }, { status: 409 })
    throw err
  }
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'branch.review.withdraw',
    targetType: 'branch',
    targetId: branchId,
    metadata: { name: branch.name, requestId: request.id },
    ...requestAuditContext(req),
  })
  return jsonResponse({ request })
}

async function handleReviewDecline(req: Request, db: DbClient, branchId: string): Promise<Response> {
  const user = await requireCapability(req, db, 'site.branches.manage')
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('Main is the live site; it is what branches merge into')
  const branch = await getBranch(db, branchId)
  if (!branch) return branchNotFound(branchId)
  const body = await readValidatedBody(req, DeclineMergeRequestBodySchema)
  if (!body || body.note.trim().length === 0) return badRequest('A decline needs a note the requester can act on')
  let request
  try {
    request = await closeMergeRequest(db, branchId, { status: 'declined', resolvedByUserId: user.id, note: body.note })
  } catch (err) {
    if (err instanceof NoOpenMergeRequestError) return jsonResponse({ error: err.message }, { status: 409 })
    throw err
  }
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'branch.review.decline',
    targetType: 'branch',
    targetId: branchId,
    metadata: { name: branch.name, requestId: request.id },
    ...requestAuditContext(req),
  })
  return jsonResponse({ request })
}

async function handleReviewComment(req: Request, db: DbClient, branchId: string): Promise<Response> {
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('Main is the live site; it is what branches merge into')
  const branch = await getBranch(db, branchId)
  if (!branch) return branchNotFound(branchId)
  const body = await readValidatedBody(req, CreateReviewCommentBodySchema)
  if (!body || body.body.trim().length === 0) return badRequest('A comment needs some text')
  const comment = await addReviewComment(db, {
    branchId,
    authorUserId: user.id,
    entityKey: body.entityKey,
    body: body.body,
  })
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'branch.review.comment',
    targetType: 'branch',
    targetId: branchId,
    metadata: { name: branch.name, commentId: comment.id, entityKey: comment.entityKey },
    ...requestAuditContext(req),
  })
  return jsonResponse({ comment }, { status: 201 })
}

async function handleReviewRender(req: Request, db: DbClient, branchId: string, url: URL): Promise<Response> {
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('Main is the live site; it is what branches merge into')
  if (!(await getBranch(db, branchId))) return branchNotFound(branchId)
  const rowId = url.searchParams.get('row')?.trim() ?? ''
  const side = url.searchParams.get('side')
  if (!rowId || (side !== 'main' && side !== 'branch')) {
    return badRequest('Pass ?row=<page row id>&side=main|branch')
  }
  // Pages are the site: `site.read` (the canvas viewer) is the whole gate.
  const html = await renderBranchReviewPage(db, branchId, side, rowId)
  if (html === null) return jsonResponse({ error: `No page "${rowId}" on ${side}` }, { status: 404 })
  // Served as text and sandboxed: the review reads it and hands it to a
  // scriptless srcdoc frame; navigated to directly it is never a page that
  // runs with the admin session.
  return new Response(html, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'content-security-policy': 'sandbox',
      'x-content-type-options': 'nosniff',
    },
  })
}

function branchNotFound(branchId: string): Response {
  return jsonResponse({ error: `Branch "${branchId}" does not exist` }, { status: 404 })
}

async function handleList(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  return jsonResponse({ branches: await listBranches(db) })
}

async function handleCreate(req: Request, db: DbClient, options: CmsHandlerOptions): Promise<Response> {
  const user = await requireCapability(req, db, 'site.branches.manage')
  if (user instanceof Response) return user
  const body = await readValidatedBody(req, CreateBranchBodySchema)
  if (!body) return badRequest('Invalid branch payload')

  const name = normalizeName(body.name)
  if (!name) return badRequest(`Branch names are 1 to ${BRANCH_NAME_MAX_LENGTH} characters`)
  const id = body.id?.trim() || slugifyBranchName(name)
  if (!isValidBranchId(id)) {
    return badRequest('Branch ids use lowercase letters, digits, dots, and dashes')
  }
  if (isMainBranch(id)) return badRequest('"main" is the live site and cannot be recreated')
  if (await branchExists(db, id)) {
    return jsonResponse({ error: `A branch with the id "${id}" already exists` }, { status: 409 })
  }
  const fromBranchId = body.fromBranchId?.trim() || 'main'
  if (!isValidBranchId(fromBranchId) || !(await branchExists(db, fromBranchId))) {
    return jsonResponse({ error: `Branch "${fromBranchId}" does not exist` }, { status: 404 })
  }

  const branch = await forkBranch(db, { id, name, fromBranchId, createdByUserId: user.id })
  await options.collabRelay?.rememberBranch(branch.id)
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'branch.create',
    targetType: 'branch',
    targetId: branch.id,
    metadata: { name: branch.name, fromBranchId },
    ...requestAuditContext(req),
  })
  return jsonResponse({ branch }, { status: 201 })
}

async function handleRename(req: Request, db: DbClient, branchId: string): Promise<Response> {
  const user = await requireCapability(req, db, 'site.branches.manage')
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('The main branch cannot be renamed')
  const body = await readValidatedBody(req, RenameBranchBodySchema)
  if (!body) return badRequest('Invalid branch payload')
  const name = normalizeName(body.name)
  if (!name) return badRequest(`Branch names are 1 to ${BRANCH_NAME_MAX_LENGTH} characters`)

  const previous = await getBranch(db, branchId)
  if (!previous) return jsonResponse({ error: `Branch "${branchId}" does not exist` }, { status: 404 })
  const branch = await renameBranch(db, branchId, name)
  if (!branch) return jsonResponse({ error: `Branch "${branchId}" does not exist` }, { status: 404 })
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'branch.rename',
    targetType: 'branch',
    targetId: branch.id,
    metadata: { from: previous.name, to: branch.name },
    ...requestAuditContext(req),
  })
  return jsonResponse({ branch })
}

async function handleDelete(
  req: Request,
  db: DbClient,
  branchId: string,
  options: CmsHandlerOptions,
): Promise<Response> {
  const user = await requireCapability(req, db, 'site.branches.manage')
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('The main branch cannot be deleted')
  // Deleting a branch discards every unmerged change on it — re-verify the
  // actor the same way user deletion does.
  const stepUp = await requireStepUp(req, db, user)
  if (stepUp) return stepUp

  const branch = await getBranch(db, branchId)
  if (!branch) return jsonResponse({ error: `Branch "${branchId}" does not exist` }, { status: 404 })
  const deleted = await deleteBranch(db, branchId, options.collabRelay ?? null)
  if (!deleted) return jsonResponse({ error: `Branch "${branchId}" does not exist` }, { status: 404 })
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'branch.delete',
    targetType: 'branch',
    targetId: branchId,
    metadata: { name: branch.name },
    ...requestAuditContext(req),
  })
  return jsonResponse({ ok: true })
}
