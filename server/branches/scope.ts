/**
 * Branch scope — which branch a piece of server work reads and writes.
 *
 * Every repository call on the branched tables (`site`, `data_tables`,
 * `data_rows`) takes a `BranchScope` explicitly. CMS requests resolve theirs
 * once, from the `X-Instatic-Branch` header, in the dispatcher; paths that
 * are only ever meaningful for the live site (publishing, scheduling, public
 * routes, forms, plugins, the dashboard, MCP headless reads) pass
 * `MAIN_SCOPE`.
 */
import { MAIN_BRANCH_ID, isValidBranchId } from '@core/branches'
import type { DbClient } from '../db/client'
import { jsonResponse } from '../http'
import { branchExists } from '../repositories/branches'

export interface BranchScope {
  readonly branchId: string
}

export const MAIN_SCOPE: BranchScope = Object.freeze({ branchId: MAIN_BRANCH_ID })

export const BRANCH_HEADER = 'x-instatic-branch'

/** Error code the client keys on to fall back to main. */
export const BRANCH_NOT_FOUND_CODE = 'branch_not_found'

export function isMainScope(scope: BranchScope): boolean {
  return scope.branchId === MAIN_BRANCH_ID
}

/**
 * Resolve the request's branch. A missing or `main` header is the main
 * branch without touching the database; anything else must be a well-formed
 * id naming an existing branch, otherwise the caller gets a 400 or a 404
 * carrying `BRANCH_NOT_FOUND_CODE`.
 */
export async function resolveBranchScope(
  req: Request,
  db: DbClient,
): Promise<BranchScope | Response> {
  return resolveBranchScopeById(db, req.headers.get(BRANCH_HEADER)?.trim() ?? '')
}

/**
 * `resolveBranchScope` for a branch id that arrived outside the header — the
 * export download is a form POST, which cannot carry one, so it names the
 * branch in its body.
 */
export async function resolveBranchScopeById(
  db: DbClient,
  raw: string,
): Promise<BranchScope | Response> {
  if (raw === '' || raw === MAIN_BRANCH_ID) return MAIN_SCOPE
  if (!isValidBranchId(raw)) {
    return jsonResponse({ error: 'Invalid branch id' }, { status: 400 })
  }
  if (!(await branchExists(db, raw))) {
    return jsonResponse(
      { error: `Branch "${raw}" does not exist`, code: BRANCH_NOT_FOUND_CODE },
      { status: 404 },
    )
  }
  return { branchId: raw }
}
