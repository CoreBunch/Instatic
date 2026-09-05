/**
 * Who may act on a branch — the one rule the server gates and the admin UI
 * mirrors, so a control is never offered and then refused.
 *
 * Two capabilities, two reaches:
 *
 *   site.branches.create — fork a branch, and act on the branches you forked:
 *                          rename, delete, update from main, share or revoke
 *                          a preview link.
 *   site.branches.manage — act on every branch, plus the two gatekeeper acts
 *                          that touch the live site: merge into main and
 *                          decline a merge request. It does not fork.
 *
 * Forking is additive and private; merging rewrites main's drafts. Keeping
 * those on separate capabilities is what lets a contributor fork and ask for
 * review without being able to land anything.
 */
import type { SiteBranch } from './schemas'

/** The slice of a signed-in user the rule needs. */
export interface BranchActor {
  id: string
  capabilities: readonly string[]
}

/**
 * Rename, delete, update from main, share or revoke a preview link. A
 * signed-out actor (`null`, as the admin session reads before it loads) may
 * act on nothing.
 */
export function canActOnBranch(
  actor: BranchActor | null,
  branch: Pick<SiteBranch, 'createdByUserId'>,
): boolean {
  if (!actor) return false
  if (actor.capabilities.includes('site.branches.manage')) return true
  return (
    actor.capabilities.includes('site.branches.create') &&
    branch.createdByUserId !== null &&
    branch.createdByUserId === actor.id
  )
}

/** Merge into main or decline a merge request: managers only. */
export function canMergeBranches(actor: Pick<BranchActor, 'capabilities'> | null): boolean {
  return actor !== null && actor.capabilities.includes('site.branches.manage')
}
