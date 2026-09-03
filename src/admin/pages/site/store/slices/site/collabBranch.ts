/**
 * The branch the editor's doc world addresses.
 *
 * Every collab doc id the binding mints carries a branch (see `@core/collab`
 * docIds), so a site loaded from one branch can never bind to another
 * branch's documents. The editor runtime sets the branch before the site
 * loads; detached-mode tests run on main.
 */
import { MAIN_BRANCH_ID } from '@core/branches'
import { encodeCollabDocId, siteDocId } from '@core/collab'
import type { SiteDocument } from '@core/page-tree'

let activeBranchId: string = MAIN_BRANCH_ID

export function setCollabBranchId(branchId: string): void {
  activeBranchId = branchId
}

export function collabBranchId(): string {
  return activeBranchId
}

/**
 * Installed by the editor runtime: called when the server reports a doc's
 * branch as gone (deleted while this tab was on it) so the tab leaves the
 * branch instead of rebinding.
 */
let branchGoneHandler: ((branchId: string) => void) | null = null

export function setCollabBranchGoneHandler(handler: ((branchId: string) => void) | null): void {
  branchGoneHandler = handler
}

export function notifyCollabBranchGone(branchId: string): void {
  branchGoneHandler?.(branchId)
}

/** Every doc id a site document binds on the active branch, shell first. */
export function allDocIdsForSite(site: SiteDocument): string[] {
  const branchId = activeBranchId
  return [
    siteDocId(branchId),
    ...site.pages.map((p) => encodeCollabDocId({ kind: 'page', branchId, rowId: p.id })),
    ...site.visualComponents.map((vc) => encodeCollabDocId({ kind: 'component', branchId, rowId: vc.id })),
    ...site.layouts.map((l) => encodeCollabDocId({ kind: 'layout', branchId, rowId: l.id })),
  ]
}
