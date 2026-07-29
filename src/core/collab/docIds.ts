/**
 * Collab document addressing — one Yjs document per logical row/shell.
 *
 * The doc id is the unit the whole collaboration stack speaks: the client
 * provider binds by doc id, the server relay registers and persists by doc
 * id, the wire protocol prefixes every frame with it, and the
 * `collab_documents` table keys on it.
 */

export type CollabDocKind = 'site' | 'page' | 'component' | 'layout'

export interface CollabDocId {
  kind: CollabDocKind
  /** The backing row id; the shell uses the fixed site row id `default`. */
  rowId: string
}

export const SITE_DOC_ID = 'site:default'

export function encodeCollabDocId(id: CollabDocId): string {
  return `${id.kind}:${id.rowId}`
}

const KINDS: readonly CollabDocKind[] = ['site', 'page', 'component', 'layout']

export function parseCollabDocId(raw: string): CollabDocId | null {
  const sep = raw.indexOf(':')
  if (sep <= 0) return null
  const kind = raw.slice(0, sep)
  const rowId = raw.slice(sep + 1)
  if (!rowId || !KINDS.includes(kind as CollabDocKind)) return null
  return { kind: kind as CollabDocKind, rowId }
}
