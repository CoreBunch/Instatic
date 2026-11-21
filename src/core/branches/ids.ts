/**
 * Branch identity — the id scheme every branch-aware layer agrees on.
 *
 * A site branch is a full copy of the site's content (shell, tables, rows)
 * that shares the same LOGICAL ids as `main`. Logical ids are what every
 * reference inside stored JSON points at (component refs, relation cells,
 * loop table ids), what the HTTP API exchanges, and what the editor holds
 * in its store. They never change when a branch is forked or merged.
 *
 * Storage keeps one row per (branch, logical id). The row's PHYSICAL primary
 * key is derived, never chosen: on `main` it equals the logical id, so every
 * pre-branch row keeps its key and every foreign key that points at a main
 * row (versions, redirects, usage refs) stays valid; on any other branch it
 * is the branch id and the logical id joined by `:`. Branch ids therefore
 * cannot contain `:` — see `BRANCH_ID_PATTERN`.
 */

export const MAIN_BRANCH_ID = 'main'

/** Logical id of the one site shell row every branch carries. */
export const SITE_SHELL_LOGICAL_ID = 'default'

/** Lowercase slug: letters, digits, dashes, dots; 1–64 chars; never `:`. */
export const BRANCH_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/

export const BRANCH_NAME_MAX_LENGTH = 80

export function isValidBranchId(value: string): boolean {
  return BRANCH_ID_PATTERN.test(value)
}

export function isMainBranch(branchId: string): boolean {
  return branchId === MAIN_BRANCH_ID
}

/**
 * Derive a branch id from a human name: lowercase, dashes for runs of
 * anything that is not a letter, digit, or dot, trimmed and clamped to the
 * pattern's length. Returns `''` when nothing usable remains.
 */
export function slugifyBranchName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
    .replace(/[-.]+$/g, '')
}

/**
 * The physical primary key of a logical id on a branch. Identity on `main`,
 * `<branch>:<logical>` elsewhere. Pure and total — callers never need to
 * consult storage to address a row.
 */
export function physicalId(branchId: string, logicalId: string): string {
  return branchId === MAIN_BRANCH_ID ? logicalId : `${branchId}:${logicalId}`
}

/**
 * Inverse of `physicalId` for the given branch. A physical id that does not
 * carry the branch's prefix is returned unchanged — that only happens for
 * main, where the two coincide.
 */
export function logicalIdOf(branchId: string, physical: string): string {
  if (branchId === MAIN_BRANCH_ID) return physical
  const prefix = `${branchId}:`
  return physical.startsWith(prefix) ? physical.slice(prefix.length) : physical
}
