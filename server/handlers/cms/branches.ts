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
 *   GET    /admin/api/cms/branches/:id/merge     plan merging into main     (site.branches.manage)
 *   POST   /admin/api/cms/branches/:id/merge     merge into main            (site.branches.manage + step-up)
 *   GET    /admin/api/cms/branches/:id/update    plan updating from main    (site.branches.manage)
 *   POST   /admin/api/cms/branches/:id/update    update from main           (site.branches.manage)
 *
 * Main is fixed: it cannot be renamed or deleted. Every mutation lands in
 * the audit log.
 */
import {
  ApplyMergeBodySchema,
  BRANCH_NAME_MAX_LENGTH,
  CreateBranchBodySchema,
  RenameBranchBodySchema,
  isMainBranch,
  isValidBranchId,
  slugifyBranchName,
  type MergeDirection,
} from '@core/branches'
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
  const user = await requireCapability(req, db, 'site.branches.manage')
  if (user instanceof Response) return user
  if (isMainBranch(branchId)) return badRequest('Main is the live site; it is what branches merge into')
  if (!(await getBranch(db, branchId))) return branchNotFound(branchId)
  // Live editors hold edits in the relay's debounce window — persist them so
  // the review shows exactly what people see on the canvas.
  await runPublishFlush()
  const { plan } = await planBranchMerge(db, branchId, direction)
  return jsonResponse({ plan })
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
