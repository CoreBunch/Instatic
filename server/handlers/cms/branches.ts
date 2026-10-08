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
 *   POST   /admin/api/cms/branches/:id/merge/undo   reverse the latest merge   (same gates as the merge)
 *   POST   /admin/api/cms/branches/:id/update/undo  reverse the latest update  (same gates as the update)
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
  canActOnBranch,
  canMergeBranches,
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
import { getOpenMergeRequest, reopenMergedRequest } from '../../repositories/branchReviews'
import { requireAuthenticatedUser, userHasCapability } from '../../auth/authz'
import { canReadDataRow, canReadTable } from '../../auth/dataAccess'
import { getDataRow, listDataTables, readDataLocalization } from '../../repositories/data'
import { readDisplayTitle } from '@core/data/cells'
import { hasLocalizedDataFields, LocalizedDataReferenceAccessError } from '@core/data/localizedCells'
import { LocalizationError } from '@core/localization'
import type { DataLocalization, DataRow, DataTable } from '@core/data/schemas'
import type { BranchScope } from '../../branches/scope'
import { MAIN_SCOPE } from '../../branches/scope'
import type { AuthUser } from '../../repositories/users'
import type { MergePlan } from '@core/branches'
import type { DbClient } from '../../db/client'
import { forkBranch } from '../../branches/fork'
import { deleteBranch } from '../../branches/deleteBranch'
import { issueBranchPreviewLink, previewEntryPath } from '../../branches/previewLinks'
import { MergeApplyError, MergeConflictsUnresolvedError, MergeUndoError,
  applyBranchMerge, planBranchMerge,
  undoBranchMerge,
} from '../../branches/merge'
import { runPublishFlush } from '../../publish/publishFlush'
import { expectedOrigin } from '../../auth/security'
import { getActiveBranchPreview, revokeBranchPreviews } from '../../repositories/branchPreviews'
import { requireCapability, requireStepUp } from '../../auth/authz'
import { badRequest, forbidden, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
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
  if (segments[1] === 'merge' || segments[1] === 'update') {
    const direction: MergeDirection = segments[1]
    if (segments.length === 2) {
      if (req.method === 'GET') return handleMergePlan(req, db, branchId, direction)
      if (req.method === 'POST') return handleMergeApply(req, db, branchId, direction, options)
      return methodNotAllowed()
    }
    if (segments.length === 3 && segments[2] === 'undo') {
      if (req.method === 'POST') return handleMergeUndo(req, db, branchId, direction)
      return methodNotAllowed()
    }
    return null
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
  const language = new URL(req.url).searchParams.get('language') ?? undefined
  try {
    return jsonResponse({ plan: await projectPlanForReader(db, plan, user, language) })
  } catch (error) {
    if (error instanceof LocalizationError) return jsonResponse({ error: error.message }, { status: 422 })
    throw error
  }
}

/**
 * Pages, components and layouts ARE the site: whoever may read the site
 * (`site.read`, the canvas viewer) sees them. Every other table follows the
 * data workspace's gate (`canReadTable`: `posts` needs
 * `data.system.tables.read`, custom tables `data.custom.tables.read`). Rows
 * the reader may not open stay in the plan as a stub — the key and kind so
 * counts add up and a manager's resolution still addresses them — with the
 * label and detail withheld. Both sides obey the own/any-row policy before
 * a field comparison is exposed. Localized rows require a chosen language;
 * structural collection, hashing, apply and undo keep authored references.
 */
const SITE_TABLES = new Set(['pages', 'components', 'layouts'])

async function projectPlanForReader(db: DbClient, plan: MergePlan, user: AuthUser, language?: string): Promise<MergePlan> {
  const scopes: BranchScope[] = [MAIN_SCOPE, { branchId: plan.branchId }]
  const tables = new Map<string, Map<string, DataTable>>()
  for (const scope of scopes) tables.set(scope.branchId, new Map((await listDataTables(db, scope)).map(table => [table.id, table])))
  const localizationByScope = new Map<string, Promise<DataLocalization>>()
  const languages = new Set<string>()
  let localized = false
  let canBrowseCatalogue = false
  let resolvedLanguage: string | undefined
  const changes: MergePlan['changes'] = []
  for (const change of plan.changes) {
    if (change.kind !== 'row' || change.tableId === null) { changes.push(change); continue }
    const scope = { branchId: change.action === 'delete' ? plan.into : plan.from }
    const table = tables.get(scope.branchId)?.get(change.tableId)
    const rows = new Map<string, DataRow>()
    let canRead = true
    for (const side of scopes) {
      const sideTable = tables.get(side.branchId)?.get(change.tableId)
      if (!sideTable) continue
      if (!SITE_TABLES.has(sideTable.id) && !canReadTable(user, sideTable)) { canRead = false; break }
      const sideRow = await getDataRow(db, side, change.logicalId)
      if (!sideRow) continue
      if (!SITE_TABLES.has(sideTable.id) && !canReadDataRow(user, sideRow)) { canRead = false; break }
      rows.set(side.branchId, sideRow)
    }
    const row = rows.get(scope.branchId)
    if (!canRead || !table || !row) {
      changes.push({ ...change, label: 'A row you cannot read', detail: { kind: 'row', fields: [], tree: null } })
      continue
    }
    if (!hasLocalizedDataFields(table.fields)) { changes.push(change); continue }
    localized = true
    let pending = localizationByScope.get(scope.branchId)
    if (!pending) {
      pending = readDataLocalization(db, scope, user, [...tables.get(scope.branchId)!.values()], language)
      localizationByScope.set(scope.branchId, pending)
    }
    const localization = await pending
    canBrowseCatalogue = localization.canBrowseCatalogue
    for (const available of localization.languages) languages.add(available)
    if (!localization.language || !localization.translations) {
      changes.push({ ...change, label: null, detail: { kind: 'row', fields: [], tree: null } })
      continue
    }
    resolvedLanguage = localization.language
    changes.push({ ...change, label: readDisplayTitle(row.cells, table, { language: localization.language, translations: localization.translations }) })
  }
  const metadata = { languages: [...languages], canBrowseCatalogue }
  const localization = resolvedLanguage ? { ...metadata, language: resolvedLanguage } : metadata
  return {
    ...plan,
    changes,
    ...(localized ? { localization } : {}),
  }
}

async function handleMergeApply(
  req: Request,
  db: DbClient,
  branchId: string,
  direction: MergeDirection,
  options: CmsHandlerOptions,
): Promise<Response> {
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('Main is the live site; it is what branches merge into')
  const branch = await getBranch(db, branchId)
  if (!branch) return branchNotFound(branchId)
  // Merging rewrites main's drafts wholesale and is a manager's call alone.
  // Updating rewrites only the branch, so its creator may do it too.
  const allowed = direction === 'merge' ? canMergeBranches(user) : canActOnBranch(user, branch)
  if (!allowed) return forbidden()
  // Both are re-verified like publishing is.
  const stepUp = await requireStepUp(req, db, user)
  if (stepUp) return stepUp
  const body = await readValidatedBody(req, ApplyMergeBodySchema)
  if (!body) return badRequest('Invalid merge payload')

  let applied
  try {
    applied = await applyBranchMerge(db, {
      branchId,
      direction,
      resolutions: body.resolutions ?? {},
      actorUserId: user.id,
    })
  } catch (err) {
    if (err instanceof LocalizedDataReferenceAccessError) return jsonResponse({ error: err.message }, { status: 403 })
    if (err instanceof LocalizationError) return jsonResponse({ error: err.message }, { status: 422 })
    if (err instanceof MergeConflictsUnresolvedError) {
      return jsonResponse({ error: err.message, code: 'merge_conflicts', keys: err.keys }, { status: 409 })
    }
    if (err instanceof MergeApplyError) {
      return jsonResponse({ error: err.message, code: 'merge_apply', key: err.key }, { status: 409 })
    }
    throw err
  }
  const { plan, merge } = applied
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
  return jsonResponse({ plan, branchDeleted, merge: branchDeleted ? null : merge })
}

async function handlePreviewState(req: Request, db: DbClient, branchId: string): Promise<Response> {
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('Main is the live site; it has no preview link')
  if (!(await getBranch(db, branchId))) return branchNotFound(branchId)
  return jsonResponse({ preview: await getActiveBranchPreview(db, branchId) })
}

async function handlePreviewIssue(req: Request, db: DbClient, branchId: string): Promise<Response> {
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('Main is the live site; it has no preview link')
  const branch = await getBranch(db, branchId)
  if (!branch) return branchNotFound(branchId)
  if (!canActOnBranch(user, branch)) return forbidden()
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
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  const branch = await getBranch(db, branchId)
  if (!branch) return branchNotFound(branchId)
  if (!canActOnBranch(user, branch)) return forbidden()
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
  // Forking is additive and private, so it is its own capability; managing
  // alone does not fork.
  const user = await requireCapability(req, db, 'site.branches.create')
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
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('The main branch cannot be renamed')
  const previous = await getBranch(db, branchId)
  if (!previous) return jsonResponse({ error: `Branch "${branchId}" does not exist` }, { status: 404 })
  if (!canActOnBranch(user, previous)) return forbidden()
  const body = await readValidatedBody(req, RenameBranchBodySchema)
  if (!body) return badRequest('Invalid branch payload')
  const name = normalizeName(body.name)
  if (!name) return badRequest(`Branch names are 1 to ${BRANCH_NAME_MAX_LENGTH} characters`)

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
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('The main branch cannot be deleted')
  const branch = await getBranch(db, branchId)
  if (!branch) return jsonResponse({ error: `Branch "${branchId}" does not exist` }, { status: 404 })
  // Settle who may act before asking anyone to re-authenticate.
  if (!canActOnBranch(user, branch)) return forbidden()
  // Deleting a branch discards every unmerged change on it — re-verify the
  // actor the same way user deletion does.
  const stepUp = await requireStepUp(req, db, user)
  if (stepUp) return stepUp

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

async function handleMergeUndo(
  req: Request,
  db: DbClient,
  branchId: string,
  direction: MergeDirection,
): Promise<Response> {
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('Main is the live site; it is what branches merge into')
  const branch = await getBranch(db, branchId)
  if (!branch) return branchNotFound(branchId)
  // Undoing rewrites exactly what the apply rewrote: same gates, same step-up.
  const allowed = direction === 'merge' ? canMergeBranches(user) : canActOnBranch(user, branch)
  if (!allowed) return forbidden()
  const stepUp = await requireStepUp(req, db, user)
  if (stepUp) return stepUp

  let result
  try {
    result = await undoBranchMerge(db, { branchId, direction, actorUserId: user.id })
  } catch (err) {
    if (err instanceof LocalizedDataReferenceAccessError) return jsonResponse({ error: err.message }, { status: 403 })
    if (err instanceof LocalizationError) return jsonResponse({ error: err.message }, { status: 422 })
    if (err instanceof MergeUndoError) {
      return jsonResponse({ error: err.message, code: 'merge_undo' }, { status: 409 })
    }
    if (err instanceof MergeApplyError) {
      return jsonResponse({ error: err.message, code: 'merge_apply', key: err.key }, { status: 409 })
    }
    throw err
  }
  if (direction === 'merge') await reopenMergedRequest(db, branchId)
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: direction === 'merge' ? 'branch.merge.undo' : 'branch.update.undo',
    targetType: 'branch',
    targetId: branchId,
    metadata: { name: branch.name, restored: result.restoredCount, mergeId: result.merge.id },
    ...requestAuditContext(req),
  })
  return jsonResponse({ merge: result.merge, restoredCount: result.restoredCount })
}
