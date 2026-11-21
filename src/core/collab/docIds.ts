/**
 * Collab document addressing — one Yjs document per logical row/shell PER
 * BRANCH.
 *
 * The doc id is the unit the whole collaboration stack speaks: the client
 * provider binds by doc id, the server relay registers and persists by doc
 * id, the wire protocol prefixes every frame with it, and the
 * `collab_documents` table keys on it.
 *
 * Shape: `<kind>:<branchId>:<logicalRowId>` for rows, `site:<branchId>` for
 * the shell. Branch ids never contain `:` (see `@core/branches`), so the
 * first two segments are unambiguous; the row id may contain anything.
 */
import { MAIN_BRANCH_ID, isValidBranchId } from '@core/branches'

export type CollabDocKind = 'site' | 'page' | 'component' | 'layout'

export type CollabDocId =
  | { kind: 'site'; branchId: string }
  | { kind: Exclude<CollabDocKind, 'site'>; branchId: string; rowId: string }

const ROW_KINDS: readonly Exclude<CollabDocKind, 'site'>[] = ['page', 'component', 'layout']

/** The shell doc id of a branch. */
export function siteDocId(branchId: string): string {
  return `site:${branchId}`
}

/** The main branch's shell doc id — the only doc every install has. */
export const MAIN_SITE_DOC_ID = siteDocId(MAIN_BRANCH_ID)

export function encodeCollabDocId(id: CollabDocId): string {
  if (id.kind === 'site') return siteDocId(id.branchId)
  return `${id.kind}:${id.branchId}:${id.rowId}`
}

export function parseCollabDocId(raw: string): CollabDocId | null {
  const first = raw.indexOf(':')
  if (first <= 0) return null
  const kind = raw.slice(0, first)
  const rest = raw.slice(first + 1)
  if (kind === 'site') {
    return rest && isValidBranchId(rest) ? { kind: 'site', branchId: rest } : null
  }
  if (!ROW_KINDS.includes(kind as Exclude<CollabDocKind, 'site'>)) return null
  const second = rest.indexOf(':')
  if (second <= 0) return null
  const branchId = rest.slice(0, second)
  const rowId = rest.slice(second + 1)
  if (!rowId || !isValidBranchId(branchId)) return null
  return { kind: kind as Exclude<CollabDocKind, 'site'>, branchId, rowId }
}

/** True when `docId` is the shell doc of any branch. */
export function isSiteDocId(docId: string): boolean {
  return parseCollabDocId(docId)?.kind === 'site'
}
